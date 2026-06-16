# Kubernetes manifests (`infra/k8s/`)

This tree is the **single source of truth** for every Kubernetes deployment of
LuxeCart. It progresses through three deployment styles (raw manifests → Helm →
ArgoCD) and two target environments (kind for local dev, EKS for production).

**Docker-compose at the repo root is dev-loop only** (bug fixes only — no new
features). Every feature from this point on lives here.

## Directory layout

```
infra/k8s/
├── base/                       ← raw manifests (K1 / EKS v1 substrate)
│   ├── namespaces/             ← luxecart, data, observability, ingress (+ Pod Security labels)
│   ├── data/                   ← StatefulSets: postgres, redis, kafka(KRaft), opensearch, mongodb
│   ├── app/                    ← 16 services (api-gateway, auth, product, ..., frontend-v2)
│   │                             one folder per service with Deployment, Service, HPA, PDB,
│   │                             NetworkPolicy, ConfigMap, ServiceMonitor
│   ├── observability/          ← kube-prometheus-stack values + Loki + promtail values,
│   │                             dashboards as ConfigMaps, alert rules as PrometheusRule CRDs
│   └── ingress/                ← ingress-nginx + cert-manager Helm release manifests
│
├── overlays/                   ← env-specific patches over base/
│   ├── kind/                   ← K1: smaller requests, NodePort, self-signed TLS, host-path SC
│   └── eks/                    ← E1: gp3 EBS SC, ALB ingress class, IRSA SAs, Let's Encrypt issuer
│
├── charts/                     ← K2 / EKS v2: Helm chart wrapping base/ in templates
│   └── luxecart/
│       ├── Chart.yaml
│       ├── values.yaml
│       ├── values-kind.yaml
│       ├── values-eks.yaml
│       └── templates/
│
├── argocd/                     ← K3 / EKS v3: GitOps source of truth
│   ├── bootstrap/              ← installs ArgoCD itself (one-time, out-of-band)
│   └── apps/                   ← Application + ApplicationSet CRDs (app-of-apps pattern)
│
├── scripts/
│   ├── bootstrap-kind.sh       ← one-command: kind cluster + ingress + cert-manager + apply base
│   ├── teardown-kind.sh
│   └── reseed-data.sh          ← runs schema + seed Jobs
│
└── docs/
    ├── kind-cluster.yaml       ← kind cluster config (k8s 1.30, 3-node, port mappings)
    ├── best-practices.md       ← the B.1–B.10 checklist every manifest must pass
    └── version-ladder.md       ← K1→K2→K3→EKS v1→v2→v3 progression with done-criteria
```

## Version ladder

| Version | Tool      | Goal                                                                 |
|---------|-----------|----------------------------------------------------------------------|
| **K1**  | kustomize | Raw manifests on kind. Every B.x best practice baked in.            |
| **K2**  | Helm      | Same workload as a chart with values overrides.                     |
| **K3**  | ArgoCD    | Cluster auto-syncs from git. App-of-apps.                           |
| **E1**  | kustomize | EKS substrate (ALB, gp3, IRSA, ECR, external-secrets).              |
| **E2**  | Helm      | Same chart as K2 with `values-eks.yaml`.                            |
| **E3**  | ArgoCD    | Production GitOps. Image-updater + sealed-secrets.                  |

## Best practices (binding for every manifest)

See [docs/best-practices.md](docs/best-practices.md). Summary:

- **B.1 Identity & isolation** — ns per tier; SA per workload; restricted PSS; default-deny NetworkPolicy
- **B.2 Health & lifecycle** — readiness/liveness/startup probes; preStop drain; minReadySeconds
- **B.3 Resources & scaling** — requests+limits always; HPA on every stateless; PDB; topologySpread
- **B.4 Config & secrets** — ConfigMap for non-secret; Secret for sensitive (External Secrets Operator in EKS)
- **B.5 Persistence** — StatefulSet for data tier; gp3 (EKS) / host-path (kind); headless Service
- **B.6 Networking** — Ingress (nginx → ALB); cert-manager TLS; no LoadBalancer Services directly
- **B.7 Observability** — ServiceMonitor + Grafana dashboards as ConfigMaps + PrometheusRule + Loki
- **B.8 GitOps & supply chain** — everything in git; image tags pinned by digest; cosign (deferred)
- **B.9 Multi-tenancy** — ResourceQuota + LimitRange per ns
- **B.10 Ops hygiene** — never `kubectl apply -f` in prod; migrations as Job; imagePullSecrets

## Quick start (once K1 manifests exist)

```bash
./scripts/bootstrap-kind.sh   # creates cluster + installs controllers + applies base
kubectl get pods -A
kubectl port-forward -n ingress svc/ingress-nginx-controller 18080:80
```

## Tool versions (pinned)

- kubectl `v1.30.5`
- kind    `v0.23.0` (ships k8s `v1.30.0` node image)
- helm    `v3.15.4`
- kustomize `v5.4.3`
- k9s     `v0.32.5`
- stern   `v1.30.0`
