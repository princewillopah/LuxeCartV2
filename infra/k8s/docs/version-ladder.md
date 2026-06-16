# Version ladder — done-criteria for each release

Each row is *binary done/not-done*. We don't move to the next row until every
checkbox above clears.

---

## K1 — kind, raw manifests (kustomize)

**Goal**: every workload runs on kind via `kustomize build overlays/kind | kubectl apply -f -`.

- [ ] Namespaces created with PSS labels (B.1)
- [ ] Calico CNI installed and NetworkPolicy enforced
- [ ] ingress-nginx + cert-manager Helm-installed and Ready
- [ ] Postgres StatefulSet with PVC; schema + seed Jobs ran to completion
- [ ] Redis StatefulSet Ready
- [ ] Kafka (KRaft) StatefulSet Ready; topics auto-created
- [ ] OpenSearch StatefulSet Ready
- [ ] MongoDB StatefulSet Ready (only if rating-service still uses it)
- [ ] All 16 services Deployed with: SA, securityContext, probes, requests+limits, HPA, PDB, NetworkPolicy, ServiceMonitor
- [ ] Frontend-v2 Deployed and reachable via Ingress
- [ ] Ingress routes: `/api/*` → api-gateway, `/*` → frontend
- [ ] kube-prometheus-stack scraping every `/metrics` endpoint
- [ ] Grafana dashboards loaded from ConfigMaps (`grafana_dashboard: "1"` label)
- [ ] Loki ingesting logs from every pod
- [ ] PrometheusRule CRDs for: high error rate, circuit-breaker open, kafka consumer lag, pod restart loop
- [ ] 12-endpoint regression smoke-test passes (script in `scripts/smoke.sh`)
- [ ] `bootstrap-kind.sh` brings everything up from zero in ≤ 10 min
- [ ] `teardown-kind.sh` cleanly removes everything

## K2 — Helm chart

**Goal**: same workload as K1 but installed via `helm upgrade --install`.

- [ ] `charts/luxecart/` scaffold: Chart.yaml, values.yaml, _helpers.tpl
- [ ] Each base resource has a matching template using common `_helpers.tpl` (labels, image tag, SA name)
- [ ] `values-kind.yaml` reproduces K1 exactly
- [ ] `helm template ... | kubectl diff -f -` is empty diff against K1
- [ ] `helm test` Job hits `/health` on every service
- [ ] Atomic install: `helm upgrade --install --atomic --wait` succeeds and rolls back on any failure
- [ ] Pre-upgrade migration hook runs schema migrations as a Job

## K3 — ArgoCD GitOps

**Goal**: pushing to `main` updates the cluster. No more local `kubectl apply`.

- [ ] ArgoCD installed via `argocd/bootstrap/`
- [ ] App-of-apps `argocd/apps/root.yaml` sourcing `argocd/apps/*.yaml`
- [ ] Application per logical group: `data`, `services`, `frontend`, `observability`, `ingress`
- [ ] Auto-sync + self-heal + prune enabled
- [ ] `kubectl edit` drift is reverted within 60s by ArgoCD
- [ ] Sync waves: ns → data → services → frontend → ingress
- [ ] ArgoCD UI reachable via Ingress with self-signed TLS
- [ ] sealed-secrets installed so Secrets can live in git encrypted

## E1 — EKS, raw manifests

**Goal**: K1 functionality running on real EKS. Same `kustomize` invocation,
different overlay.

- [ ] Terraform module: VPC (3 AZs, public+private subnets), EKS cluster, managed node group, OIDC provider, ECR repos
- [ ] AWS Load Balancer Controller installed (IRSA)
- [ ] External DNS installed (Route53 IRSA)
- [ ] cert-manager + Let's Encrypt ClusterIssuer (HTTP-01)
- [ ] EBS CSI driver + gp3 StorageClass as default
- [ ] External Secrets Operator + AWS Secrets Manager provider
- [ ] Karpenter or Cluster Autoscaler for node scaling
- [ ] All container images in ECR (pushed by CI)
- [ ] All Secrets sourced from Secrets Manager (no plain Secret YAML in git)
- [ ] Ingress uses `ingressClassName: alb` + `alb.ingress.kubernetes.io/scheme: internet-facing`
- [ ] `overlays/eks/` patches base/ with: gp3 SC, IRSA SA annotations, alb class, prod resource limits
- [ ] CloudWatch Container Insights or Managed Prometheus integrated
- [ ] Backup: Velero → S3 weekly
- [ ] Cost: nodes are graviton (arm64) where possible

## E2 — EKS, Helm

**Goal**: K2 chart deployed to EKS via `values-eks.yaml`.

- [ ] `values-eks.yaml` produced
- [ ] Same `helm test` passes on EKS
- [ ] Image tags pinned by digest in values-eks.yaml

## E3 — EKS, ArgoCD (production GitOps)

**Goal**: production self-heals from git.

- [ ] ArgoCD on EKS with HA (3 replicas of each component)
- [ ] argocd-image-updater watching ECR for new digests
- [ ] Notifications: ArgoCD Slack on sync failure
- [ ] Multi-cluster: ArgoCD on a dedicated mgmt cluster syncs to prod cluster
- [ ] Disaster recovery runbook documented and tested
