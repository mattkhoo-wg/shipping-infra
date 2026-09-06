#!/bin/bash
# Installs one release of the backend binary and switches the service to it.
#
#   crewreg-deploy <git-sha>
#
# Invoked by the Deploy workflow through SSM Run Command, by scripts/deploy.sh
# from a laptop, and by the first-boot bootstrap. Idempotent: re-running for the
# current release re-downloads, re-verifies and restarts.
#
# Layout:
#   /opt/crewreg/releases/<sha>/server   one directory per release
#   /opt/crewreg/current -> releases/<sha>
#   /etc/crewreg/deploy.env              ARTIFACTS_BUCKET, AWS_DEFAULT_REGION
#
# The switch is a symlink flip plus a systemd restart. If the new release never
# answers /ping the symlink is flipped back and the previous release restarted,
# and the script exits non-zero so the caller sees the failure.
set -euo pipefail

sha="${1:?usage: crewreg-deploy <git-sha>}"
case "${sha}" in
  *[!0-9a-f]*|'') echo "crewreg-deploy: release id must be a hex git sha, got '${sha}'" >&2; exit 2 ;;
esac

# shellcheck source=/dev/null
. /etc/crewreg/deploy.env
export AWS_DEFAULT_REGION

readonly releases=/opt/crewreg/releases
readonly current=/opt/crewreg/current
readonly log=/var/log/crewreg/server.log
readonly health_attempts=30
readonly health_interval=2
readonly keep_releases=5

dir="${releases}/${sha}"

wait_healthy() {
  local i
  for ((i = 1; i <= health_attempts; i++)); do
    if curl -fsS --max-time 2 http://127.0.0.1:8080/ping >/dev/null 2>&1; then
      return 0
    fi
    sleep "${health_interval}"
  done
  return 1
}

prune_old_releases() {
  # Keep the newest N release directories (by mtime). The current one is always
  # among the newest because it was just written.
  ls -1t "${releases}" | tail -n +"$((keep_releases + 1))" | while read -r old; do
    rm -rf "${releases:?}/${old}"
  done
}

echo "crewreg-deploy: fetching release ${sha} from s3://${ARTIFACTS_BUCKET}/server/${sha}/"
mkdir -p "${dir}"
aws s3 cp --only-show-errors "s3://${ARTIFACTS_BUCKET}/server/${sha}/server" "${dir}/server"
aws s3 cp --only-show-errors "s3://${ARTIFACTS_BUCKET}/server/${sha}/server.sha256" "${dir}/server.sha256"
(cd "${dir}" && sha256sum --check --status server.sha256) || {
  echo "crewreg-deploy: checksum mismatch for release ${sha}; refusing to install" >&2
  rm -rf "${dir}"
  exit 1
}
chmod 0755 "${dir}/server"
chown -R crewreg:crewreg "${dir}"

previous="$(readlink -f "${current}" 2>/dev/null || true)"
ln -sfn "${dir}" "${current}"
systemctl restart crewreg

if wait_healthy; then
  echo "crewreg-deploy: release ${sha} is serving /ping"
  prune_old_releases
  exit 0
fi

echo "crewreg-deploy: release ${sha} never answered /ping; last log lines follow" >&2
tail -n 50 "${log}" >&2 || true

if [ -n "${previous}" ] && [ "${previous}" != "${dir}" ] && [ -x "${previous}/server" ]; then
  ln -sfn "${previous}" "${current}"
  systemctl restart crewreg
  echo "crewreg-deploy: rolled back to $(basename "${previous}")" >&2
  # The failed release is not worth the disk; a retry downloads it again.
  rm -rf "${dir}"
else
  echo "crewreg-deploy: no previous release to roll back to; service left on ${sha}" >&2
fi
prune_old_releases
exit 1
