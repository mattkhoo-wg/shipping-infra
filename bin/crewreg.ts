#!/usr/bin/env node
// CDK app entry point. One environment per synth, selected with `-c env=<name>`
// (default `dev`); its settings come from the `crewreg.<name>` block in cdk.json.
//
//   npx cdk synth                 # dev
//   npx cdk deploy --all          # dev: oidc provider, data, app
//   npx cdk deploy -c env=prod --all

import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

import { AppStack, TAG_ENV } from '../lib/app-stack';
import { loadEnvironmentConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { DnsStack } from '../lib/dns-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { applyNagSuppressions } from '../lib/nag-suppressions';

const app = new cdk.App();

const envName: string = app.node.tryGetContext('env') ?? 'dev';
const config = loadEnvironmentConfig(app, envName);

// Account comes from the credentials in use (CDK_DEFAULT_ACCOUNT); the region
// is fixed by the environment so nobody deploys Mumbai's stacks to Virginia by
// having the wrong default region set.
const env: cdk.Environment = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

// The AMI lookup needs a concrete account. Without credentials CDK's own error
// is about "context provider ssm", which does not say what to do.
if (env.account === undefined && config.amiId === undefined) {
  throw new Error(
    'no AWS account resolved (run `aws sso login` or set AWS_PROFILE), or synthesize offline with `-c amiId=ami-...`',
  );
}

cdk.Tags.of(app).add('crewreg:project', 'crewreg');

const createOidc = app.node.tryGetContext('crewreg:createGithubOidcProvider') !== false;
const oidc = createOidc ? new GithubOidcStack(app, 'crewreg-github-oidc', { env }) : undefined;

// The hosted zone is account-level like the OIDC provider: one zone, every
// environment writes its own records into it. A zone that already exists
// (hostedZoneId set) is imported by the app stack instead of created here.
const createZone = config.hostedZoneName !== undefined && config.hostedZoneId === undefined;
const dns = createZone
  ? new DnsStack(app, 'crewreg-dns', { env, zoneName: config.hostedZoneName!, description: `crewreg: Route 53 hosted zone for ${config.hostedZoneName}` })
  : undefined;

const data = new DataStack(app, `crewreg-${envName}-data`, {
  env,
  config,
  terminationProtection: envName === 'prod',
  description: `crewreg ${envName}: VPC, Postgres and the backend's secrets`,
});

const appStack = new AppStack(app, `crewreg-${envName}-app`, {
  env,
  config,
  vpc: data.vpc,
  databaseSecurityGroup: data.databaseSecurityGroup,
  secrets: data.secrets,
  hostedZone: dns?.zone,
  description: `crewreg ${envName}: API instance, releases bucket, GitHub deploy role, budget`,
});
if (oidc !== undefined) {
  appStack.addStackDependency(oidc);
}

// The env tag is what the deploy role's SSM permission and the Deploy workflow
// target, so it is applied to the whole environment rather than one resource.
cdk.Tags.of(data).add(TAG_ENV, envName);
cdk.Tags.of(appStack).add(TAG_ENV, envName);

cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
applyNagSuppressions(data, appStack);
