#!/usr/bin/env bash
# Mint the shared key that lets the backend trust the frontend's forwarded
# visitor address (backend ADR 0034), and install the same value on both sides:
# bff_shared_key in the <env>/auth secret (keeping signing_key as it is) and
# CREWREG_BFF_KEY on the Amplify app. Then restart the service and rebuild the
# frontend so both read it.
#
#   scripts/set-bff-key.sh <env> <amplify-app-id> [--no-restart]
#
# The key is generated here (48 random bytes, base64) and never printed. It
# travels through the environment, never an argument, so it is not in the
# process list or the shell history.
set -euo pipefail

env_name="${1:?usage: scripts/set-bff-key.sh <env> <amplify-app-id> [--no-restart]}"
app_id="${2:?usage: scripts/set-bff-key.sh <env> <amplify-app-id> [--no-restart]}"
restart=true
if [ "${3:-}" = "--no-restart" ]; then
  restart=false
fi
secret_name="${env_name}/auth"
infra_dir="$(cd "$(dirname "$0")/.." && pwd)"
region="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).context.crewreg[process.argv[1]].region))' "$env_name" < "$infra_dir/cdk.json")"
export AWS_DEFAULT_REGION="${region}"

key="$(node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("base64"))')"

current="$(aws secretsmanager get-secret-value --secret-id "${secret_name}" --query SecretString --output text)"
updated="$(BFF_KEY="${key}" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);o.bff_shared_key=process.env.BFF_KEY;process.stdout.write(JSON.stringify(o))})' <<<"${current}")"
aws secretsmanager put-secret-value --secret-id "${secret_name}" --secret-string "${updated}" >/dev/null
echo "set-bff-key: ${secret_name} updated (bff_shared_key set, signing_key kept)"

# update-app replaces the whole variable map, so the existing ones are merged in.
existing="$(aws amplify get-app --app-id "${app_id}" --query 'app.environmentVariables' --output json)"
merged="$(BFF_KEY="${key}" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d)||{};o.CREWREG_BFF_KEY=process.env.BFF_KEY;process.stdout.write(JSON.stringify(o))})' <<<"${existing}")"
aws amplify update-app --app-id "${app_id}" --environment-variables "${merged}" >/dev/null
echo "set-bff-key: Amplify app ${app_id} CREWREG_BFF_KEY updated"

if [ "${restart}" = true ]; then
  echo "set-bff-key: restarting the ${env_name} service so it re-reads the secret"
  aws ssm send-command \
    --document-name AWS-RunShellScript \
    --targets "Key=tag:crewreg:env,Values=${env_name}" "Key=tag:crewreg:role,Values=api" \
    --comment "restart after bff key change" \
    --parameters 'commands=["systemctl restart crewreg"]' \
    --query 'Command.CommandId' --output text
  echo "set-bff-key: rebuilding the Amplify main branch so the frontend picks up the key"
  aws amplify start-job --app-id "${app_id}" --branch-name main --job-type RELEASE --query 'jobSummary.jobId' --output text
else
  echo "set-bff-key: not restarting; the backend and the frontend keep the old value until they do"
fi
