# First-boot provisioning for the crewreg API instance. Rendered into the EC2
# user-data by lib/user-data.ts, after the blocks that write every file this
# script relies on (/etc/crewreg/*, the systemd units, the Caddyfile, the deploy
# script). Runs once, as root, under cloud-init. Amazon Linux 2023.
#
# The instance is disposable: nothing here is state. A change to this script
# replaces the instance (userDataCausesReplacement), and the replacement comes
# up on the last deployed release by reading server/current from the bucket.

export AWS_DEFAULT_REGION="{{REGION}}"

install_caddy() {
  # A pinned release from GitHub, checksum verified against the release's own
  # checksums file. AL2023 has no Caddy package and the COPR route is not
  # supported there, so this is the reproducible option.
  local version="{{CADDY_VERSION}}" arch tgz base tmp
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64) arch=arm64 ;;
    *) echo "bootstrap: unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  tgz="caddy_${version}_linux_${arch}.tar.gz"
  base="https://github.com/caddyserver/caddy/releases/download/v${version}"
  tmp="$(mktemp -d)"
  curl -fsSL --retry 5 --retry-delay 3 -o "${tmp}/${tgz}" "${base}/${tgz}"
  curl -fsSL --retry 5 --retry-delay 3 -o "${tmp}/checksums.txt" "${base}/caddy_${version}_checksums.txt"
  # Caddy publishes SHA-512 sums (128 hex chars per line); sha256sum rejects
  # them as malformed, which is how the first instance failed its bootstrap.
  (cd "${tmp}" && grep " ${tgz}\$" checksums.txt | sha512sum -c -)
  tar -xzf "${tmp}/${tgz}" -C "${tmp}" caddy
  install -m 0755 "${tmp}/caddy" /usr/local/bin/caddy
  rm -rf "${tmp}"

  id -u caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --shell /sbin/nologin caddy
  mkdir -p /var/lib/caddy /var/log/caddy
  chown -R caddy:caddy /var/lib/caddy /var/log/caddy
  chmod 0755 /var/log/caddy
}

# 1. OS packages. poppler-utils provides pdftotext and pdftoppm, which the
#    binary shells out to. The CloudWatch agent ships the logs off the box.
dnf install -y poppler-utils amazon-cloudwatch-agent dnf-automatic
dnf clean all

# 2. Swap. 1 GB of RAM is tight while pdftoppm rasterises a scanned CV.
if ! grep -q '^/swapfile' /etc/fstab; then
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 3. Unattended security updates.
sed -i -e 's/^upgrade_type = .*/upgrade_type = security/' \
       -e 's/^apply_updates = .*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer

# 4. Service user and directories. The binary runs as crewreg, which owns the
#    releases and the log directory and can read (not write) its config.
id -u crewreg >/dev/null 2>&1 || useradd --system --home-dir /opt/crewreg --shell /sbin/nologin crewreg
mkdir -p /opt/crewreg/releases /var/log/crewreg
chown -R crewreg:crewreg /opt/crewreg /var/log/crewreg
chown root:crewreg /etc/crewreg/config.yaml /etc/crewreg/deploy.env
chmod 0640 /etc/crewreg/config.yaml /etc/crewreg/deploy.env
chmod 0755 /usr/local/bin/crewreg-deploy

# 5. Caddy terminates TLS for the API hostname and proxies to :8080.
install_caddy

# 6. CloudWatch agent: the service log and Caddy's access log.
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s -c file:/etc/crewreg/cloudwatch-agent.json

# 7. Units. Caddy starts now; crewreg is enabled but stays stopped until a
#    release exists, because there is no binary to run on a brand-new bucket.
systemctl daemon-reload
systemctl enable --now caddy
systemctl enable crewreg

# 8. Install the last deployed release, if any. First boot of a fresh
#    environment finds no pointer and leaves the service for the first deploy.
#    A failed install here must not fail the whole bootstrap: everything above
#    is in place and the fix is to run crewreg-deploy again over SSM, not to
#    replace the instance.
current="$(aws s3 cp "s3://{{ARTIFACTS_BUCKET}}/server/current" - 2>/dev/null || true)"
if [ -z "${current}" ]; then
  echo "bootstrap: no release deployed yet (s3://{{ARTIFACTS_BUCKET}}/server/current is absent)"
elif ! /usr/local/bin/crewreg-deploy "${current}"; then
  echo "bootstrap: WARNING release ${current} did not install cleanly; re-run crewreg-deploy over SSM" >&2
fi

echo "bootstrap: done"
