import { renderConfigYaml, renderUserData, USER_DATA_LIMIT_BYTES } from '../lib/user-data';
import { TEST_CONFIG } from './helpers';

const params = {
  config: TEST_CONFIG,
  artifactsBucket: 'crewreg-dev-artifacts-abc123',
  serverLogGroup: '/crewreg/dev/server',
  caddyLogGroup: '/crewreg/dev/caddy',
  caddyVersion: '2.11.4',
};

describe('renderConfigYaml', () => {
  test('writes only the non-secret sections', () => {
    const yaml = renderConfigYaml(TEST_CONFIG);

    expect(yaml).toContain('environment: dev\n');
    expect(yaml).toContain('region: ap-south-1\n');
    expect(yaml).toContain('extract:\n  min_text_chars: 100\n  vision_dpi: 150\n  max_vision_pages: 8\n');
    expect(yaml).toContain('cors:\n  allowed_origins:\n    - https://main.d1234567890abc.amplifyapp.com\n    - https://app.example.com\n');
    expect(yaml).not.toMatch(/^llm:/m);
    expect(yaml).not.toMatch(/^database:/m);
    expect(yaml).not.toMatch(/^auth:/m);
    expect(yaml).not.toMatch(/api_key|password|signing_key/);
  });

  test('renders an empty origin list as an explicit empty array', () => {
    const yaml = renderConfigYaml({ ...TEST_CONFIG, corsAllowedOrigins: [] });

    expect(yaml).toContain('cors:\n  allowed_origins: []\n');
  });
});

describe('renderUserData', () => {
  const script = renderUserData(params);

  test('is a bash script under the EC2 size limit with no placeholder left', () => {
    expect(script.startsWith('#!/bin/bash\n')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(Buffer.byteLength(script, 'utf8')).toBeLessThanOrEqual(USER_DATA_LIMIT_BYTES);
    expect(script).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  test('installs the runtime dependencies and the Caddy release', () => {
    expect(script).toContain('dnf install -y poppler-utils amazon-cloudwatch-agent dnf-automatic');
    expect(script).toContain('local version="2.11.4"');
    expect(script).toContain('caddy_${version}_checksums.txt');
    // Caddy's checksums file is SHA-512, so the wrong tool here is a broken boot.
    expect(script).toContain('sha512sum -c -');
    expect(script).not.toContain('sha256sum -c -');
  });

  test('writes the config file, the Caddyfile and the deploy environment', () => {
    expect(script).toContain("cat > '/etc/crewreg/config.yaml' <<'__CREWREG_FILE__'");
    expect(script).toContain('environment: dev');
    expect(script).toContain("cat > '/etc/caddy/Caddyfile' <<'__CREWREG_FILE__'");
    expect(script).toContain('email ops@example.com');
    expect(script).toContain('\napi.example.com {');
    expect(script).toContain('reverse_proxy 127.0.0.1:8080');
    expect(script).toContain('ARTIFACTS_BUCKET=crewreg-dev-artifacts-abc123');
    expect(script).toContain('AWS_DEFAULT_REGION=ap-south-1');
    expect(script).toContain('"log_group_name": "/crewreg/dev/server"');
    expect(script).toContain('"log_group_name": "/crewreg/dev/caddy"');
  });

  test('installs the deploy script and units, and pulls the current release last', () => {
    expect(script).toContain("cat > '/usr/local/bin/crewreg-deploy' <<'__CREWREG_FILE__'");
    expect(script).toContain("chmod 0755 '/usr/local/bin/crewreg-deploy'");
    expect(script).toContain("cat > '/etc/systemd/system/crewreg.service'");
    expect(script).toContain('Environment=CONFIG_PATH=/etc/crewreg/config.yaml');
    expect(script).toContain("cat > '/etc/systemd/system/caddy.service'");
    expect(script).toContain('s3://crewreg-dev-artifacts-abc123/server/current');
    expect(script.lastIndexOf('/usr/local/bin/crewreg-deploy "${current}"')).toBeGreaterThan(script.indexOf('systemctl enable crewreg'));
    expect(script).toContain('did not install cleanly; re-run crewreg-deploy over SSM');
  });

  test('never expands file contents through the shell', () => {
    // Every file is written through a quoted heredoc, so `$` in the deploy
    // script and the Caddyfile survives verbatim.
    const blocks = script.match(/<<'__CREWREG_FILE__'/g) ?? [];
    expect(blocks.length).toBe(8);
    expect(script).toContain('sha="${1:?usage: crewreg-deploy <git-sha>}"');
  });
});
