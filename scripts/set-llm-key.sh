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
stack="crewreg-${env_name}-app"

region="$(aws cloudformation describe-stacks --stack-name "${stack}" \
  --query "Stacks[0].Outputs[?OutputKey=='Region'].OutputValue" --output text)"
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

py="$(command -v python3 || command -v python)"
current="$(aws secretsmanager get-secret-value --secret-id "${secret_name}" --query SecretString --output text)"
updated="$(LLM_API_KEY="${key}" "${py}" -c '
import json, os, sys
doc = json.loads(sys.stdin.read())
doc["api_key"] = os.environ["LLM_API_KEY"]
print(json.dumps(doc))
' <<<"${current}")"

aws secretsmanager put-secret-value --secret-id "${secret_name}" --secret-string "${updated}" >/dev/null
echo "set-llm-key: ${secret_name} updated (provider=$("${py}" -c 'import json,sys; print(json.loads(sys.stdin.read())["provider"])' <<<"${updated}"))"

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
