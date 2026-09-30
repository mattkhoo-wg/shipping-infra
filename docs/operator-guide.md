# Operator guide: running crewreg

Everything an administrator does to a deployed environment, in one place.
Written for `dev` on 2026-09-07; a second environment works the same way with
its own name in place of `dev`. Architecture and reasons live in
`deployment-architecture.md`; this file is the how.

Commands run from the `shipping-infra` folder in Git Bash on Windows (or any
POSIX shell). They need the AWS CLI, Node.js, and `gh` for anything touching
GitHub.

## 1. Signing in

Every AWS command uses the `crewreg` profile, which holds short-lived
credentials from a browser sign-in:

```bash
aws login --profile crewreg          # opens the browser; sign in to account 200845568969
export AWS_PROFILE=crewreg           # once per shell, or prefix each command
aws sts get-caller-identity          # proves it worked
```

The sign-in lasts a few hours. The symptom of an expired one is
`authorization grant is invalid, expired, revoked` on any command; run
`aws login --profile crewreg` again. The profile's default region is
`us-east-2`, and the scripts read the region from `cdk.json` regardless.

Signing in as the account root works but is not the long-term identity: create
an IAM user with `AdministratorAccess` plus `SignInLocalDevelopmentAccess`
and sign in as that instead.

## 2. Accounts: organisations and users

There is no sign-up. Accounts are created by an operator with the backend's
`server admin` command, which `scripts/admin.sh` runs on the instance over
SSM. The command uses the deployed release, its config and the instance role,
so it reaches the private database without any credential leaving AWS
(backend ADR 0023).

### Add an organisation

```bash
scripts/admin.sh dev create-org --name "Blue Anchor Crewing"
# org_id=3f9c...  org_name=Blue Anchor Crewing
```

Keep the `org_id`; users are created against it. `list-orgs` recovers it
later.

### Add a user

```bash
scripts/admin.sh dev create-user --org-id <org_id> --email ops@example.com --generate-password
# user_id=...  org_id=...  email=ops@example.com
# password=<24 characters, printed once>
```

`--generate-password` prints the password once and nowhere else. SSM Run
Command keeps command output in its history for 30 days, so treat that history
as sensitive. For an account that matters, open a shell on the instance
(section 5) and use `--password-stdin` so the password never passes through
SSM:

```bash
printf '%s' 'the-password' | sudo CONFIG_PATH=/etc/crewreg/config.yaml \
  /opt/crewreg/current/server admin create-user --org-id <org_id> --email ops@example.com --password-stdin
```

Rules: the email must be a valid address and unique across the platform (a
duplicate is refused with `a user with that email already exists`); the
password must satisfy the backend's length rules (8 characters minimum). The
password is bcrypt-hashed before it reaches the database and never appears in
logs.

### List organisations

```bash
scripts/admin.sh dev list-orgs
# org_id=...  org_name=Alpha Crewing  created_at=2026-09-07T19:06:30Z
```

### Add a user through the API instead

A logged-in member of an organisation can add a colleague without an
operator. Their token scopes the call to their own organisation; a mismatched
`org_id` in the path is a 404.

```bash
API=https://api-dev.trynilla.com
TOKEN=$(curl -s -X POST $API/login -H 'Content-Type: application/json' \
  -d '{"email":"alpha.owner@aucto.io","password":"..."}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).token))')

curl -s -X POST $API/orgs/<org_id>/users -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"email":"new.person@example.com","password":"their-password"}'
```

### What does not exist yet

No password change, no password reset, no user list, no user or organisation
deletion, no role beyond "member". `POST /orgs` is still an open route that
creates an organisation with no user in it; leave it alone. These belong to
the admin portal. Until then, a forgotten password means creating a new user
with a new address.

### Current dev accounts

Created 2026-09-07 for testing that a seafarer is shared between organisations
correctly. Passwords were handed to the owner and are not recorded here.

| Organisation | org_id | Users |
|---|---|---|
| Alpha Crewing | `df70e53f-b450-4640-95f3-ac33217608cb` | `alpha.owner@aucto.io`, `alpha.staff@aucto.io` |
| Beta Manning | `510c733e-1a61-4d0a-a41e-2648ea04d331` | `beta.owner@aucto.io`, `beta.staff@aucto.io` |

## 3. The API, for reference

Base URL `https://api-dev.trynilla.com`. Every route except the first three needs
`Authorization: Bearer <token>` from `POST /login`; a token lasts 8 hours and
carries the organisation it acts for, which nothing in a request can override.

| Method | Path | Token | What |
|---|---|---|---|
| `GET` | `/ping` | no | Liveness; answers `pong` |
| `POST` | `/login` | no | `{email, password}` in; `{token, expires_in, user}` out; any failure is the same 401 |
| `POST` | `/orgs` | no | Creates a bare organisation; not for use, see above |
| `POST` | `/orgs/:org_id/users` | yes | `{email, password}`; adds a member to the caller's own organisation |
| `POST` | `/seafarers` | yes | `{first_name, last_name}`; creates a seafarer and tags them to the caller's organisation |
| `GET` | `/seafarers` | yes | The caller's crew, paged (`?page`, `?per_page` up to 100), with `total` |
| `GET` | `/seafarers/:seafarer_id` | yes | One seafarer the caller's organisation can see; anyone else's is 404 |
| `POST` | `/cv/extract` | yes | Multipart `file`; extracts and screens a CV, returns the extraction, stores nothing |
| `POST` | `/seafarers/:seafarer_id/cv` | yes | Same, for a seafarer the caller can see; a non-CV is 422; the file is discarded |

A seafarer is one record shared across organisations; each organisation sees
only the seafarers tagged to it. The frontend calls all of this from its own
server side, so CORS does not apply to it.

## 4. Deploying the backend

### The button

In the backend repository on GitHub: Actions, Deploy, Run workflow, pick
`dev`. It builds the chosen branch, uploads the release, installs it on the
instance through the `crewreg-dev-deploy` SSM document, waits, and checks
`https://api-dev.trynilla.com/ping`. `dev` deploys from any branch; `prod` will
refuse anything but `main`. GitHub only registers the workflow from the
default branch, so the button exists because `.github/workflows/` is on `main`.

### From a laptop

Same steps, with your own credentials, from the backend checkout you want to
ship (it refuses a dirty working tree):

```bash
scripts/deploy.sh dev ../backend
```

### What a deploy does on the box

Releases live under `/opt/crewreg/releases/<git-sha>/`, with
`/opt/crewreg/current` a symlink to the live one. The deploy script verifies
the checksum, flips the symlink, restarts the `crewreg` service, waits up to
60 seconds for `/ping` on localhost, and rolls the symlink back to the previous
release if it never answers. The last five releases stay on disk. The instance
reads `server/current` from the artifacts bucket at first boot, so a replaced
instance comes up on the last deployed build.

### Roll back

Deploy an older commit with the button or the script, or point the instance
at an older sha that is still in the bucket:

```bash
aws ssm send-command --document-name crewreg-dev-deploy --parameters Sha=<older-sha> \
  --targets Key=tag:crewreg:env,Values=dev Key=tag:crewreg:role,Values=api
```

### Database migrations

The backend applies its embedded migrations at boot in every environment
except `prod`. A deploy that adds a migration therefore applies it on the
first start of the new release. `prod` will need a migration step before it
can exist.

## 5. Looking at the running service

### Logs

CloudWatch Logs, region `us-east-2`, 14 days of retention:

- `/crewreg/dev/server`: the backend's own log (config loaded, migrations,
  requests that failed, extraction problems)
- `/crewreg/dev/caddy`: the HTTPS access log, JSON, one line per request

```bash
aws logs tail /crewreg/dev/server --follow
```

On the instance the same data is in `/var/log/crewreg/server.log`,
`/var/log/caddy/access.log`, and the first-boot record
`/var/log/crewreg-bootstrap.log`.

### A shell on the instance

No SSH. Session Manager, using the `InstanceId` output of the app stack:

```bash
aws ssm start-session --target <instance-id>
```

Useful once there: `systemctl status crewreg caddy`, `journalctl -u caddy`,
`readlink /opt/crewreg/current`.

### Restart the service or Caddy

```bash
aws ssm send-command --document-name AWS-RunShellScript \
  --targets Key=tag:crewreg:env,Values=dev Key=tag:crewreg:role,Values=api \
  --parameters 'commands=["systemctl restart crewreg"]'
```

The backend reads its secrets at start, so a restart is how a changed secret
takes effect. Restarting Caddy is only needed to hurry a certificate retry.

### Replace the instance

Any change under `instance/` in this repo, or to `corsAllowedOrigins`,
`extract` or `instanceType` in `cdk.json`, replaces the instance on the next
`npx cdk deploy crewreg-dev-app`. It takes about five minutes; the Elastic IP
and therefore DNS do not change, and the new instance installs the last
deployed release on its own. A broken instance can also be terminated in the
console and re-created the same way.

## 6. Secrets and configuration

Three secrets in Secrets Manager (`us-east-2`) hold everything the backend
must not read from a file:

| Secret | Holds | Change it by |
|---|---|---|
| `dev/llm` | LLM provider, model names, API key | Console edit, or `scripts/set-llm-key.sh dev` from a real terminal (it prompts). Then restart the service. |
| `dev/database` | Postgres host, port, user, password, dbname | Managed by the stack. Do not edit. |
| `dev/auth` | Session signing key (`signing_key`) and the frontend's shared key (`bff_shared_key`) | The signing key is managed by the stack; rotating it logs every user out at once, the only global revocation there is. The BFF key is minted by `scripts/set-bff-key.sh dev d1uy4g8hfjj6fp`, which also sets `CREWREG_BFF_KEY` on the Amplify app and rebuilds it; run it again to rotate. |

Non-secret settings live in `cdk.json` under `context.crewreg.dev` and reach
the instance as `/etc/crewreg/config.yaml`: `corsAllowedOrigins`,
`frontendOrigin` (the backend's `public.base_url`), `mailFrom` (its
`mail.from`), the `extract` tunables, `instanceType`, `apiHost`, the two email
addresses and the budget. The CV bucket's name is generated by the stack and
written in as `storage.bucket` (the `CvBucket` output). Change the file,
`npx cdk deploy crewreg-dev-app`, and the instance is replaced with the new
config.

Do not change the `llm` block in `cdk.json` for a deployed environment: it only
seeds the secret at creation, and a changed template regenerates the secret
and wipes the real key. Edit the secret instead.

## 7. Domains and DNS

`trynilla.com` is a Route 53 hosted zone (`Z04086442AMPWSPJV0TW2`) that
existed before this app used it; `cdk.json` names it in `hostedZoneId` and
the app stack imports it rather than creating one. The registrar delegates to
its four nameservers and nothing else is configured there. Records:

- `api-dev.trynilla.com`: `A` to the instance's Elastic IP, written by the
  app stack, TTL 5 minutes. Never edit by hand.
- Three `<token>._domainkey.trynilla.com` CNAMEs: SES DKIM for the sender
  domain, written by the app stack. Never edit by hand.
- `app.trynilla.com` and the ACM validation CNAME: written by Amplify for the
  frontend (section 8).
- The apex `trynilla.com` is deliberately empty: it is reserved for the
  marketing site, which is not this app's business. Add it as any other
  record; nothing here will fight it.
- Anything else is added in the Route 53 console or with
  `aws route53 change-resource-record-sets`.

`aucto.io`, the previous domain, is still a Route 53 zone owned by the
`crewreg-dns` stack, and the Amplify app still carries its `aucto.io` domain
association. Neither is used any more; delete the Amplify association and the
stack (the zone is retained) when the old links can safely stop working.

Caddy on the instance obtains and renews the API's certificate from Let's
Encrypt by itself; the only requirement is that the name resolves to the
instance and port 80 stays open.

### Mail

The backend sends applicant verification codes through SES as `mailFrom`
(`no-reply@trynilla.com`). The app stack creates the SES domain identity for
`trynilla.com` and its DKIM records; SES verifies it on its own within
minutes and the backend refuses to boot until it has:

```bash
aws sesv2 get-email-identity --email-identity trynilla.com --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status}'
```

The account's SES is still in the **sandbox**: mail is delivered only to
addresses verified in SES, so an applicant who is not on that list never
receives a code. To test in the sandbox, verify your own address once
(`aws sesv2 create-email-identity --email-identity you@example.com`, then click
the link SES emails). To leave the sandbox, request production access in the
SES console (Account dashboard, Request production access) or with `aws sesv2
put-account-details`, describing the transactional use; AWS answers within a
day or so.

## 8. The frontend

The Next.js frontend is Amplify app `shipping-frontend` (`d1uy4g8hfjj6fp`,
`us-east-2`), built from the `main` branch of `mattkhoo-wg/shipping-frontend`
and served at `https://app.trynilla.com` (domain association `trynilla.com`,
subdomain `app` only; the apex is not attached). It talks to the backend only
from its server side, through environment variables set in the Amplify console
(App settings, Environment variables):

| Variable | Value | Set by |
|---|---|---|
| `CREWREG_API_URL` | `https://api-dev.trynilla.com` | by hand, once |
| `CREWREG_BFF_KEY` | the same value as `bff_shared_key` in `dev/auth` | `scripts/set-bff-key.sh dev d1uy4g8hfjj6fp` |

Amplify exposes console variables to the build only, so the build spec must
copy both into `.env.production` for the SSR runtime:

```yaml
- env | grep -e CREWREG_API_URL -e CREWREG_BFF_KEY -e NEXT_PUBLIC_DEMO_MODE >> .env.production
```

Changing a variable needs a redeploy of the branch (`aws amplify start-job
--app-id d1uy4g8hfjj6fp --branch-name main --job-type RELEASE`). The site is
behind Amplify's own password protection (App settings, Access control), which
is where that username and password are managed.

## 9. Cost and the budget

About $28 a month at on-demand prices in Ohio, plus $0.50 per hosted zone
and whatever Gemini charges for extractions; SES is free at this volume and
the CV bucket costs cents until it holds gigabytes. The largest lines are RDS
(about $14) and the instance (about $8). A budget named `crewreg-dev-monthly`
emails at 80% of $40 spent and when the month is forecast to pass $40. This
account has no free tier or credits; AWS Activate Founders is the route to
credits.

## 10. Tearing down, or adding an environment

```bash
npx cdk destroy crewreg-dev-app     # instance, EIP, roles, budget, log groups
npx cdk destroy crewreg-dev-data    # RDS takes a final snapshot; secrets are scheduled for deletion
```

The hosted zone, the artifacts bucket and the CV bucket are retained on
purpose. A second environment is a `crewreg.prod` block in `cdk.json` deployed
with `-c env=prod`, plus a GitHub Environment `prod` with the four variables
and its own `mailFrom` domain (one SES identity per domain per region, so
`no-reply@prod.trynilla.com` or a subdomain for the other one); the backend
needs a migration runner before `prod` is real.

## 11. Before any real data goes in

The backend still lacks an erasure path, a retention limit, an access audit
trail, login rate limiting, and a guard on `POST /orgs`. The platform's own
rule is that no real seafarer data enters the service until those exist. The
dev accounts above are for testing with invented people.

## 12. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `authorization grant is invalid, expired, revoked` | The browser sign-in expired. `aws login --profile crewreg`. |
| `Stack with id crewreg-dev-app does not exist` | Wrong region on the profile. The scripts read `cdk.json`; for raw `aws` commands pass `--region us-east-2`. |
| A deploy reports no invocations | No instance carries the `crewreg:env=dev` tag: the app stack is not deployed, or the instance is mid-replacement. |
| Remote command fails with `Files/Git/etc/...` | Git Bash rewrote a Linux path. The scripts set `MSYS_NO_PATHCONV=1`; do the same for ad hoc `aws ssm send-command` calls. |
| `Python was not found` from a script | The Microsoft Store placeholder. The scripts use Node only; if one still calls Python, that is a bug. |
| `api-dev.trynilla.com` does not resolve on one machine but does elsewhere | A resolver cache from before the DNS switch. It clears within the hour. |
| Site answers 502 | The backend is not running: no release deployed yet, or it failed to start. Check `/crewreg/dev/server` for the reason (usually a secret or the database). |
| A user cannot log in | Same 401 for a wrong password and an unknown address, by design. Confirm the address with `list-orgs` is not possible yet; create a new user if in doubt. |
