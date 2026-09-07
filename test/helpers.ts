import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { AppStack, TAG_ENV } from '../lib/app-stack';
import { EnvironmentConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { applyNagSuppressions } from '../lib/nag-suppressions';

/** A complete, valid dev configuration. Tests override single fields. */
export const TEST_CONFIG: EnvironmentConfig = {
  envName: 'dev',
  region: 'ap-south-1',
  apiHost: 'api.example.com',
  hostedZoneName: 'example.com',
  acmeEmail: 'ops@example.com',
  budgetEmail: 'billing@example.com',
  budgetUsd: 40,
  corsAllowedOrigins: ['https://main.d1234567890abc.amplifyapp.com', 'https://app.example.com'],
  githubRepo: 'mattkhoo-wg/shipping-backend',
  instanceType: 't3.micro',
  // Pinned so the suite never touches the AMI context lookup; one test
  // exercises the lookup path on its own.
  amiId: 'ami-0123456789abcdef0',
  llm: { provider: 'gemini', textModel: 'gemini-flash-lite-latest', visionModel: 'gemini-3.5-flash', maxTokens: 8192 },
  extract: { minTextChars: 100, visionDpi: 150, maxVisionPages: 8 },
};

/** The raw cdk.json shape of TEST_CONFIG, for the loader tests. */
export const TEST_CONTEXT = {
  crewreg: {
    dev: {
      region: TEST_CONFIG.region,
      apiHost: TEST_CONFIG.apiHost,
      hostedZoneName: TEST_CONFIG.hostedZoneName,
      acmeEmail: TEST_CONFIG.acmeEmail,
      budgetEmail: TEST_CONFIG.budgetEmail,
      budgetUsd: TEST_CONFIG.budgetUsd,
      corsAllowedOrigins: [...TEST_CONFIG.corsAllowedOrigins],
      githubRepo: TEST_CONFIG.githubRepo,
      instanceType: TEST_CONFIG.instanceType,
      llm: { ...TEST_CONFIG.llm },
      extract: { ...TEST_CONFIG.extract },
    },
  },
};

export const TEST_ENV: cdk.Environment = { account: '123456789012', region: 'ap-south-1' };

export interface SynthesizedEnvironment {
  readonly app: cdk.App;
  readonly oidc: GithubOidcStack;
  readonly dns?: DnsStack;
  readonly data: DataStack;
  readonly appStack: AppStack;
  readonly config: EnvironmentConfig;
}

/** Builds the three stacks exactly as bin/crewreg.ts does, with nag checks on. */
export function synthesizeEnvironment(overrides: Partial<EnvironmentConfig> = {}): SynthesizedEnvironment {
  const config: EnvironmentConfig = { ...TEST_CONFIG, ...overrides };
  const app = new cdk.App();
  const oidc = new GithubOidcStack(app, 'crewreg-github-oidc', { env: TEST_ENV });
  const dns = config.hostedZoneName !== undefined
    ? new DnsStack(app, 'crewreg-dns', { env: TEST_ENV, zoneName: config.hostedZoneName })
    : undefined;
  const data = new DataStack(app, `crewreg-${config.envName}-data`, { env: TEST_ENV, config });
  const appStack = new AppStack(app, `crewreg-${config.envName}-app`, {
    env: TEST_ENV,
    config,
    vpc: data.vpc,
    databaseSecurityGroup: data.databaseSecurityGroup,
    secrets: data.secrets,
    hostedZone: dns?.zone,
  });
  appStack.addStackDependency(oidc);
  cdk.Tags.of(data).add(TAG_ENV, config.envName);
  cdk.Tags.of(appStack).add(TAG_ENV, config.envName);
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  applyNagSuppressions(data, appStack);
  return { app, oidc, dns, data, appStack, config };
}
