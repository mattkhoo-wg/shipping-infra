// The GitHub Actions OIDC identity provider. One per AWS account (the provider
// URL must be unique), so it is its own stack rather than part of an
// environment: a second environment reuses it. If the account already has one,
// set `-c crewreg:createGithubOidcProvider=false` and this stack is not created;
// the app stack builds the provider ARN from the account id either way.

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
export const GITHUB_OIDC_URL = `https://${GITHUB_OIDC_HOST}`;
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

/** ARN of the account's GitHub OIDC provider, whether or not this stack created it. */
export function githubOidcProviderArn(scope: Construct): string {
  return cdk.Stack.of(scope).formatArn({
    service: 'iam',
    region: '',
    resource: 'oidc-provider',
    resourceName: GITHUB_OIDC_HOST,
  });
}

export class GithubOidcStack extends cdk.Stack {
  readonly provider: iam.OidcProviderNative;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The native resource (no custom-resource Lambda). No thumbprints: IAM
    // validates GitHub's issuer against its trusted root CAs.
    this.provider = new iam.OidcProviderNative(this, 'GithubActions', {
      url: GITHUB_OIDC_URL,
      clientIds: [GITHUB_OIDC_AUDIENCE],
    });

    new cdk.CfnOutput(this, 'ProviderArn', { value: this.provider.oidcProviderArn });
  }
}
