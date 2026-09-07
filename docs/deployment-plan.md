# Deployment plan: crewreg backend on AWS (MVP)

Status: approved 2026-09-06 (owner: Matthew Khoo). This file is the plan as
agreed before any infrastructure code was written. Region changed to
`us-east-2` at the owner's request on 2026-09-07, after a first deploy to
Mumbai; the figures below are the Mumbai ones the plan was approved with. The as-built description
lives in `deployment-architecture.md`; where the two disagree, the as-built
document wins.

## Goal and constraints

Deploy the `shipping-backend` Go binary to AWS as infrastructure as code, as
cheaply as a real deployment allows:

- one EC2 instance, no load balancer, no NAT gateway, no container platform;
- one free-tier-class RDS Postgres instance (Single-AZ);
- region `ap-south-1` (Mumbai), which is what the backend config defaults to
  and the right jurisdiction for the seafarer PII the platform will hold;
- the frontend is deployed to AWS Amplify separately by the owner;
- an MVP: one environment (`dev`) now, a `prod` instantiation later;
- nothing is deployed by the session that writes this plan; the owner runs the
  first deploy.

What the binary needs, read from the backend repo (`backend/cmd/main.go`,
`backend/config`, `common/db`, `common/secretsmanager`):

| Need | Detail |
|---|---|
| Runtime | Static Go binary, listens on `:8080`, no TLS of its own |
| OS packages | `poppler-utils` (`pdftotext`, `pdftoppm` are shelled out) |
| Config | One YAML file; `CONFIG_PATH` is the only environment variable read |
| Secrets | Three JSON secrets in AWS Secrets Manager named `<env>/llm`, `<env>/database`, `<env>/auth`, fetched at boot via the instance role |
| Database | Postgres; `sslmode=require` outside `local`; migrations auto-apply at boot for every environment except `prod` |
| Health | `GET /ping` answers `pong` and touches nothing |

## Decisions

1. **AWS CDK v2, TypeScript.** The infra repo's own guidance prefers CDK or
   CloudFormation. One CDK app; per environment a data stack (VPC, RDS,
   secrets) and an app stack (instance, artifacts bucket, CI role, budget), so
   a compute teardown cannot take the database with it. One account-level stack
   for the GitHub OIDC provider.
2. **A raw static binary, not a Docker image.** Go produces one file; the only
   OS dependency is poppler-utils, installed once by cloud-init. Deploys are an
   S3 upload plus a systemd restart, with rollback by re-pointing a symlink. A
   Docker daemon on a 1 GB instance, an ECR repository and image pulls on every
   deploy buy nothing until the platform moves to ECS, and a Dockerfile can be
   added beside this path later without changing it.
3. **HTTPS terminated on the instance by Caddy** with a Let's Encrypt
   certificate for a hostname on the owner's Namecheap domain. The DNS A
   record is created by hand in Namecheap against the stack's Elastic IP
   output. No Route 53, no ALB, no CloudFront.
4. **CORS lives in the backend**, as a middleware whose allowed origins are read
   from the config file (a separate PR to the backend repo). The infra writes
   that list into the instance's config file from CDK context.
5. **CI/CD is two GitHub Actions workflows in the backend repo:** tests on every
   PR, and a manual `Deploy` workflow (`workflow_dispatch`) with an
   `environment` choice. It authenticates with GitHub OIDC to an IAM role the
   app stack creates, so no AWS keys are stored in GitHub. `prod` is wired but
   refuses to run from any ref other than `main`.
6. **Environment name `dev`.** Migrations auto-apply at boot outside `prod`,
   and the binary has no migration runner yet. Graduating to `prod` needs one.
7. **Instance access is SSM Session Manager only.** No SSH port, no key pair.
8. **No real seafarer data.** The backend's own rule stands (STATUS.md, ADR
   0021): erasure, retention, audit trail and login rate limiting do not exist
   yet. This deployment is for development and demonstration.

## Architecture

| Resource | Choice | Why |
|---|---|---|
| VPC | 2 AZs, public + isolated subnets, no NAT gateway | RDS needs two AZs. A NAT gateway alone is about $32/month, so the instance sits in a public subnet and reaches Gemini and Secrets Manager directly. |
| EC2 | t3.micro, Amazon Linux 2023 x86_64, gp3 10 GB root, Elastic IP, IMDSv2 required, CPU credits `standard`, 2 GB swap file | Free-tier eligible on legacy accounts. Standard credits cap burst charges. Swap covers `pdftoppm` spikes on 1 GB RAM. |
| Bootstrap | cloud-init installs poppler-utils, Caddy (pinned version, checksum verified) and the CloudWatch agent; creates a `crewreg` service user; writes `/etc/crewreg/config.yaml`, the Caddyfile, a systemd unit and the deploy script; pulls the current binary from S3 | The instance is disposable; all state lives in RDS and S3. A bootstrap change replaces the instance. |
| RDS | db.t4g.micro, PostgreSQL 16, Single-AZ, gp3 20 GB, encrypted, 7-day backups, not publicly accessible, snapshot on delete | Free-tier eligible. Matches the local Postgres 16. |
| Secrets Manager | `dev/database` (generated password; host and port attached by RDS), `dev/auth` (generated signing key), `dev/llm` (provider and models set, API key placeholder the owner sets once) | Exactly the three sections the config loader fetches. |
| S3 | Private artifacts bucket: `server/<git-sha>/server`, `server/<git-sha>/server.sha256`, `server/current` | Pennies. Versioned, so a pointer can be recovered. |
| IAM | Instance role: read `dev/*` secrets, read the artifacts bucket, SSM core, CloudWatch agent. Deploy role: assumed by GitHub OIDC for the `dev` environment; write the bucket, `ssm:SendCommand` to instances tagged `crewreg:env=dev` | Least privilege, credentials via the instance role, matching how the code loads them. |
| Logs | CloudWatch Logs, 14-day retention, service log and Caddy access log | Under the always-free 5 GB/month. Survive instance replacement. |
| Cost guard | AWS Budget, $40/month, email at 80% actual and 100% forecast | First two budgets are free. |
| Edge | Security group opens 80 (ACME challenge and redirect) and 443 to the world; 8080 stays on localhost | |

## Seams (contracts between the two repos)

**Config file written on the instance** (`/etc/crewreg/config.yaml`). The
`llm`, `database` and `auth` sections are omitted because the loader replaces
them from Secrets Manager.

```yaml
environment: dev
region: ap-south-1
extract:
  min_text_chars: 100
  vision_dpi: 150
  max_vision_pages: 8
cors:
  allowed_origins:
    - https://main.<app-id>.amplifyapp.com
```

**Backend CORS config** (`backend/config`): `Config.CORS` of type
`CORSConfig{AllowedOrigins []string}` with tags `yaml:"cors"` /
`yaml:"allowed_origins"` and matching `json` tags. Non-secret, so it comes from
the file in every environment. An empty list disables CORS. Each entry must be
an absolute `http(s)://host[:port]` origin with no path.

**Deploy contract.** The workflow (or `scripts/deploy.sh` from a laptop) does:

1. `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o server ./cmd` from `backend/`;
2. upload `server` and `server.sha256` to `s3://<bucket>/server/<git-sha>/`;
3. write `<git-sha>` to `s3://<bucket>/server/current`;
4. `aws ssm send-command` with document `AWS-RunShellScript`, targets
   `tag:crewreg:env=<env>` and `tag:crewreg:role=api`, command
   `/usr/local/bin/crewreg-deploy <git-sha>`;
5. poll the command invocation until it finishes; fail on anything but
   `Success`;
6. `curl -fsS https://<api-host>/ping`.

`crewreg-deploy` on the instance downloads the release, verifies the checksum,
re-points `/opt/crewreg/current`, restarts the `crewreg` systemd unit, waits for
`localhost:8080/ping`, and re-points to the previous release if that never
answers. On first boot cloud-init reads `server/current` and runs the same
script, so a replaced instance comes up on the last deployed build.

**GitHub environment `dev` variables** (all outputs of the app stack):
`AWS_ROLE_ARN`, `AWS_REGION`, `ARTIFACTS_BUCKET`, `API_HOST`.

## Expected costs (ap-south-1, on-demand, 730 h/month)

Prices from AWS's published price files dated 2026-09-04; totals computed by
script.

| Item | Monthly |
|---|---|
| EC2 t3.micro ($0.0112/h) | $8.18 |
| EBS gp3 root 10 GB ($0.0912/GB) | $0.91 |
| Public IPv4 address ($0.005/h) | $3.65 |
| RDS db.t4g.micro Single-AZ ($0.021/h) | $15.33 |
| RDS gp3 storage 20 GB ($0.131/GB) | $2.62 |
| RDS backups within allocated storage | $0.00 |
| Secrets Manager, 3 secrets ($0.40 each) | $1.20 |
| S3, CloudWatch Logs, data transfer, budget | $0.00 |
| **Total** | **$31.89** |

- **Account opened before 15 July 2025:** EC2, EBS, the IPv4 address and RDS
  all fall inside the 12-month free tier; expect about $1.20/month.
- **Account opened after that:** AWS grants $100 to $200 of credits over 6
  months instead, covering this build for roughly 3 to 6 months.
- **Cheapest paid variant:** an arm64 t4g.micro ($0.0056/h) brings the total to
  $27.80/month. The default stays t3.micro for free-tier eligibility.
- **Not included:** Gemini API usage and the domain, which the owner already
  holds.

## Phases

1. Repo bootstrap: `git init`, CDK app, jest, this document.
2. Data stack: VPC, RDS, the three secrets with exactly the JSON keys the
   config loader expects.
3. App stack: instance role, security groups, instance with cloud-init, Elastic
   IP, Caddy and systemd configuration, artifacts bucket, GitHub deploy role,
   budget, outputs.
4. GitHub OIDC provider stack.
5. Scripts: `deploy.sh` (manual deploy, same contract as CI) and
   `set-llm-key.sh` (one-time API key install).
6. Tests: CDK assertion tests (no NAT, RDS private, IMDSv2, security group
   rules, secret names and keys, bucket private, role trust), `cdk synth`,
   cdk-nag.
7. Docs: README runbook and `deployment-architecture.md`.
8. Backend PR (parallel): CORS middleware and config, `ci.yml`, `deploy.yml`,
   ADR, STATUS.md.

## Risks

- **Memory on 1 GB.** Rasterising a scanned CV at 150 DPI is the heaviest
  thing the binary does. Swap mitigates it; t3.small is about $8/month more.
- **Public exposure before the backend is ready.** `POST /orgs` is open and
  login has no rate limiting (both recorded in STATUS.md).
- **The `dev/llm` secret.** After the owner sets the API key, a later change to
  that secret's template in the stack would regenerate it. Models are edited in
  the secret, not in the stack.
- **Free-tier uncertainty.** Whether RDS is free depends on the account's plan.
- **Certificate before DNS.** If the A record is not in place when the instance
  first boots, Caddy keeps retrying the ACME challenge on its own.
- **AWS MCP server** failed to connect in the planning session; deploys use the
  AWS CLI after `aws sso login`.

## Values the owner supplies before the first deploy

- The API hostname on the Namecheap domain (for example `api.<domain>`).
- An email for Let's Encrypt expiry notices and for the budget alert.
- The Amplify origin(s) to allow for CORS.
- The AWS account id and profile to deploy with.

## Out of scope for this MVP

A `prod` environment and its migration runner, Multi-AZ, WAF, alerting beyond
the budget, VPC flow logs, secret rotation, a custom domain for Amplify.
