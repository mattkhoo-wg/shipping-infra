# shipping-infra

AWS infrastructure for the crewreg backend (`shipping-backend`), as an AWS CDK
app in TypeScript. One environment is one EC2 instance, one RDS Postgres, three
Secrets Manager secrets, an S3 bucket for releases, a GitHub OIDC deploy role
and a budget alert, all in `us-east-2` (Ohio).

- `docs/deployment-plan.md`: the plan as approved before this was built.
- `docs/deployment-architecture.md`: what is deployed and how it fits together.
- The backend's own ADR 0022 records the deployment shape from its side.

## Layout

```
bin/crewreg.ts          CDK app: picks the environment, builds the three stacks
lib/config.ts           validated per-environment settings from cdk.json
lib/data-stack.ts       VPC, RDS Postgres, the three secrets
lib/app-stack.ts        instance, security groups, EIP, bucket, deploy role, budget
lib/github-oidc-stack.ts  the account-level GitHub Actions OIDC provider
lib/dns-stack.ts        the Route 53 hosted zone for the domain (retained on destroy)
lib/user-data.ts        renders the first-boot script from instance/
lib/nag-suppressions.ts cdk-nag findings accepted on purpose, with reasons
instance/               files installed on the box (bootstrap, deploy script, units, Caddyfile)
scripts/deploy.sh       deploy from a laptop (same contract as the GitHub button)
scripts/set-llm-key.sh  put the real LLM API key into <env>/llm, once
scripts/admin.sh        run the backend's operator-only account commands on the instance
test/                   CDK assertion tests + the cdk-nag gate
```

## Prerequisites

- Node.js 22+ and `npm install` in this directory.
- AWS CLI v2 with credentials for the target account (`aws sso login`).
- The account bootstrapped for CDK once per region:
  `npx cdk bootstrap aws://<account-id>/us-east-2`.
- Go 1.25+ and the backend repo checked out beside this one, for
  `scripts/deploy.sh` (the GitHub button needs neither).

## First-time setup for an environment

1. **Fill in `cdk.json`.** Under `context.crewreg.dev` set `apiHost` (the API
   hostname on your domain, e.g. `api.example.com`), `acmeEmail` (Let's
   Encrypt notices), `budgetEmail`, and `corsAllowedOrigins` (the Amplify URL,
   later your custom frontend domain). Everything else has sensible defaults.
   Nothing in this file is secret.
2. **Check and deploy.**
   ```bash
   npm test                      # assertions + cdk-nag gate
   npx cdk synth
   npx cdk deploy --all          # oidc provider + dns zone, then data, then app
   ```
   The first deploy takes 10 to 15 minutes, most of it RDS. The AMI is looked
   up once and cached in `cdk.context.json`; commit that file.
   If the account already has a GitHub OIDC provider, add
   `-c crewreg:createGithubOidcProvider=false`.
3. **Point the domain at Route 53.** The `crewreg-dns` stack creates the
   hosted zone for `hostedZoneName` and outputs `NameServers`. In Namecheap,
   Domain List, Manage, Nameservers, choose Custom DNS and enter those four
   names. The API's `A` record is already in the zone; Caddy requests the
   certificate as soon as the nameserver change propagates (minutes to a few
   hours) and retries until it does. Amplify's custom domain for the frontend
   goes into the same zone, which the Amplify console does on its own.
   Without `hostedZoneName` in `cdk.json` the record is yours to add at the
   registrar, pointing at the `ElasticIp` output.
4. **Set the LLM API key.** The `dev/llm` secret was created with the provider
   and model names and a placeholder key.
   ```bash
   scripts/set-llm-key.sh dev        # prompts for the key, restarts the service
   ```
5. **Wire the GitHub button.** In the backend repo, create a GitHub Environment
   named `dev` (Settings > Environments) with four **variables** taken from the
   app stack outputs:

   | Variable | Stack output |
   |---|---|
   | `AWS_ROLE_ARN` | `DeployRoleArn` |
   | `AWS_REGION` | `Region` |
   | `ARTIFACTS_BUCKET` | `ArtifactsBucket` |
   | `API_HOST` | `ApiHost` |

6. **Deploy the backend.** Run the `Deploy` workflow in the backend repo
   (Actions > Deploy > Run workflow > `dev`), or from a laptop:
   ```bash
   scripts/deploy.sh dev ../backend
   ```
   Until the first release lands the instance has no binary and the service
   is stopped; Caddy answers 502. After it: `curl https://<apiHost>/ping`.

## Day to day

- **Deploy a new build:** the `Deploy` workflow, or `scripts/deploy.sh dev`.
  Both upload `server/<git-sha>/` to the bucket, update `server/current`, and
  send the `crewreg-dev-deploy` SSM document (which runs
  `/usr/local/bin/crewreg-deploy <sha>` and accepts nothing else) to the
  instance. The
  instance verifies the checksum, flips a symlink, restarts the service, waits
  for `/ping`, and rolls back to the previous release if it never answers.
- **Roll back by hand:** `scripts/deploy.sh` with the backend checked out at
  the older commit, or send the document with the older sha:
  `aws ssm send-command --document-name crewreg-dev-deploy --parameters Sha=<older-sha> --targets Key=tag:crewreg:env,Values=dev`
  (the release must still be in the bucket; the last five stay on the box too).
- **Logs:** CloudWatch Logs groups `/crewreg/dev/server` and
  `/crewreg/dev/caddy` (14 days). On the box: `/var/log/crewreg/server.log`,
  `/var/log/caddy/access.log`, `/var/log/crewreg-bootstrap.log`.
- **A shell on the instance:** no SSH. Use the `SessionCommand` output:
  `aws ssm start-session --region us-east-2 --target <instance-id>`.
- **Change the LLM models:** edit the `dev/llm` secret directly (console or
  CLI), then restart the service. Do not change the `llm` block in `cdk.json`
  for a deployed environment: it only seeds the secret at creation, and a
  changed template regenerates the secret and wipes the real key.
- **Change CORS origins or extract tunables:** edit `cdk.json`, `npx cdk
  deploy crewreg-dev-app`. That rewrites the bootstrap, so the instance is
  replaced (a few minutes of downtime) and comes back on the last release.
- **Replace a sick instance:** `npx cdk deploy crewreg-dev-app` after any
  change to `instance/`, or terminate it in the console and re-run the deploy;
  the Elastic IP follows the new instance.
- **Costs:** the budget emails at 80% of `budgetUsd` and when the month is
  forecast to exceed it. `docs/deployment-plan.md` has the itemised estimate.

## Creating accounts

There is no public sign-up. Organisations and users are created by an operator
with the backend's `server admin` subcommand, which runs on the instance over
SSM through `scripts/admin.sh`:

```bash
scripts/admin.sh dev create-org  --name "Blue Anchor Crewing"        # prints org_id=...
scripts/admin.sh dev create-user --org-id <uuid> --email ops@example.com --generate-password
scripts/admin.sh dev list-orgs
```

`--generate-password` prints the new password once. SSM Run Command keeps
command output in its history for 30 days, so treat that as sensitive; for
anything beyond a development account, open a Session Manager shell and use
`--password-stdin` instead. Further users of an existing organisation can also
be added through the API by a logged-in member (`POST /orgs/:org_id/users`).

## Tearing an environment down

```bash
npx cdk destroy crewreg-dev-app      # instance, EIP, role, budget, log groups
npx cdk destroy crewreg-dev-data     # RDS takes a final snapshot; secrets are scheduled for deletion
```

The artifacts bucket is retained on purpose; empty and delete it by hand if
the environment is gone for good. The final RDS snapshot and the deleted
secrets (recoverable for 30 days) are also yours to clean up.

## A second environment

Add a `crewreg.prod` block to `cdk.json` and deploy with `-c env=prod`. Two
things the backend does not do yet stand in the way of a real `prod`: it skips
migrations at boot when `environment` is `prod` and has no migration runner,
and it has no erasure, retention or audit path for the PII it holds. Both are
tracked in the backend's `docs/STATUS.md`.

## Development

```bash
npm test            # jest: assertion tests for every stack, config validation, user-data rendering, cdk-nag
npm run build       # tsc --noEmit
npx cdk diff        # against the deployed stacks
```

Every cdk-nag finding is either fixed or listed in `lib/nag-suppressions.ts`
with a reason. A new finding fails `npm test`; suppress it only with a reason a
reviewer would accept.
