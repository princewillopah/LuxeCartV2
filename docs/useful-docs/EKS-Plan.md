# Kubernetes migration — full plan

I'll lay this out as: **(A) tools you install on the VM**, **(B) k8s production best practices we'll enforce**, **(C) the kind→EKS version ladder with explicit scope per version**.

---

## A. Tools to install on the VM (one-time)

| Tool | Purpose | Notes |
|---|---|---|
| **`kubectl`** v1.30+ | k8s CLI | matches the cluster version we'll use |
| **`kind`** v0.23+ | local k8s cluster in docker | runs k8s 1.30 inside docker; cheap to nuke + recreate |
| **`helm`** v3.15+ | package manager | for v2 + for installing controllers (ingress, prometheus stack, cert-manager, etc.) on every cluster including v1 |
| **`kustomize`** v5+ | template-free overlays | bundled with kubectl 1.14+, but standalone is more featureful |
| **`k9s`** | TUI for cluster | not required, but pays for itself in 10 minutes |
| **`stern`** | multi-pod log tailer | `stern -n luxecart .` beats raw `kubectl logs` |
| **`argocd` CLI** | for v3 | install when we get there |
| **`eksctl`** | for EKS phase | install when we get there; not needed on kind |
| **`aws-cli`** v2 + **`aws-iam-authenticator`** | for EKS phase | install when we get there |

I'll give you the exact install commands when you say go. Everything except `eksctl`/`aws-cli` is needed from day 1.

---

## B. K8s production best practices we'll enforce (the non-negotiables)

This is the checklist every manifest will pass. Anchored to your "industry standard, nothing short" mandate.

### B.1 Workload identity & isolation
- **Namespaces** — one per logical tier: `luxecart` (app), `data` (postgres/redis/kafka/opensearch/mongodb), `observability` (prom/grafana/loki), `ingress`, `argocd`. Cross-namespace traffic only via `Service` DNS.
- **ServiceAccount per workload** — never use `default`. Pre-wires us for IRSA (IAM Roles for Service Accounts) in EKS.
- **Pod-level `securityContext`**: `runAsNonRoot: true`, `runAsUser: 1000`, `readOnlyRootFilesystem: true` (with explicit emptyDir mounts for any path that needs to be writable), `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `seccompProfile.type: RuntimeDefault`.
- **NetworkPolicies** — default-deny ingress + egress in `luxecart` namespace, then explicit allow rules per service edge. Frontend → gateway → backend services → datastores. No flat networks.
- **PodSecurityStandards** — `restricted` profile enforced via `kube-apiserver` admission on the `luxecart` namespace.

### B.2 Health & lifecycle
- **`readinessProbe`** — gates traffic. Hit `/health` with `httpGet`. Already implemented by Phase H' for all services.
- **`livenessProbe`** — restarts dead pods. Use a *different* threshold than readiness (deeper failure detection).
- **`startupProbe`** — for slow boots (Java product-service, opensearch). Prevents liveness from killing during init.
- **`terminationGracePeriodSeconds: 30`** + a `preStop` hook that drains in-flight requests. Phase H already wired SIGTERM handlers — k8s will use them.
- **`minReadySeconds`** during rollouts so health flapping doesn't get marked "available".

### B.3 Resources & scaling
- **Every container has `requests` AND `limits`** for CPU and memory. No bare pods. The cluster scheduler needs these to bin-pack and the kernel needs them to OOM-kill correctly.
- **`HorizontalPodAutoscaler`** on every stateless service. Default: `targetCPUUtilization: 70%` + `minReplicas: 2`, `maxReplicas: 10`. Java + Go services tuned separately.
- **`PodDisruptionBudget`** — `minAvailable: 1` (or `maxUnavailable: 25%` for the bigger replica counts) on every stateless service. Prevents a node-drain from taking the whole tier down.
- **`topologySpreadConstraints`** — spread pods across nodes/zones so a single node failure can't kill a service. Critical in EKS where nodes go away.

### B.4 Configuration & secrets
- **`ConfigMap`** for all non-secret env (DB host, Kafka brokers, log level, feature flags).
- **`Secret`** for everything sensitive — DB passwords, JWT signing key, Paystack/Flutterwave API keys.
- **Mount as env vars**, never as files unless the secret is a TLS cert or kubeconfig.
- **In EKS: External Secrets Operator + AWS Secrets Manager** — never store production secrets in a git-tracked manifest. We'll set this up in EKS v1.
- **In kind: encrypted with `sealed-secrets` or `sops`** so v3 (ArgoCD) can sync from git without leaking.

### B.5 Persistence
- **`StatefulSet`** for postgres, redis, kafka, opensearch, mongodb. Never `Deployment` for stateful workloads.
- **`PersistentVolumeClaim` + `StorageClass`** — kind uses `standard` (host-path); EKS uses `gp3` EBS with `volumeBindingMode: WaitForFirstConsumer`.
- **Headless `Service`** for stateful workloads so each pod is addressable individually (`postgres-0.postgres`, `kafka-1.kafka`).
- **Backup strategy** — Velero in EKS (deferred but planned). For kind we just nuke and reseed.

### B.6 Networking & ingress
- **`Ingress` with `ingress-nginx`** in kind → `aws-load-balancer-controller` (ALB) in EKS. Same `Ingress` resource, different controller class.
- **TLS via cert-manager** — Let's Encrypt issuer in EKS, self-signed in kind. Same `Certificate` CRD.
- **`Service` types**: `ClusterIP` for internal, `NodePort` only for kind dev access, never `LoadBalancer` directly (use `Ingress` instead so we get one ALB for everything).
- **HTTP/2 + gRPC ready** — your Node services don't need it today, but the manifests won't block it.

### B.7 Observability (Phase 8 deliverables fit here cleanly)
- **`/metrics` scraped via `ServiceMonitor`** (kube-prometheus-stack CRD). One per service.
- **Grafana dashboards as ConfigMaps** with label `grafana_dashboard: "1"` — auto-imported by the stack's sidecar.
- **`PrometheusRule` CRDs** for alert definitions.
- **Logs via Loki + promtail/Grafana Alloy DaemonSet** — reads `/var/log/containers/*.log` (k8s standard).
- **Distributed tracing** — OpenTelemetry sidecar deferred (would be Phase 12), but we'll add `traceparent` propagation in Phase 8 so traces work the day we add a collector.

### B.8 GitOps & supply chain
- **All cluster state in git** under `infra/k8s/` from day 1.
- **Image tags pinned by digest** (`@sha256:...`) in production overlays — never `:latest`, never `:main`.
- **Image signing with cosign** — deferred but planned for EKS hardening.
- **Kyverno or OPA Gatekeeper** policy admission — deferred to EKS.

### B.9 Multi-tenancy & quotas
- **`ResourceQuota`** per namespace — prevents one team/namespace from eating the cluster.
- **`LimitRange`** with default requests/limits — anything that forgets to set them gets reasonable defaults.

### B.10 Ops hygiene
- **`kubectl apply -f` is forbidden in production**. Everything goes through `kustomize build | kubectl apply -f -` (v1) or Helm (v2) or ArgoCD (v3).
- **Migrations run as `Job` or `initContainer`**, never manually.
- **Image pull credentials via `imagePullSecrets`** + ECR (in EKS) or Docker Hub PAT (in kind).

---

## C. Version ladder — kind first, then EKS

Each version is a **complete, deployable system** with the full app running. The progression is about *how* it's deployed, not what's deployed.

### KIND v1 — raw manifests (kustomize)

**Goal**: prove every app works in k8s, with all the B.x best practices baked in. No Helm, no GitOps — just `kubectl apply -k`.

```
infra/k8s/
├── base/
│   ├── namespaces/
│   ├── data/                  ← postgres, redis, kafka(KRaft), opensearch, mongodb
│   │   ├── postgres-statefulset.yaml
│   │   ├── kafka-statefulset.yaml
│   │   └── ...
│   ├── app/
│   │   ├── api-gateway/       ← Deployment, Service, HPA, PDB, NetworkPolicy, ConfigMap, ServiceMonitor
│   │   ├── auth-service/
│   │   ├── ... (16 services)
│   │   └── frontend-v2/
│   ├── observability/         ← installed via Helm (kube-prometheus-stack + loki + promtail)
│   └── ingress/               ← ingress-nginx + cert-manager
└── overlays/
    └── kind/
        ├── kustomization.yaml
        ├── ingress-patch.yaml ← NodePort overrides for local
        └── resource-patch.yaml ← smaller requests for laptop-class
```

**Deliverables**:
- 16 services + 5 datastores + observability tier all running on kind
- All B.x best practices applied (probes, resources, security context, network policies, HPA, PDB, topology spread, etc.)
- One bash script `infra/k8s/bootstrap-kind.sh` that creates the cluster + applies everything in order
- 12-endpoint regression PASS, same as docker compose

**What you learn here**: every k8s primitive. By the end you can read any k8s manifest in the wild.

### KIND v2 — Helm chart

**Goal**: same workload, deployed as a chart. Single `helm install luxecart ./charts/luxecart` brings up the whole app. The base chart wraps the v1 manifests in templates.

```
infra/k8s/
├── charts/
│   └── luxecart/
│       ├── Chart.yaml
│       ├── values.yaml         ← all knobs (image tags, replicas, resource sizes, env)
│       ├── values-kind.yaml    ← kind-specific overrides
│       ├── templates/
│       │   ├── _helpers.tpl    ← labels, naming
│       │   ├── api-gateway.yaml ← templates the v1 manifest
│       │   └── ...
│       └── charts/             ← subcharts for postgres/kafka/etc (or use bitnami)
└── (overlays/kind from v1 retired)
```

**Deliverables**:
- Single chart, parameterized with values
- `bitnami/postgresql`, `bitnami/redis`, `bitnami/kafka` (or strimzi), `opensearch/opensearch` as subchart dependencies (`Chart.yaml` `dependencies:`) — we don't reinvent stateful operators
- App services as our own templates (we own these)
- `helm upgrade --install --atomic` workflow
- Lint via `helm lint` + `helm template | kubeval` in CI

**What you learn here**: templating, values inheritance, chart composition, lifecycle hooks (`helm.sh/hook`), dependencies.

### KIND v3 — ArgoCD (GitOps)

**Goal**: cluster auto-syncs from a git repo. You change a value in git, ArgoCD applies it. No more `helm install` from your laptop.

```
infra/k8s/
├── argocd/
│   ├── bootstrap/              ← installs argocd itself (one-time)
│   └── apps/                   ← Application + ApplicationSet CRDs
│       ├── luxecart-app.yaml   ← points at charts/luxecart with values-kind.yaml
│       ├── observability.yaml
│       └── ingress-stack.yaml
├── charts/                     ← unchanged from v2
└── ...
```

**Deliverables**:
- ArgoCD installed via Helm
- App-of-apps pattern: one root `Application` that manages child Applications
- Auto-sync enabled with self-heal + prune
- Image updater (`argocd-image-updater`) watching docker hub for new tags
- Branching strategy: `main` = source of truth, PRs trigger preview environments via ApplicationSets
- Sealed-secrets or sops for secrets that can live in git

**What you learn here**: GitOps, declarative deployments, drift detection, sync waves, hooks, app-of-apps, multi-environment.

### EKS v1, v2, v3 — same three steps on the real thing

Once kind v3 is solid, EKS v1/v2/v3 are mostly **environment overlays**, not architecture changes:

| | EKS v1 — manifests | EKS v2 — Helm | EKS v3 — ArgoCD |
|---|---|---|---|
| **Cluster** | `eksctl create cluster` w/ managed node groups (or Fargate for some workloads) | same | same |
| **Storage** | `gp3` StorageClass via EBS CSI driver | same | same |
| **Ingress** | AWS Load Balancer Controller → ALB | same | same |
| **DNS/TLS** | external-dns + cert-manager (Let's Encrypt) | same | same |
| **Secrets** | External Secrets Operator + AWS Secrets Manager | same | same |
| **Image registry** | ECR with IAM auth | same | same |
| **IRSA** | ServiceAccount → IAM role per service that needs AWS API access | same | same |
| **Autoscaling** | Cluster Autoscaler (or Karpenter — recommended) | same | same |
| **Observability** | CloudWatch Container Insights *plus* the same prom/grafana/loki stack | same | same |
| **Backups** | Velero → S3 | same | same |
| **Cost** | spot for stateless services, on-demand for datastores; right-sized via Karpenter | same | same |

The actual delta from kind→EKS is one new `overlays/eks/` directory (v1) or `values-eks.yaml` (v2/v3). The chart structure doesn't change.

### Optional later milestones (not required for v1-v3, but mapped)

- **Service mesh** (Istio or Linkerd) — for mTLS, retries, traffic shifting, canary deploys. Probably worth it once you have >20 services.
- **Cert-manager + sealed-secrets** — already in v3 via Helm.
- **Multi-cluster / multi-region** — Crossplane or Cluster API if you grow.
- **Policy enforcement** — Kyverno or OPA Gatekeeper.
- **Distributed tracing** — OpenTelemetry collector + Tempo or Jaeger.
- **Chaos engineering** — Litmus or Chaos Mesh.
- **CI/CD** — GitHub Actions builds image → pushes to ECR → ArgoCD Image Updater bumps the tag → ArgoCD syncs.

---

## What Phase 8 (observability) becomes under this plan

It moves out of docker-compose entirely. The dashboards/alerts/log queries we were going to build will be **assets that ship with the app's Helm chart** (or as a separate observability chart in `infra/k8s/charts/observability/`). They'll be valuable from kind v1 onward.

So the sequence is:

1. **Now**: install kind + tools, create v1 directory structure, port the app to raw k8s manifests with all best practices
2. **Once kind v1 boots clean**: do Phase 8 (dashboards/alerts/log queries) inside kind — they're now a k8s asset, not a docker-compose asset
3. **Then**: kind v2 (Helm), kind v3 (ArgoCD), EKS v1/v2/v3

---

