#!/usr/bin/env bash
# Deploy the backend to one environment from a laptop. Same contract as the
# backend repo's Deploy workflow, for when GitHub is not the right tool (first
# deploy, a hotfix while Actions is down, a branch that is not pushed yet).
#
#   scripts/deploy.sh <env> [path-to-backend-repo]
#
# Needs: AWS credentials for the target account (aws sso login), go, git.
# The bucket, region and API host are read from the app stack's outputs, so
# nothing has to be copied by hand.
set -euo pipefail

env_name="${1:?usage: scripts/deploy.sh <env> [path-to-backend-repo]}"
backend_dir="${2:-$(cd "$(dirname "$0")/../../backend" && pwd)}"
stack="crewreg-${env_name}-app"

output() {
  aws cloudformation describe-stacks --stack-name "${stack}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

# The region comes from cdk.json (context.crewreg.<env>.region), the same
# source the stacks are deployed with, so no lookup below can go to the wrong
# region because of a profile default.
infra_dir="$(cd "$(dirname "$0")/.." && pwd)"
py="$(command -v python3 || command -v python)"
region="$("$py" -c 'import json, sys; print(json.load(open(sys.argv[1]))["context"]["crewreg"][sys.argv[2]]["region"])' "$infra_dir/cdk.json" "$env_name")"
export AWS_DEFAULT_REGION="${region}"
echo "==> reading outputs of ${stack} in ${region}"
bucket="$(output ArtifactsBucket)"
api_host="$(output ApiHost)"
if [ -z "${bucket}" ] || [ -z "${api_host}" ] || [ "${bucket}" = "None" ]; then
  echo "deploy: stack ${stack} has no ArtifactsBucket/ApiHost output; is it deployed?" >&2
  exit 1
fi

echo "==> building linux/amd64 binary from ${backend_dir}"
sha="$(git -C "${backend_dir}" rev-parse HEAD)"
if [ -n "$(git -C "${backend_dir}" status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "deploy: the backend working tree is dirty; a release labelled ${sha} would not match that commit." >&2
  echo "deploy: commit first, or set ALLOW_DIRTY=1 to ship it anyway." >&2
  exit 1
fi
dist="$(mktemp -d)"
trap 'rm -rf "${dist}"' EXIT
(
  cd "${backend_dir}/backend"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w" -o "${dist}/server" ./cmd
)
(cd "${dist}" && sha256sum server > server.sha256)

echo "==> uploading release ${sha} to s3://${bucket}/server/${sha}/"
aws s3 cp --only-show-errors "${dist}/server" "s3://${bucket}/server/${sha}/server"
aws s3 cp --only-show-errors "${dist}/server.sha256" "s3://${bucket}/server/${sha}/server.sha256"
printf '%s' "${sha}" | aws s3 cp --only-show-errors - "s3://${bucket}/server/current"

# The deploy role (and this script, with an operator's credentials) sends ONE
# document: crewreg-<env>-deploy, whose content is fixed by the app stack to
# run the deploy script with a sha. Not AWS-RunShellScript.
echo "==> asking the ${env_name} instance(s) to install it"
command_id="$(aws ssm send-command \
  --document-name "crewreg-${env_name}-deploy" \
  --targets "Key=tag:crewreg:env,Values=${env_name}" "Key=tag:crewreg:role,Values=api" \
  --comment "deploy ${sha}" \
  --timeout-seconds 600 \
  --parameters "Sha=${sha}" \
  --query 'Command.CommandId' --output text)"
echo "    command ${command_id}"

deadline=$((SECONDS + 600))
while :; do
  invocations="$(aws ssm list-command-invocations --command-id "${command_id}" --details \
    --query 'CommandInvocations[].[InstanceId,Status]' --output text)"
  if [ -n "${invocations}" ] && ! grep -qE 'Pending|InProgress|Delayed' <<<"${invocations}"; then
    break
  fi
  # Invocations appear a moment after send-command. Once the command itself
  # has left Pending/InProgress with none, nothing matched the tags: fail now
  # rather than after the full timeout.
  if [ -z "${invocations}" ]; then
    command_status="$(aws ssm list-commands --command-id "${command_id}" --query 'Commands[0].Status' --output text)"
    case "${command_status}" in
      Pending|InProgress) ;;
      *)
        echo "deploy: command ${command_id} is ${command_status} with no invocations: no instance carries tags crewreg:env=${env_name} crewreg:role=api" >&2
        exit 1
        ;;
    esac
  fi
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "deploy: timed out waiting for command ${command_id}" >&2
    exit 1
  fi
  sleep 10
done

aws ssm list-command-invocations --command-id "${command_id}" --details \
  --query 'CommandInvocations[].{instance:InstanceId,status:Status,out:CommandPlugins[0].Output}' --output table
if grep -vq 'Success' <<<"$(awk '{print $2}' <<<"${invocations}")"; then
  echo "deploy: at least one instance did not report Success" >&2
  exit 1
fi

echo "==> checking https://${api_host}/ping"
curl -fsS --retry 5 --retry-delay 5 "https://${api_host}/ping"
echo
echo "deployed ${sha} to ${env_name}"
