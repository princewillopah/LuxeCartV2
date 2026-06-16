# K8s production best practices (B.1 – B.10)

Every manifest in `infra/k8s/` must satisfy these checks. This is the
"industry standard, nothing short" contract.

The order is roughly **most-common-failure-mode first**.

---

## B.1 Identity & isolation

- **Namespace per tier**: `luxecart` (app), `data` (stateful), `observability`
  (prom/grafana/loki), `ingress`, `argocd`. Never `default`.
- **ServiceAccount per workload**. Never the `default` SA. Pre-wires IRSA
  (IAM Roles for Service Accounts) for EKS.
- **Pod `securityContext`**:
  ```yaml
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  ```
- **Container `securityContext`**:
  ```yaml
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop: ["ALL"]
  ```
  Mount `emptyDir` at any writable path (`/tmp`, `/app/cache`, etc.).
- **NetworkPolicy**: default-deny (ingress + egress) in `luxecart` ns, then
  explicit allow rules per edge (frontend→gateway, gateway→service,
  service→datastore, service→kafka).
- **PodSecurityStandard `restricted`** enforced on `luxecart` ns via
  the `pod-security.kubernetes.io/enforce: restricted` label on the Namespace.

## B.2 Health & lifecycle

- **`readinessProbe`** — gates traffic. `httpGet` on `/health`. Use the same
  endpoint we baked in Phase H'.
- **`livenessProbe`** — restarts dead pods. Use a *different threshold* than
  readiness so a slow pod doesn't get killed when it should only be removed
  from the load-balancer pool.
- **`startupProbe`** — for slow boots (Java product-service, opensearch).
  Prevents liveness from killing during init.
- **`terminationGracePeriodSeconds: 30`** + `preStop` hook with `sleep 5` so
  the endpoint is removed from kube-proxy iptables before the process exits.
  Phase H already wired SIGTERM handlers.
- **`minReadySeconds: 10`** on Deployments — health flapping during rollout
  won't mark pods "available" too eagerly.

## B.3 Resources & scaling

- **Every container has `requests` AND `limits`** (cpu + memory). No bare pods.
  Without requests the scheduler can't bin-pack; without limits one runaway
  pod can OOM the node.
- **`HorizontalPodAutoscaler`** on every stateless service:
  ```yaml
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target: { type: Utilization, averageUtilization: 70 }
  ```
- **`PodDisruptionBudget`**: `minAvailable: 1` (small services) or
  `maxUnavailable: 25%` (larger replica counts). Prevents node-drain from
  taking the whole tier down.
- **`topologySpreadConstraints`**: spread across `topology.kubernetes.io/zone`
  (EKS) and `kubernetes.io/hostname`. `maxSkew: 1`, `whenUnsatisfiable:
  ScheduleAnyway` (degrades gracefully on a small cluster).

## B.4 Configuration & secrets

- **ConfigMap** for non-secret env: DB host, Kafka brokers, log level,
  feature flags, region.
- **Secret** for sensitive: DB passwords, JWT signing key, Paystack/Flutterwave
  API keys, SMTP credentials.
- **Mount as env vars**, never as files unless the secret is a TLS cert
  or kubeconfig.
- **EKS**: External Secrets Operator + AWS Secrets Manager. Never store
  production secrets in git.
- **kind**: sealed-secrets or sops so v3 ArgoCD can sync from git without
  leaking. (Plain Secrets fine for K1/K2 local development.)

## B.5 Persistence

- **`StatefulSet`** for postgres, redis, kafka, opensearch, mongodb. Never
  `Deployment` for stateful workloads.
- **`PersistentVolumeClaim` + `StorageClass`**:
  - kind: `standard` (host-path) — fine for dev.
  - EKS: `gp3` EBS with `volumeBindingMode: WaitForFirstConsumer`.
- **Headless `Service`** (`clusterIP: None`) for stateful workloads so each
  pod gets a stable DNS name: `postgres-0.postgres.data.svc.cluster.local`.
- **Backups**: Velero → S3 in EKS (deferred). For kind we nuke and reseed.

## B.6 Networking & ingress

- **One `Ingress`** per public hostname. Controller class:
  - kind: `nginx` (ingress-nginx)
  - EKS: `alb` (AWS Load Balancer Controller). Same Ingress resource, different `ingressClassName`.
- **TLS via cert-manager**:
  - kind: self-signed `ClusterIssuer`
  - EKS: Let's Encrypt `ClusterIssuer` with HTTP-01 challenge through ALB.
  - Same `Certificate` CRD in both.
- **Service types**: `ClusterIP` (internal default), `NodePort` (kind dev access only),
  **never `LoadBalancer`** directly — always go through Ingress so we get one ALB for everything.

## B.7 Observability (replaces standalone Phase 8)

- **`/metrics`** scraped via **`ServiceMonitor`** CRD (kube-prometheus-stack).
  One ServiceMonitor per service, selecting by label.
- **Grafana dashboards** as `ConfigMap` with label `grafana_dashboard: "1"` —
  auto-imported by the stack's grafana sidecar. **Never** built via UI clicks.
- **Alert rules** as `PrometheusRule` CRDs.
- **Logs** via Loki + promtail or Grafana Alloy DaemonSet, reading
  `/var/log/containers/*.log` (the k8s standard).
- **Distributed tracing** deferred. App should still propagate `traceparent`
  header so traces work the day we add an OTLP collector.
- **🔒 PromQL portability rule**: filter by **`service`** label
  (set by app via `register.setDefaultLabels({ service: 'api-gateway' })`),
  **NEVER** by `job` (set by the scrape config — differs docker vs k8s).
  Use Grafana template variables `$service`, `$target` driven by
  `label_values(http_client_requests_total, service)`.

## B.8 GitOps & supply chain

- All cluster state in git under `infra/k8s/` from day 1.
- Image tags **pinned by digest** (`@sha256:...`) in production overlays.
  Never `:latest`, never `:main`, never floating tags.
- Image signing with cosign — deferred but planned for EKS hardening.
- Kyverno / OPA Gatekeeper admission — deferred to EKS.

## B.9 Multi-tenancy

- **`ResourceQuota`** per namespace: caps cpu/memory/pods/PVC count so one
  team can't eat the cluster.
- **`LimitRange`** with default requests+limits: catches manifests that
  forgot B.3 and gives them reasonable defaults instead of admission errors.

## B.10 Ops hygiene

- `kubectl apply -f` is **forbidden in production**. Always:
  - K1/E1: `kustomize build overlays/<env> | kubectl apply -f -`
  - K2/E2: `helm upgrade --install --atomic`
  - K3/E3: `argocd app sync` (or auto-sync)
- **Migrations** as `Job` or `initContainer`, never manually. Use
  Helm `pre-upgrade` hook for chart-managed migrations.
- **`imagePullSecrets`** via ECR (EKS) or Docker Hub PAT (kind).

---

## Reviewing checklist for a new manifest

Before merging any manifest, walk this checklist:

- [ ] Lives in the right ns (B.1)
- [ ] Has a non-default ServiceAccount (B.1)
- [ ] Has pod + container `securityContext` (B.1)
- [ ] Has NetworkPolicy that names every other workload it talks to (B.1)
- [ ] Has readiness + liveness probes with *different* thresholds (B.2)
- [ ] Has `terminationGracePeriodSeconds` ≥ 30 and a `preStop` (B.2)
- [ ] Every container has both `requests` and `limits` (B.3)
- [ ] Has HPA + PDB (if stateless) (B.3)
- [ ] Has `topologySpreadConstraints` (B.3)
- [ ] Config from ConfigMap, secrets from Secret (B.4)
- [ ] If stateful: is a StatefulSet with PVC and headless Service (B.5)
- [ ] Internal Service is ClusterIP; public traffic via Ingress only (B.6)
- [ ] Has ServiceMonitor + emits structured JSON logs to stdout (B.7)
- [ ] PromQL anywhere uses `service` label, not `job` (B.7)
- [ ] Image tag pinned by digest in production overlay (B.8)
