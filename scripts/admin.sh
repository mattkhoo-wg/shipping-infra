#!/usr/bin/env bash
# Run the backend's operator-only `server admin ...` subcommand on an
# environment's instance, over SSM, and print what it printed.
#
#   scripts/admin.sh <env> list-orgs
#   scripts/admin.sh <env> create-org  --name "Blue Anchor Crewing"
#   scripts/admin.sh <env> create-user --org-id <uuid> --email ops@example.com --generate-password
#
# The command runs on the box with the deployed release, its config file and
# the instance role, so it reaches the private database without any credential
# leaving AWS. It needs an operator's own AWS credentials (aws login), not the
# GitHub deploy role, which may only send the deploy document.
#
# SENSITIVE OUTPUT: `--generate-password` prints the new password once, and
# SSM Run Command keeps command output in its history for 30 days. Treat that
# history as sensitive, and prefer `--password-stdin` from a Session Manager
# shell for anything beyond a development account.
set -euo pipefail

# Git Bash on Windows rewrites arguments that look like POSIX paths
# (/etc/..., /opt/...) into Windows paths before aws receives them, which
# corrupts the remote command. Off for this script; harmless elsewhere.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"

env_name="${1:?usage: scripts/admin.sh <env> <admin subcommand and flags>}"
shift
if [ $# -eq 0 ]; then
  echo "admin: missing subcommand (list-orgs | create-org | create-user)" >&2
  exit 2
fi

infra_dir="$(cd "$(dirname "$0")/.." && pwd)"
region="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).context.crewreg[process.argv[1]].region))' "$env_name" < "$infra_dir/cdk.json")"
export AWS_DEFAULT_REGION="${region}"

# Quote every argument for the remote shell so names with spaces survive.
remote="CONFIG_PATH=/etc/crewreg/config.yaml /opt/crewreg/current/server admin"
for arg in "$@"; do
  remote+=" $(printf '%q' "$arg")"
done

# The command goes to SSM as a JSON string; escape for JSON.
remote_json="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$remote")"

command_id="$(aws ssm send-command \
  --document-name AWS-RunShellScript \
  --targets "Key=tag:crewreg:env,Values=${env_name}" "Key=tag:crewreg:role,Values=api" \
  --comment "server admin ${1}" \
  --timeout-seconds 120 \
  --parameters "{\"commands\":[${remote_json}],\"executionTimeout\":[\"120\"]}" \
  --query 'Command.CommandId' --output text)"

deadline=$((SECONDS + 180))
while :; do
  invocations="$(aws ssm list-command-invocations --command-id "${command_id}" \
    --query 'CommandInvocations[].[InstanceId,Status]' --output text)"
  if [ -n "${invocations}" ] && ! grep -qE 'Pending|InProgress|Delayed' <<<"${invocations}"; then
    break
  fi
  if [ -z "${invocations}" ]; then
    command_status="$(aws ssm list-commands --command-id "${command_id}" --query 'Commands[0].Status' --output text)"
    case "${command_status}" in
      Pending|InProgress) ;;
      *) echo "admin: no instance carries tags crewreg:env=${env_name} crewreg:role=api" >&2; exit 1 ;;
    esac
  fi
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "admin: timed out waiting for command ${command_id}" >&2
    exit 1
  fi
  sleep 3
done

instance_id="$(awk 'NR==1{print $1}' <<<"${invocations}")"
status="$(awk 'NR==1{print $2}' <<<"${invocations}")"
aws ssm get-command-invocation --command-id "${command_id}" --instance-id "${instance_id}" \
  --query 'StandardOutputContent' --output text
stderr="$(aws ssm get-command-invocation --command-id "${command_id}" --instance-id "${instance_id}" \
  --query 'StandardErrorContent' --output text)"
if [ -n "${stderr}" ] && [ "${stderr}" != "None" ]; then
  printf '%s\n' "${stderr}" >&2
fi
if [ "${status}" != "Success" ]; then
  echo "admin: command finished with status ${status}" >&2
  exit 1
fi
