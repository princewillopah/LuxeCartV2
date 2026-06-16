

Let me first scan the current state of the codebase for migration-sensitive patterns:   

Searched for regex `AKIA|AWS_ACCESS_KEY|AWS_SECRET|localhost:|127\.0\.0\.1|hardcoded` (`**/services/**/*.js`), 7 results

Searched for regex `amqp://|mongodb://|redis://|postgresql://|elasticsearch:` (`**/services/**/server.js`), 6 results

Read [](file:///home/princewillopah/DevOps/LuxeCartV2/services/image-service/server.js#1-1), lines 1 to 80

Good news — your code reads everything from env vars and the AWS SDK falls back to the default credential chain when `AWS_ACCESS_KEY_ID` is unset, so **IRSA will work without any code changes**. Below is the audit by layer.

## What "just works" on EKS (no code changes)

| Concern | Why it's fine | What you do in EKS |
|---|---|---|
| **AWS credentials** | `image-service` only injects keys *if* `AWS_ACCESS_KEY_ID` is set; otherwise SDK uses the default chain | Don't set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the pod. Attach an IAM Role to the ServiceAccount (IRSA) with `s3:GetObject/PutObject/DeleteObject` on `arn:aws:s3:::luxecart-images/*` |
| **S3 endpoint** | `S3_ENDPOINT` is optional — unset means real S3 | In EKS manifests: omit `S3_ENDPOINT`. Keep `S3_BUCKET_NAME=luxecart-images` and `AWS_REGION=<your-region>` |
| **Service discovery** | All `DATABASE_URL`, `REDIS_URL`, etc. come from env | Replace docker-compose service names (`postgres`, `redis`) with RDS / ElastiCache / MQ endpoints in your ConfigMap/Secret |
| **API gateway routing** | Single ingress point already; CORS = `*` | Front the gateway pod with an AWS ALB Ingress (`kubernetes.io/ingress.class: alb`). Path-based routing is identical |
| **Health endpoints** | Each service has `/health` | Use as Kubernetes `readinessProbe` / `livenessProbe` |
| **Stateless services** | All Node services are stateless | Run `replicas: 2+` immediately |

## What needs a small change *now* so migration is painless

### 1. The image-service config has a leftover dev-only variable

The `PRESIGN_ENDPOINT` logic is no longer needed (we removed presign upload from the UI). On real AWS you should let it default to real S3. Already fine because you removed `S3_PRESIGN_ENDPOINT` from compose, but the code still computes `PRESIGN_ENDPOINT || ENDPOINT`. In prod this resolves to `null` → SDK builds `https://luxecart-images.s3.us-east-1.amazonaws.com/...` automatically. **No change needed**, just verify by leaving `S3_ENDPOINT` unset.

### 2. Don't bake AWS keys into manifests

Today you have hardcoded keys in docker-compose.yml. In EKS, **do not** put them in a `Secret` — use IRSA:

```yaml
# k8s/image-service/serviceaccount.yaml (template)
apiVersion: v1
kind: ServiceAccount
metadata:
  name: image-service
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<acct>:role/luxecart-image-service
```

### 3. Image serving strategy — decide between two paths

You currently route image *reads* through the gateway (`/api/images/s/<key>` → image-service → S3). On EKS this **works** but is suboptimal because every image byte traverses two pods. You have **two clean paths**, both already supported by your code via `S3_PUBLIC_BASE_URL`:

| Mode | Set `S3_PUBLIC_BASE_URL` to | Pros | Cons |
|---|---|---|---|
| **A. Proxy via gateway** (current) | `https://api.luxecart.com/api/images/s` | Auth on reads possible, no public bucket | Pod CPU + bandwidth per image |
| **B. CloudFront → S3** (recommended for prod) | `https://images.luxecart.com` (CloudFront distribution) | Edge cached, scales to zero pod cost, cheapest egress | Bucket policy must allow CloudFront OAC |

**Both are config-only switches.** The `GET /s/<key>` route stays in the code as a fallback. You decide per environment by setting `S3_PUBLIC_BASE_URL`.

### 4. Frontend `NEXT_PUBLIC_API_URL` must be set *at build time*

Next.js bakes `NEXT_PUBLIC_*` into the JS bundle. Your Dockerfile already accepts it as a build-arg → good. In EKS, build the frontend image with `--build-arg NEXT_PUBLIC_API_URL=https://api.luxecart.com` in CI. Don't try to override it at runtime.

### 5. Managed-service replacements (no code change, only env)

| Compose service | EKS replacement | Env var to update |
|---|---|---|
| `postgres` | RDS Postgres | `DATABASE_URL` per service |
| `redis` | ElastiCache Redis | `REDIS_URL` |
| `mongodb` | DocumentDB or Mongo Atlas | `MONGO_URL` |
| `rabbitmq` | Amazon MQ for RabbitMQ | `RABBITMQ_URL` / `AMQP_URL` |
| `elasticsearch` | OpenSearch Service | `ELASTICSEARCH_URL` |
| `localstack` | **gone** — real S3 | unset `S3_ENDPOINT` |
| `prometheus`/`grafana`/`loki` | Amazon Managed Prometheus + Managed Grafana, or self-host | scrape config |

## Things to fix *before* you migrate

These will bite you in EKS if left alone:

1. **JWT secret** — currently likely a default. Move to AWS Secrets Manager + External Secrets Operator → mounted as env to auth-service. Same `JWT_SECRET` env var, different source.
2. **CORS `origin: '*'`** on the gateway — tighten to your real frontend domain(s) before going public. Code change is one line in `api-gateway-service/server.js`.
3. **Bucket bootstrap** — `infra/image-init/bootstrap.sh` creates the bucket + CORS on LocalStack. In AWS, that's a **Terraform module** instead (you already have `infra/terraform/`). Add an `s3.tf` with the bucket, CORS, lifecycle rules, and CloudFront OAC.
4. **No public-read bucket policy** for the S3 bucket in prod — use CloudFront OAC instead so the bucket stays private.
5. **Multipart upload size limit** (`MAX_UPLOAD_BYTES=5MB`) goes through the gateway → ALB has a default 1MB request body cap for some Lambda integrations but not for ALB→pod (which has no body cap). Verify your ALB target group's idle timeout is > upload time.
6. **Each Node service has its own DB pool** — fine, but set `max` on the `pg.Pool` to something sensible (e.g. 5–10) so 3 replicas × 10 = 30 connections fits within RDS's `max_connections`.

## Recommended next concrete step

Since you want migration smoothness, I'd suggest:

1. **Add a `prod` env file template** alongside `.env` that documents every env var each service expects, with example values for AWS. This becomes the source of truth for your Kubernetes `ConfigMap`/`Secret`.
2. **Promote `infra/terraform/`** — add modules for `s3-images` (bucket + CloudFront + OAC), `rds-postgres`, `elasticache-redis`, `mq-rabbitmq`, `opensearch`, `eks` (you may already have this).
3. **Add Helm charts or Kustomize overlays** per service (one Deployment + Service + ServiceAccount + HPA each).

Want me to do any of these now? I can:
- **(a)** Generate the `.env.prod.example` template with every env var grouped by service
- **(b)** Scaffold a `k8s/` directory with Kustomize bases for all 16 services
- **(c)** Write the Terraform `s3-images` module (bucket + CloudFront + OAC + IAM role for IRSA)
- **(d)** Audit and tighten CORS + JWT secret handling for prod-readiness

Pick one (or several) and I'll implement.