import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { GithubOidcStack, githubOidcProviderArn } from '../lib/github-oidc-stack';
import { TEST_ENV } from './helpers';

describe('GithubOidcStack', () => {
  test('creates the GitHub Actions provider natively, for the STS audience', () => {
    const app = new cdk.App();
    const stack = new GithubOidcStack(app, 'crewreg-github-oidc', { env: TEST_ENV });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.hasOutput('ProviderArn', {});
  });

  test('derives the provider ARN from the account without a cross-stack export', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'any', { env: TEST_ENV });

    const arn = JSON.stringify(stack.resolve(githubOidcProviderArn(stack)));

    expect(arn).toContain('AWS::Partition');
    expect(arn).toContain(':iam::123456789012:oidc-provider/token.actions.githubusercontent.com');
    expect(arn).not.toContain('ImportValue');
  });
});
