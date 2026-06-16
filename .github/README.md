# LuxeCart CI/CD & Security Pipeline

GitHub Actions pipeline that builds **every** service image, runs unit tests and
a full security suite, then pushes to **GHCR** (`ghcr.io/<owner>/luxecart-*`).

## Workflows

| File | Trigger | Purpose |
|------|---------|---------|
| [`ci.yml`](workflows/ci.yml) | push/PR to `main`, manual | Orchestrator: detects changed services → matrix build → test → scan → push. Runs SonarCloud once. |
| [`_service-ci.yml`](workflows/_service-ci.yml) | `workflow_call` | Reusable per-service pipeline (build → test → Gitleaks → Trivy → Snyk → push). |
| [`codeql.yml`](workflows/codeql.yml) | push/PR to `main`, weekly | GitHub-native SAST (JS/TS, Python, Go, Java). |
| [`zap-dast.yml`](workflows/zap-dast.yml) | manual, weekly | OWASP ZAP DAST against a **running** staging URL. |

Plus [`dependabot.yml`](dependabot.yml) (dependency + base-image + actions updates)
and repo-root [`.gitleaks.toml`](../.gitleaks.toml) / [`sonar-project.properties`](../sonar-project.properties).

## How "build every image" works

1. **`changes` job** runs [`scripts/changed_services.py`](scripts/changed_services.py),
   which diffs the push/PR against the base and reads
   [`services.json`](services.json) (the single source of truth — 18 services).
   - Manual run / first push / changes to workflows or `services.json` → **build all**.
   - Change under `app/backend-services/shared/` → rebuild all Node + Python services.
   - Otherwise → only services whose source `path` changed.
2. **`build` job** fans out a matrix and calls `_service-ci.yml` per service.
3. Each service: **test → build image (`load`) → scan the built image → push**
   (push reuses the build cache, so the scanned image == the pushed image).
   Push only happens on `push` to `main`.

## Security stages (per the request)

| Stage | Tool | Where | Mode |
|-------|------|-------|------|
| Unit tests | npm / pytest / go test / mvn | `_service-ci.yml` | non-blocking (no tests yet — placeholders via `--if-present` / exit-code guards) |
| Secret scan | Gitleaks | `_service-ci.yml` | report-only |
| Image vuln scan | Trivy | `_service-ci.yml` | report-only, SARIF → code scanning |
| Container scan | Snyk | `_service-ci.yml` | report-only (needs `SNYK_TOKEN`) |
| SAST | SonarCloud | `ci.yml` | report-only (needs `SONAR_TOKEN`) |
| SAST | CodeQL | `codeql.yml` | report-only |
| Dependencies | Dependabot | `dependabot.yml` | PRs |
| DAST | OWASP ZAP | `zap-dast.yml` | report-only, manual/weekly |

> All gates are **non-blocking** initially. To make them block merges, see
> the header comment in `_service-ci.yml` (remove `continue-on-error`, set Trivy
> `exit-code: '1'`) and set `fail_action: true` in `zap-dast.yml`.

## Required secrets & variables

Set under **Settings → Secrets and variables → Actions**:

| Name | Type | Needed for | Notes |
|------|------|-----------|-------|
| `SONAR_TOKEN` | secret | SonarCloud | Skipped if unset. |
| `SNYK_TOKEN` | secret | Snyk scan | Optional; step skips if unset. |
| `NEXT_PUBLIC_API_URL` | variable | frontend build | Passed as build-arg. |
| `SITE_URL` | variable | frontend build | Passed as build-arg. |
| `TARGET_URL` | variable | ZAP DAST | Staging URL to scan. |

`GITHUB_TOKEN` is used automatically for GHCR push (no PAT needed).

### One-time setup
- **GHCR**: first push creates the package; make it public or grant pull access as needed.
- **Code scanning**: enable GitHub code scanning / Advanced Security so the
  Trivy, Snyk and CodeQL SARIF uploads appear under **Security → Code scanning**.
- **SonarCloud**: create the project at <https://sonarcloud.io>, then fill in
  `sonar.organization` / `sonar.projectKey` in `sonar-project.properties`.
- **Dependabot**: enable Dependabot alerts + security updates in repo settings.

## Adding a new service
Add an entry to [`services.json`](services.json) (name, lang, path, context,
dockerfile, image, port, language version). The matrix and path-filtering pick
it up automatically — no workflow edits needed.
