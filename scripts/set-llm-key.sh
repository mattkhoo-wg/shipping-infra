#!/usr/bin/env bash
# Put the real LLM API key into the <env>/llm secret, keeping every other key
# (provider, models, max_tokens) as it is, then restart the service so it
# re-reads its secrets.
#
#   scripts/set-llm-key.sh <env> [--no-restart]
#
# The key is read from $LLM_API_KEY or, failing that, prompted for without
# echo. It is never an argument, so it does not land in shell history or `ps`.
set -euo pipefail

env_name="${1:?usage: scripts/set-llm-key.sh <env> [--no-restart]}"
restart=true
if [ "${2:-}" = "--no-restart" ]; then
  restart=false
fi
secret_name="${env_name}/llm"
# The region comes from cdk.json (context.crewreg.<env>.region), the same
# source the stacks are deployed with, so no lookup below can go to the wrong
# region because of a profile default.
infra_dir="$(cd "$(dirname "$0")/.." && pwd)"
region="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).context.crewreg[process.argv[1]].region))' "$env_name" < "$infra_dir/cdk.json")"
export AWS_DEFAULT_REGION="${region}"

key="${LLM_API_KEY:-}"
if [ -z "${key}" ]; then
  read -r -s -p "API key for ${secret_name}: " key
  echo
fi
if [ -z "${key}" ]; then
  echo "set-llm-key: empty key" >&2
  exit 1
fi

current="$(aws secretsmanager get-secret-value --secret-id "${secret_name}" --query SecretString --output text)"
# The key travels through the environment, never an argument, so it is not in
# the process list or the shell history.
updated="$(LLM_API_KEY="${key}" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);o.api_key=process.env.LLM_API_KEY;process.stdout.write(JSON.stringify(o))})' <<<"${current}")"

aws secretsmanager put-secret-value --secret-id "${secret_name}" --secret-string "${updated}" >/dev/null
provider="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).provider))' <<<"${updated}")"
echo "set-llm-key: ${secret_name} updated (provider=${provider})"

# This restart uses the generic AWS-RunShellScript document on purpose: the
# caller is an operator with their own credentials, not the deploy role, which
# is allowed only the fixed-content crewreg-<env>-deploy document.
if [ "${restart}" = true ]; then
  echo "set-llm-key: restarting the ${env_name} service so it re-reads the secret"
  aws ssm send-command \
    --document-name AWS-RunShellScript \
    --targets "Key=tag:crewreg:env,Values=${env_name}" "Key=tag:crewreg:role,Values=api" \
    --comment "restart after llm key change" \
    --parameters 'commands=["systemctl restart crewreg"]' \
    --query 'Command.CommandId' --output text
else
  echo "set-llm-key: not restarting; the running process keeps the old key until it restarts"
fi
