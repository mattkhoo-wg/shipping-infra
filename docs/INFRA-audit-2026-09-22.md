# Infra audit: what `shipping-infra` needs to catch up on

> Superseded 2026-09-30: gaps 1 to 4 and 6 are closed (see `INFRA.md`); 5, 7,
> 9 and 10 remain as recorded there and in the backend's `docs/STATUS.md`.

Read-only audit, 2026-09-22. Scope: `shipping-infra` (branch `main`, last commit
`2bfec87` 2026-09-07, 11 commits ahead of `origin/main`, one untracked file
`docs/INFRA.md`), `backend` (branch `feat/credential-report`, HEAD `7a6edf8`
2026-09-22, working tree has uncommitted changes touching the credential-report
and extraction-cache work), `frontend` (branch `feat/credential-report`, HEAD
`c258dff` 2026-09-22, clean).

**Headline finding: the infra repo already knows most of this.** Its own
`docs/INFRA.md`, dated 2026-09-18, is a self-maintained gap list between what
`shipping-infra` renders and what the backend's config loader requires. I
re-verified every line of it against the current `lib/*.ts` and confirmed it is
still accurate as of today — nothing in `shipping-infra` has changed since
2026-09-18 to close any of those gaps, and nothing in the backend's
`feat/credential-report` work opens a new one (the credential-report feature
adds only a Postgres table via migration `0018`, which the existing
apply-at-boot goose runner already covers). What this audit adds: confirmation
against the live IaC code rather than the doc's own word, the frontend side
(which `INFRA.md` only partly covers), and one gap `INFRA.md` does not mention
at all (the deployed Amplify app's environment variables, per
`docs/operator-guide.md`).

## 1. What the infra repo currently provisions and documents

`shipping-infra` is an AWS CDK v2 (TypeScript) app, not raw Terraform or
CloudFormation, though `cdk synth` emits CloudFormation underneath. One
environment (`dev`, the only one deployed) is one `t3.micro` EC2 instance
running the backend binary behind Caddy for TLS, one `db.t4g.micro` RDS
Postgres 16, three Secrets Manager secrets, an S3 artifacts bucket, a Route 53
hosted zone, a GitHub OIDC deploy role and a budget alert, all in `us-east-2`.
Four stacks: `crewreg-github-oidc` (account-level), `crewreg-dns`, and per
environment `crewreg-<env>-data` (VPC, RDS, secrets) and `crewreg-<env>-app`
(instance, artifacts bucket, deploy role, budget). Documentation is unusually
thorough and largely current: `README.md` is an operator runbook,
`docs/deployment-architecture.md` is the as-built record (dated 2026-09-06,
matches the code I read), `docs/deployment-plan.md` is the superseded original
plan (Mumbai region, kept for history), `docs/operator-guide.md` is a
day-two-ops guide, and the untracked `docs/INFRA.md` is the gap-tracking doc
described above. The frontend is **not** in this repo at all — it is a
separately-managed AWS Amplify app (`shipping-frontend`, `d1uy4g8hfjj6fp`,
`us-east-2`) built from the frontend repo's own `main` branch, configured
through the Amplify console, outside any file `shipping-infra` or `frontend`
tracks.

| Component | Provisioned by | Notes |
|---|---|---|
| VPC, 2 public + 2 isolated /24 subnets, no NAT | `lib/data-stack.ts` | Public subnet holds the instance; isolated holds RDS |
| RDS Postgres 16, `db.t4g.micro`, Single-AZ, 20 GiB gp3 | `lib/data-stack.ts` | `sslmode=require` outside local; 7-day backups; deletion protection only for `prod` |
| Secrets Manager: `<env>/database`, `<env>/auth`, `<env>/llm` | `lib/data-stack.ts` | JSON keys match the backend's config struct tags exactly; `auth` holds only `signing_key` |
| EC2 `t3.micro`, Amazon Linux 2023, Elastic IP | `lib/app-stack.ts` + `lib/user-data.ts` | Runs Caddy (TLS) + the `crewreg` systemd unit; IMDSv2 required; no SSH, SSM only |
| S3 artifacts bucket (`server/<sha>/server`) | `lib/app-stack.ts` | Releases only — this is **not** the CV storage bucket, which does not exist |
| Route 53 hosted zone `aucto.io` | `lib/dns-stack.ts` | Shared by the API's `A` record and Amplify's own records |
| GitHub OIDC provider + per-env deploy role | `lib/github-oidc-stack.ts`, `lib/app-stack.ts` | Scoped to one repo, one GitHub Environment, one SSM document, one command |
| CloudWatch Logs, 14-day retention | `lib/app-stack.ts` | Server log + Caddy access log |
| AWS Budget, account-wide | `lib/app-stack.ts` | $40/month for `dev`, email at 80% actual / 100% forecast |
| CDK context / non-secret settings | `cdk.json` | `dev` block: `us-east-2`, `api-dev.aucto.io`, CORS origin `https://app.aucto.io`, LLM provider `gemini` + models, extract tunables |

Cost is about $27–32/month; no `prod` environment exists yet (deliberately —
the backend has no migration runner for `prod` and no erasure/retention/audit
path for PII).

## 2. Backend deployment requirements, as the code now stands

### Config keys

Read from `backend/config/config.go` (validated struct) and
`backend/config/config.example.yaml` (reference). `CONFIG_PATH` is the **only**
environment variable the binary reads (default `config.yaml`); everything else
comes from the YAML file at that path, with the secret-bearing sections
replaced from AWS Secrets Manager outside `local`.

| Key | Where read | Secret? | What fails at boot if wrong/missing |
|---|---|---|---|
| `environment` | file | no | unknown value (not `local`/`dev`/`staging`/`prod`) → refuses to start |
| `region` | file | no | empty defaults to `ap-south-1`; wrong value can't reach Secrets Manager or the real region's S3/SES |
| `llm.provider`, `llm.api_key`, `llm.text_model`, `llm.vision_model` | secret `<env>/llm` | **yes** (`api_key`) | any of the four empty → `"<path> is required"`; unknown provider → rejected |
| `llm.max_tokens`, `llm.thinking_budget` | secret `<env>/llm` | part of secret | defaults to 8192 if unset; `thinking_budget` unset omits the field (Gemini-only) |
| `database.host`, `.user`, `.dbname` | secret `<env>/database` | **yes** (incl. `.password`) | any of the three empty → boot refusal; `.password` is allowed empty (local trust auth only) |
| `database.port` | secret | secret-adjacent | must be positive |
| `auth.signing_key` | secret `<env>/auth` | **yes** | empty → refused; must be ≥32 bytes (`jwt.MinSigningKeyBytes`) or the issuer construction fails |
| `auth.bff_shared_key` | secret `<env>/auth` | **yes**, optional | empty → every visitor shares one rate-limit bucket (no boot failure); non-empty but <32 bytes → boot refusal |
| `cors.allowed_origins` | file | no | empty/omitted disables CORS entirely (not a boot failure, but a silent CORS lockout for the frontend) |
| `extract.min_text_chars`, `.vision_dpi`, `.max_vision_pages` | file | no | defaults 100/150/8; must be positive if set |
| `storage.bucket` | file | no | **required** — empty → boot refusal ("storage.bucket is required") |
| `storage.region`, `storage.endpoint` | file | no | region defaults to top-level `region`; `endpoint` is for MinIO only |
| `rate_limit.per_minute`, `.burst` | file | no | defaults 20/10; must be positive if set |
| `mail.provider`, `mail.from` | file | no | **required** — `provider` must be `ses` or (local-only) `stdout`; `stdout` outside `local` → boot refusal; invalid `from` address → boot refusal |
| `mail.region` | file | no | defaults to top-level `region` |
| `public.base_url` | file | no | **required** — must be a bare `scheme://host[:port][/path]` with no query/fragment/credentials, or boot refusal |
| `credentials.expiring_within_days` | file | no | defaults 90; must be positive if set |
| `credentials.registry.enabled`, `.base_url`, `.allow_plaintext`, `.timeout_seconds` | file | no | `enabled` defaults `false` (DG Shipping registry lookups stay off); `timeout_seconds` defaults 15 |

Boot-time check order (from `docs/INFRA.md`, matches `cmd/main.go`): config
file present and valid → the three secrets fetched and parsed → Postgres
reachable (+ migrations outside `prod`) → `HeadBucket` on `storage.bucket` →
the SES identity for `mail.from` verified for sending.

### Migrations

18 migrations exist, `common/db/migrations/0001_orgs_users_seafarers.sql`
through `0018_credential_reports.sql`, applied via embedded goose
(`common/db/db.go`, `//go:embed migrations/*.sql`, `goose.Up`). Applied
**automatically at boot for every environment except `prod`**
(`common/db/db.go:43`, `if cfg.Environment != "prod"`); idempotent, so a
redeploy that adds no new migration is a no-op. **`prod` has no migration
runner at all** — this is a known, already-flagged gap (both `INFRA.md` and
`README.md`'s "A second environment" section call it out); a `prod`
environment cannot exist until one is built. Migration `0018` adds
`credential_reports` (PK `(org_id, seafarer_id)`, FK to `org_seafarers` ON
DELETE CASCADE) — nothing infra-side is needed for it beyond Postgres being
reachable at boot, which is already provisioned.

### External services

- **Postgres** — provisioned (RDS), reachable, `sslmode=require` enforced by both the secret and the backend.
- **Object storage (S3)** — **required by the code, not provisioned.** `storage.bucket` has no default and the backend refuses to boot without it; `renderConfigYaml` in `lib/user-data.ts` never writes a `storage:` section, no CV bucket exists in `lib/app-stack.ts`/`lib/data-stack.ts`, and the instance role has no `s3:PutObject`/`GetObject`/`HeadBucket` grant beyond the artifacts bucket (`server/*` only).
- **SES mailer** — **required, not provisioned.** `mail.provider`/`mail.from` are required config; nothing writes a `mail:` section into the rendered config, and the instance role has no `ses:SendEmail`/`ses:GetEmailIdentity` grant. No SES identity exists for the sending domain, and even once one does, the AWS account's SES is in sandbox (delivers only to verified addresses).
- **LLM provider (Gemini)** — provisioned via `<env>/llm` secret; `cdk.json` and `config.example.yaml` agree on provider and model names. Reached directly over the internet (no NAT needed, public subnet).
- **DG Shipping credential registry** — deliberately **off** by default (`credentials.registry.enabled: false`), matching the code's own safe default; nothing in infra needs to change to keep it off, and nothing currently turns it on.

### Ports, health, shutdown

- Binary listens on `:8080` (`serverAddr` in `backend/cmd/main.go`), plain HTTP, bound to loopback in practice since only Caddy on the same host reaches it (port 8080 is never opened in the security group).
- Caddy terminates TLS on 80/443 and reverse-proxies to `127.0.0.1:8080`; matches `instance/Caddyfile` and the "API instance" security group (80/443 from `0.0.0.0/0`, nothing else inbound).
- Health endpoint: `GET /ping` (`backend/api_service/handlers/health/ping.go`), answers `pong`, touches nothing — used both as the deploy script's readiness probe and (per the architecture doc) the only liveness check that exists; there is no alarm or uptime check on it.
- Graceful shutdown: `signal.NotifyContext` on `SIGINT`/`SIGTERM`, 15 s grace (`shutdownTimeout` in `main.go`) before `srv.Shutdown`; the systemd unit's `TimeoutStopSec=20` gives it room to finish before SIGKILL.

### Statefulness: the two in-process caches

- **Extraction cache** (`api_service/cvintake.Cache`, ADR 0040, `github.com/jellydator/ttlcache/v3`): capacity 500, TTL 24 h, `WithDisableTouchOnHit` (a read never extends the TTL), LRU eviction past capacity, started/stopped in the composition root's own goroutine. **Entirely in-process and lost on restart or redeploy.** Only the applicant CV re-review routes populate it; the organisation's own CV upload never caches. This makes the service **stateful in a soft sense**: a second instance, or an instance replaced mid-session, gets a cold cache (a cache miss just re-runs the extraction, so this is a cost/latency effect, not a correctness one) — but it means a future multi-instance `dev`/`prod` needs either sticky routing or acceptance of a lower hit rate, since there is no shared cache today.
- **Rate limiter** (`backend/ratelimit`, ADR 0034, `x/time/rate`): in-process token bucket per client address, map capped at 100,000 keys, idle keys evicted after a full refill period. `rate_limit.per_minute`/`burst` default 20/10. Same statefulness implication: multiple instances behind a shared address would each enforce their own bucket, effectively multiplying the limit.

Neither cache is persisted or shared; both are reasons a horizontally-scaled
deployment is a bigger change than adding instances, which the architecture
doc already flags under "Known gaps, on purpose" (single instance, no
health-based replacement).

## 3. Frontend deployment requirements

### Environment variables (all server-only, none may ever gain `NEXT_PUBLIC_`)

| Variable | Secret? | Required to run at all? | Effect if unset |
|---|---|---|---|
| `CREWREG_API_URL` | no (but not for the client bundle) | **yes** | `readBackendConfig()` throws — every proxy route fails |
| `CREWREG_BFF_KEY` | yes | no | `bffHeaders()` sends nothing; the backend rate-limits every applicant visitor as one shared bucket instead of per-visitor (matches backend's `auth.bff_shared_key`) |
| `CREWREG_WEBHOOK_SECRET` | yes | no | `POST /api/webhooks/verification` answers 503 and accepts nothing |

Source of truth: `frontend/.env.example`, `frontend/README.md`
("Configuration" table), `frontend/src/lib/server/backend.ts` and
`frontend/src/lib/server/public-backend.ts`. There is **no** `CREWREG_ORG_ID`
any more (deliberately removed — see invariant 2 in the frontend's
`CLAUDE.md`); infra or operator docs that still mention it are stale.

### Build, start, Node, ports

- `npm run build` → `next build`; `npm run start` → `next start`; `npm run dev` → `next dev` (Turbopack). `npm test` → `vitest run`; `npm run e2e` → `playwright test` against `e2e/fake-backend.mjs` (never the live backend — Playwright needs `npx playwright install chromium` once per machine/CI).
- `package.json` has no `engines` field and the repo has no `.nvmrc`; the only Node version guidance is `frontend/README.md`'s prose, "Requires Node 20+." No frontend `.github/workflows` exist in this repo to pin a CI Node version either.
- Dev server: port 3000, and "Next picks the next free port if 3000 is taken" (README) — no hard port lock. Production: the deployed instance is an Amplify-managed SSR compute target, not a bare `next start` on a fixed port that this repo controls; Amplify owns the actual listening port.

### The BFF pattern

The browser never reaches the Go backend directly — every call goes through a
Next.js Route Handler under `src/app/api/`, which attaches either the org
session's bearer token (from the `httpOnly` session cookie) or, for
`/api/apply/*`, the BFF key (`X-Crewreg-Bff-Key`) plus the visitor's forwarded
address (`X-Crewreg-Client-Ip`) so the backend's rate limiter can attribute
requests per visitor instead of per this server's one address (backend ADR
0034). For this to work end to end, the backend's CORS `cors.allowed_origins`
must include the frontend's origin (currently `https://app.aucto.io`, matched
in `cdk.json`) and `auth.bff_shared_key` must equal `CREWREG_BFF_KEY` — the
latter half is not currently possible because `bff_shared_key` does not exist
in the `dev/auth` secret at all (see Gaps, below).

### Cookies

Two `httpOnly` cookies, set only by this app's own Route Handlers, never
returned in a response body or logged: the session cookie (org users, set by
`/api/auth/login`) and `crewreg_applicant` (set only by
`/api/apply/applications/[application_id]/verify`, scoped to `/api/apply`,
lives for the applicant token's one hour). Both assume HTTPS in front of this
app in any deployed environment (the design doesn't set `Secure` conditionally
in code I read beyond Next's own cookie defaults, but the whole architecture —
Caddy terminating TLS for the API, Amplify terminating TLS for the frontend —
assumes HTTPS everywhere outside local dev).

### The webhook receiver

`src/app/api/webhooks/verification/route.ts` exists, is wired to
`src/lib/server/verification-bus.ts` (subscribers only, never a stored
result) and `src/lib/cv/watch.ts`, and is documented in `.env.example` /
`README.md` as receiving HMAC-SHA256-signed callbacks from the Go backend
(`src/lib/server/webhook-signature.ts`: `sha256=` prefix over
`${timestamp}.${body}`, 300 s tolerance window, matching the task
description). **I found no code anywhere in the backend repo that sends a
webhook** (`grep -rn "[Ww]ebhook"` across all backend `.go` files returns
nothing), and `docs/STATUS.md` never mentions one. The backend's current
design for "how does the frontend learn a verification changed" is the
credential-report feature just built (ADR 0041): a stored, read-on-request
report, not a push. My read is that this receiver is either a planned surface
that was scaffolded ahead of the sender, or a leftover from an earlier design
that ADR 0040/0041 superseded — either way, right now it is dead code from
the backend's side: the endpoint 503s without `CREWREG_WEBHOOK_SECRET`, and
even with the secret set, nothing will ever call it. This doesn't block a
deploy (nothing depends on it firing), but the owner should decide whether to
finish it, remove it, or leave it dormant before treating "the webhook
receiver the backend must be able to reach" as a real infra requirement — see
Open Questions.

## 4. Gaps

One row per mismatch between what `shipping-infra` documents/provisions and
what the current code needs. Severity mirrors `docs/INFRA.md`'s own framing:
the first four are boot-blocking for `dev` today.

| # | Gap | Infra file to change | App-repo source of truth |
|---|---|---|---|
| 1 | No `storage:` section rendered into `/etc/crewreg/config.yaml`; no CV S3 bucket provisioned; instance role has no `s3:PutObject`/`GetObject`/`HeadBucket` on a CV bucket | `lib/user-data.ts` (`renderConfigYaml`), `lib/app-stack.ts` (new bucket + IAM grant), `lib/config.ts` (add a `storage` field to `EnvironmentConfig`) | `backend/config/config.go` (`StorageConfig`, required), `backend/config/config.example.yaml` |
| 2 | No `mail:` section rendered; no SES identity for the sending domain; instance role has no `ses:SendEmail`/`ses:GetEmailIdentity` | `lib/user-data.ts`, `lib/app-stack.ts` (SES identity + IAM grant), `lib/config.ts` | `backend/config/config.go` (`MailConfig`, required), `common/mailer/ses.go` |
| 3 | No `public:` section rendered (`public.base_url`) | `lib/user-data.ts` (`renderConfigYaml`), `lib/config.ts` (add `apiHost` counterpart for the frontend origin) | `backend/config/config.go` (`PublicConfig`, required), `backend/requisition_service` (composes `public_url`) |
| 4 | `<env>/auth` secret holds only `signing_key`; no `bff_shared_key` | `lib/data-stack.ts` (`AuthSecret`'s `secretStringTemplate`) | `backend/config/config.go` (`AuthConfig.BFFSharedKey`), `backend/docs/decisions/0034-rate-limiting-and-the-bff-client-address.md` |
| 5 | SES account/region still in sandbox (only verified addresses can receive mail) | not a CDK change — an AWS Support request for production access, then update `docs/operator-guide.md`/`docs/INFRA.md` to record it | `backend/config/config.go` `validateMail` (rejects `stdout` outside local, so SES is the only path) |
| 6 | `docs/operator-guide.md` §8 ("The frontend") documents only `CREWREG_API_URL` as an Amplify console env var; the frontend also needs `CREWREG_BFF_KEY` and, if the webhook receiver is kept, `CREWREG_WEBHOOK_SECRET` | `docs/operator-guide.md` §8 (doc-only; also means the *live* Amplify app is very likely actually missing these two vars) | `frontend/.env.example`, `frontend/README.md` "Configuration" table |
| 7 | `prod` has no migration runner; `common/db/db.go` skips migrations entirely when `environment == "prod"` | `README.md` "A second environment" already flags this correctly — no infra code exists to add a runner yet; tracked, not silently missing | `backend/common/db/db.go`, `backend/docs/STATUS.md` ("dev IS DEPLOYED" entry, prod caveat) |
| 8 | `docs/deployment-plan.md`'s region (`ap-south-1`) and its "Seams" config sample are the superseded plan, not the as-built state; a reader skimming only that file would render the wrong region | none needed if read in order (the doc says the architecture doc wins), but worth a pointer note at the top | `docs/deployment-architecture.md` (as-built, `us-east-2`), `cdk.json` |
| 9 | The webhook receiver's dependency (a signed callback from the backend) has no sender anywhere in the backend, so "the network path the backend must reach the frontend over" has no current requirement — but `frontend/.env.example`/`README.md` present `CREWREG_WEBHOOK_SECRET` as a real, load-bearing config item | none — this is a cross-repo contract question, not an infra provisioning gap, until the owner decides the feature's fate (see Open Questions) | `frontend/src/app/api/webhooks/verification/route.ts`, `frontend/src/lib/server/verification-bus.ts`, `backend/docs/decisions/0040-*.md`, `0041-*.md` |
| 10 | The extraction cache (ADR 0040) and the rate limiter (ADR 0034) are per-process, in-memory state; nothing in `shipping-infra` documents this as a reason to stay single-instance, though the architecture doc separately calls out "single instance, no health-based replacement" for other reasons | `docs/deployment-architecture.md` "Known gaps, on purpose" (add the cache/limiter as an explicit reason, not just an instance-availability one) | `backend/docs/decisions/0040-the-extraction-is-cached-in-memory.md`, `backend/ratelimit/limiter.go` |

## 5. Open questions for the owner

- **Single instance vs. a shared cache/limiter.** Gap #10: if `dev` (or a
  future `prod`) ever runs more than one instance behind a load balancer, the
  extraction cache's hit rate and the rate limiter's bucket both silently
  fragment per instance. Is single-instance-forever the accepted design, or
  does a second instance need sticky routing / a shared store (Redis, or
  moving the limiter to a shared table) before it's added?
- **Where is the BFF key minted and distributed?** `auth.bff_shared_key`
  doesn't exist in the `dev/auth` secret today (gap #4). Once it's added,
  someone has to generate it, put it in the secret, and put the *same* value
  into the Amplify console as `CREWREG_BFF_KEY` — two manual steps outside any
  automation this repo has (`scripts/set-llm-key.sh` is the existing pattern
  for exactly this kind of one-time secret install; does this need a sibling
  script, e.g. `scripts/set-bff-key.sh`?).
- **SES sandbox vs. production.** Gap #5: is the AWS Support request for
  production access already filed, or does the owner want to keep `dev` in
  sandbox and only test with verified addresses for now? This blocks any
  applicant who isn't a verified SES address from receiving their
  verification code.
- **S3 vs. MinIO for `storage`.** The backend supports both (`storage.endpoint`
  for MinIO/LocalStack, used only in local dev per `docs/INFRA.md`). For the
  new CV bucket infra needs to provision, is a plain private S3 bucket (as the
  artifacts bucket already is) the intended shape, or does the owner want
  MinIO considered for a non-AWS environment?
- **The webhook receiver's fate.** Gap #9: finish it (build the backend sender
  the spec §3.3 the frontend code cites implies), remove it (delete the dead
  route, the bus, and the env var from the frontend), or leave it dormant on
  purpose as a not-yet-built feature? This changes whether `CREWREG_WEBHOOK_SECRET`
  belongs in the "required for a real deploy" column at all.
- **`prod`'s migration runner.** Already tracked in both repos as an open
  item (gap #7) — is it in scope before or after the credential-report /
  extraction-cache work ships, or is `dev` the only target for the
  foreseeable future?
