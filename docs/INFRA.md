# What the backend needs from infrastructure

The contract between the backend binary and whatever runs it. The other half
lives in `docs/deployment-architecture.md` (the stacks as built); this page is
what the backend requires, per environment, and the record of where the two
sides drifted and how the drift was closed. The backend repo carries an
identical copy at `docs/INFRA.md`; change both.

## The gap, closed on 2026-09-30

Between 2026-09-14 and 2026-09-18 the backend grew five boot-time requirements
that `shipping-infra` did not render, so a deploy of `dev` failed its health
check and rolled back. Each is now provisioned by `lib/app-stack.ts` and
`lib/user-data.ts`, except the SES sandbox, which is an AWS Support request:

| Need | Since | Provisioned by |
|---|---|---|
| `storage.bucket` in the config file; `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` (for `HeadBucket`) on it for the instance role | ADR 0028 (CV archival) | the `CvDocuments` bucket in the app stack, private, TLS-only, retained on destroy; `renderConfigYaml` writes its name; `grantRead` + `grantPut`, no delete |
| `mail.provider: ses` and `mail.from`; `ses:SendEmail` and `ses:GetEmailIdentity`; a verified SES identity for the sender's domain | T3 (2026-09-14) | `mailFrom` in `cdk.json`; an SES domain identity for its domain with the three DKIM CNAMEs written into the hosted zone, so SES verifies it on its own |
| `public.base_url` | T2 (2026-09-14) | `frontendOrigin` in `cdk.json` |
| `auth.bff_shared_key` in the `<env>/auth` secret, and the same value in the frontend's `CREWREG_BFF_KEY` | T1 (2026-09-14) | `scripts/set-bff-key.sh <env> <amplify-app-id>`: mints the key, merges it into the secret, sets the Amplify variable |
| SES out of the sandbox for the account and region | T5 (2026-09-15) | **still open.** `aws sesv2 put-account-details` (or the console) to request production access; until then SES delivers only to verified addresses |

The domain moved at the same time: `api-dev.trynilla.com` for the API,
`app.trynilla.com` for the frontend, the apex reserved for the marketing site.
`aucto.io` stays as a Route 53 zone (the `crewreg-dns` stack) but nothing
deploys to it any more.

## Environments

`environment` in the config file is `local`, `dev`, `staging` or `prod` and is
rejected otherwise. It decides three things:

- **Where secrets come from.** `local` reads them from the file. Every other
  value fetches the `llm`, `database` and `auth` sections from AWS Secrets
  Manager as `<environment>/<section>` and ignores what the file holds for
  them.
- **Whether migrations run at boot.** Every environment but `prod` applies the
  embedded goose migrations on startup. **Prod does not, and nothing else does
  yet**: the first prod deploy needs a migration step that does not exist.
- **The logger.** `local` is a console encoder at debug; everything else is
  JSON at info.

## The config file, section by section

`/etc/crewreg/config.yaml`, read via `CONFIG_PATH`, the only environment
variable the binary reads. `backend/config/config.example.yaml` is the
reference with every comment. What each deployed environment needs written into
the file, and what comes from Secrets Manager instead:

| Section | From | Required | Notes |
|---|---|---|---|
| `environment`, `region` | file | yes | `region` is the Secrets Manager region and the default for `storage.region` and `mail.region` |
| `llm` | secret `<env>/llm` | yes | `provider`, `api_key`, `text_model`, `vision_model`, `max_tokens`; numeric values typed as strings in the console are tolerated |
| `database` | secret `<env>/database` | yes | `host`, `port`, `user`, `password`, `dbname`; `sslmode` defaults to `require` outside local |
| `auth` | secret `<env>/auth` | yes | `signing_key` (at least 32 random bytes; rotating it logs everyone out) and `bff_shared_key` (at least 32 bytes when set) |
| `cors.allowed_origins` | file | no | the frontend's origin(s), scheme and host only; empty turns CORS off |
| `extract` | file | no | defaults exist |
| `storage` | file | **yes** | `bucket`; `region` optional; `endpoint` for MinIO only. Credentials from the AWS chain, never the file |
| `rate_limit` | file | no | `per_minute` 20, `burst` 10 by default; per client address |
| `mail` | file | **yes** | `provider: ses`, `from`; `stdout` is refused outside local. Credentials from the AWS chain |
| `public` | file | **yes** | `base_url`: the frontend origin, no trailing slash; every public link is composed under it |
| `credentials` | file | no | `registry.enabled` stays `false` unless the DG Shipping lookups are wanted (ADR 0031: plaintext HTTP, document numbers and dates of birth cross the internet in clear) |

The dev file as `shipping-infra` renders it (the bucket name is the one the
stack generated):

```yaml
environment: dev
region: us-east-2
extract:
  min_text_chars: 100
  vision_dpi: 150
  max_vision_pages: 8
cors:
  allowed_origins:
    - https://app.trynilla.com
storage:
  bucket: crewreg-dev-app-cvdocuments<suffix>
mail:
  provider: ses
  from: "no-reply@trynilla.com"
public:
  base_url: https://app.trynilla.com
```

## AWS resources per environment

| Resource | Purpose | Instance role needs |
|---|---|---|
| RDS Postgres 16 | the one database | network reachability; credentials via the `<env>/database` secret |
| Secrets Manager: `<env>/database`, `<env>/auth`, `<env>/llm` | the three secret sections | `secretsmanager:GetSecretValue` on each |
| S3 bucket for CVs (`storage.bucket`) | every uploaded CV, applicant or employee, archived before extraction | `s3:PutObject`, `s3:GetObject` (T8 reads them back), `s3:ListBucket` for the `HeadBucket` boot check |
| SES v2, an identity for the sending domain with DKIM, out of sandbox | the six-digit codes the applicant flow emails | `ses:SendEmail`, `ses:GetEmailIdentity` (the boot check) |
| S3 artifacts bucket | releases, `server/<sha>/server` | read, already granted |
| CloudWatch log groups | server and Caddy logs | write, already granted |
| SSM document `crewreg-<env>-deploy` | the deploy button | already granted to the deploy role |

**The CV bucket must be private and versioning is optional.** Object keys are
`org/<org_id>/cv/<cv_upload_id><ext>` and never contain a filename. Nothing
deletes from it: there is no erasure path yet, and ADR 0038 keeps every
applicant upload. Plan for it to grow. The instance role is deliberately not
granted `s3:DeleteObject`.

**SES sandbox.** In the sandbox, SES delivers only to verified addresses, so a
real applicant never receives a code. Request production access for the account
and region before dev is shown to anyone outside the team. The boot check only
proves the identity is verified, not that the sandbox is off.

**One SES identity per domain per region.** The app stack creates the identity
for `mailFrom`'s domain, so two environments in the same region cannot share a
sender domain; give the second a subdomain such as `no-reply@staging.trynilla.com`.

## The frontend's side

Next.js on Amplify, `app.trynilla.com`, calling the API server-side through
`CREWREG_API_URL`. Two things it must carry from this series:

- **`CREWREG_BFF_KEY`**, equal to `auth.bff_shared_key`. Its `/api/apply/...`
  proxies send `X-Crewreg-Bff-Key: <key>` and
  `X-Crewreg-Client-Ip: <visitor address>` on every request to the backend, or
  every applicant shares one rate-limit bucket. Loopback (Caddy) is the only
  trusted proxy on the backend, so `X-Forwarded-For` is not read. Amplify
  exposes console variables to the build only, so the build spec must copy it
  into `.env.production` alongside `CREWREG_API_URL`.
- **The `/apply/{org_slug}/{token}` page**, because that is the shape
  `public.base_url` composes links under. The route-by-route contract is
  `docs/api/requisitions-and-applicants.md` in the backend repo.

## The deploy path (unchanged by the series)

`Deploy` workflow: build a static linux/amd64 binary, upload it to the
artifacts bucket under `server/<sha>/`, point `server/current` at it, send the
`crewreg-<env>-deploy` SSM document to instances tagged
`crewreg:env=<env>` and `crewreg:role=api`, wait, then `GET /ping` through
the public hostname. `crewreg-deploy` on the instance verifies the checksum,
flips the symlink, restarts the service, checks `/ping` locally and rolls back
on failure. The deploy role can send that one document and nothing else.

Prod deploys only from `main`. `main` still lags `dev`, and the migration
step for prod is the open item above.

## Boot-time checks, in order

A deployed binary refuses to start, with a structured log line, when any of
these fail. They are the quickest way to find a config or IAM mistake:

1. Config file present and every required section valid (`public.base_url` a
   URL, `mail.provider` allowed for the environment, `auth.signing_key` long
   enough).
2. The three secrets fetched and parsed.
3. Postgres reachable, and outside prod the migrations applied.
4. `HeadBucket` on the CV bucket.
5. The SES identity for `mail.from` verified for sending.

## Local development

`docker compose -f common/db/docker-compose.yml up -d` for Postgres (and MinIO
if the file includes it), `config.yaml` at the repo root with `environment:
local`, `mail.provider: stdout` so codes print to the console, and
`storage.endpoint: http://localhost:9000` for MinIO. Migrations apply on boot.
