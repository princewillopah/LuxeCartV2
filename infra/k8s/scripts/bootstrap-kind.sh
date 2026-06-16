#!/usr/bin/env bash
# bootstrap-kind.sh — one-command bring-up of the LuxeCart dev cluster
#
# Idempotent: re-running it just upgrades whatever's already there.
#
# What it installs (in order):
#   1. kind cluster `luxecart-dev` (3 nodes, k8s v1.30) from docs/kind-cluster.yaml
#   2. Calico CNI (so NetworkPolicy actually enforces — kindnet does NOT)
#   3. metrics-server (so HPA works)
#   4. ingress-nginx (with the kind tweaks)
#   5. cert-manager (for self-signed TLS in dev)
#   6. kube-prometheus-stack + Loki + promtail (observability tier)
#   7. (later) base/ manifests via kustomize — gated on K1 manifests existing
#
# Prereqs: docker, kubectl, kind, helm. See infra/k8s/README.md "Tool versions".

set -euo pipefail

CLUSTER_NAME="luxecart-dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

green()  { printf "\033[32m== %s ==\033[0m\n" "$*"; }
yellow() { printf "\033[33m-- %s --\033[0m\n" "$*"; }
red()    { printf "\033[31m!! %s !!\033[0m\n" "$*"; }

# ── 1. kind cluster ──────────────────────────────────────────────────────────
green "1/7 kind cluster"
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER_NAME}"; then
  yellow "cluster '${CLUSTER_NAME}' already exists — skipping create"
else
  kind create cluster --config "${K8S_DIR}/docs/kind-cluster.yaml"
fi
kubectl cluster-info --context "kind-${CLUSTER_NAME}"

# ── 2. Calico CNI (replaces kindnet's no-op NetworkPolicy implementation) ────
green "2/7 Calico CNI for NetworkPolicy enforcement"
# We use the Tigera operator install so upgrades are smooth.
if ! kubectl get ns tigera-operator >/dev/null 2>&1; then
  kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/tigera-operator.yaml
  # Install Calico with the right pod CIDR (must match kind-cluster.yaml).
  cat <<'YAML' | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
      - blockSize: 26
        cidr: 10.244.0.0/16
        encapsulation: VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
---
apiVersion: operator.tigera.io/v1
kind: APIServer
metadata:
  name: default
spec: {}
YAML
  yellow "waiting for Calico to be Ready..."
  kubectl wait --for=condition=Available --timeout=300s -n calico-system deployment --all || true
else
  yellow "Calico already installed — skipping"
fi

# ── 3. metrics-server (for HPA) ──────────────────────────────────────────────
green "3/7 metrics-server"
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install metrics-server metrics-server/metrics-server \
  --namespace kube-system \
  --set 'args={--kubelet-insecure-tls}' \
  --wait --timeout 5m

# ── 4. ingress-nginx ─────────────────────────────────────────────────────────
green "4/7 ingress-nginx"
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress --create-namespace \
  --set controller.hostNetwork=false \
  --set controller.hostPort.enabled=true \
  --set controller.nodeSelector."ingress-ready"=true \
  --set-string controller.tolerations[0].key=node-role.kubernetes.io/control-plane \
  --set-string controller.tolerations[0].operator=Exists \
  --set-string controller.tolerations[0].effect=NoSchedule \
  --set controller.publishService.enabled=false \
  --set controller.service.type=ClusterIP \
  --wait --timeout 5m

# ── 5. cert-manager (self-signed in dev) ─────────────────────────────────────
green "5/7 cert-manager"
helm repo add jetstack https://charts.jetstack.io >/dev/null 2>&1 || true
helm repo update >/dev/null
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set installCRDs=true \
  --wait --timeout 5m

# Self-signed ClusterIssuer for local dev — same Certificate CRD as EKS will use.
cat <<'YAML' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-cluster-issuer
spec:
  selfSigned: {}
YAML

# ── 6. observability tier (prom + grafana + loki) ────────────────────────────
green "6/7 kube-prometheus-stack + Loki"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update >/dev/null

# kube-prometheus-stack bundles prom + alertmanager + grafana + node-exporter +
# kube-state-metrics + Prometheus Operator (which gives us ServiceMonitor + PrometheusRule CRDs).
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace observability --create-namespace \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=30090 \
  --set grafana.adminPassword='admin' \
  --set 'grafana.sidecar.dashboards.enabled=true' \
  --set 'grafana.sidecar.dashboards.searchNamespace=ALL' \
  --set 'grafana.sidecar.datasources.enabled=true' \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.ruleSelectorNilUsesHelmValues=false \
  --wait --timeout 10m

# Loki + promtail for log aggregation. Single-binary deploy is fine for dev.
helm upgrade --install loki grafana/loki-stack \
  --namespace observability \
  --set loki.persistence.enabled=false \
  --set promtail.enabled=true \
  --wait --timeout 10m

# ── 7. base/ manifests (gated until K1 manifests exist) ──────────────────────
green "7/7 base/ manifests"
if [[ -f "${K8S_DIR}/overlays/kind/kustomization.yaml" ]]; then
  kustomize build "${K8S_DIR}/overlays/kind" | kubectl apply -f -
  yellow "applied overlays/kind"
else
  yellow "overlays/kind/kustomization.yaml not found yet — skipping app deploy"
  yellow "(this is expected at K0/K1-bootstrap stage)"
fi

green "DONE"
cat <<EOF

╭─────────────────────────────────────────────────────────────────╮
│  cluster:  ${CLUSTER_NAME}
│  ingress:  http://localhost:18080  https://localhost:18443
│  grafana:  http://localhost:18090   (admin / admin)
│  prometheus port-forward:
│    kubectl port-forward -n observability svc/kube-prometheus-stack-prometheus 9090
│
│  Useful commands:
│    kubectl get pods -A
│    k9s
│    stern -n luxecart .
╰─────────────────────────────────────────────────────────────────╯
EOF
