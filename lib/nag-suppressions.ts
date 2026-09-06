// cdk-nag (AwsSolutions) findings this MVP accepts on purpose, each with the
// reason. Anything not listed here fails `cdk synth`, so a new finding is a
// decision, not noise. Revisit every entry when the environment is `prod`.

import { IConstruct } from 'constructs';
import { NagPackSuppression, NagSuppressions } from 'cdk-nag';

import { AppStack } from './app-stack';
import { DataStack } from './data-stack';

export function applyNagSuppressions(data: DataStack, app: AppStack): void {
  suppressDataStack(data);
  suppressAppStack(app);
}

function suppressDataStack(stack: DataStack): void {
  NagSuppressions.addResourceSuppressions(stack.vpc, [
    { id: 'AwsSolutions-VPC7', reason: 'VPC flow logs cost money and this MVP has one instance whose traffic is already logged by Caddy.' },
  ]);

  NagSuppressions.addResourceSuppressions(stack.database, [
    { id: 'AwsSolutions-RDS3', reason: 'Single-AZ by design: Multi-AZ doubles the instance cost of an MVP that tolerates a maintenance-window outage.' },
    { id: 'AwsSolutions-RDS10', reason: 'Deletion protection is enabled for prod only; dev must be cheap to tear down, and removal takes a final snapshot.' },
    { id: 'AwsSolutions-RDS11', reason: 'The default port is kept so the cloud database matches the local docker-compose one; the instance is reachable only from the API security group.' },
    { id: 'AwsSolutions-RDS6', reason: 'The backend authenticates with a password from Secrets Manager (db.ConnectionConfig); it has no IAM database authentication path.' },
  ]);

  for (const secret of [stack.secrets.database, stack.secrets.auth, stack.secrets.llm]) {
    NagSuppressions.addResourceSuppressions(secret, [
      { id: 'AwsSolutions-SMG4', reason: 'The backend reads its secrets once at boot, so automatic rotation would break the running process; the LLM key is issued by a third party and cannot be rotated by AWS; rotating the signing key logs every user out by design (ADR 0021).' },
    ]);
  }

  // The VPC construct's "restrict default security group" custom resource is a
  // CDK-managed Lambda whose role and runtime CDK chooses. Its construct path
  // has moved between aws-cdk-lib releases, so it is found by id rather than
  // by a hard-coded path.
  suppressConstructsWithIdContaining(stack, 'VpcRestrictDefaultSG', [
    { id: 'AwsSolutions-IAM4', reason: 'CDK-managed custom resource provider for restricting the default security group.' },
    { id: 'AwsSolutions-IAM5', reason: 'CDK-managed custom resource provider for restricting the default security group.' },
    { id: 'AwsSolutions-L1', reason: 'CDK-managed custom resource provider; the runtime is chosen by aws-cdk-lib.' },
  ]);
}

function suppressAppStack(stack: AppStack): void {
  NagSuppressions.addResourceSuppressions(stack.artifactsBucket, [
    { id: 'AwsSolutions-S1', reason: 'Server access logging for a bucket that holds only build artifacts read by one instance role is not worth a second bucket.' },
  ]);

  NagSuppressions.addResourceSuppressions(stack.instance, [
    { id: 'AwsSolutions-EC28', reason: 'Detailed (1-minute) monitoring is a paid feature; 5-minute metrics are enough for an MVP.' },
    { id: 'AwsSolutions-EC29', reason: 'A single disposable instance by design: it is replaced on bootstrap changes and holds no state, so neither an ASG nor termination protection applies.' },
  ], true);

  NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/ApiSecurityGroup`, [
    { id: 'AwsSolutions-EC23', reason: 'A public API: 80 (ACME challenge and redirect) and 443 are open to the internet on purpose. No other port is.' },
  ], true);

  NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/InstanceRole`, [
    { id: 'AwsSolutions-IAM4', reason: 'AmazonSSMManagedInstanceCore is the AWS-maintained policy for Session Manager and Run Command; hand-copying it would drift.' },
    { id: 'AwsSolutions-IAM5', reason: 'Releases are read under the server/* prefix of one private bucket, and logs:DescribeLogGroups has no resource-level permission.' },
  ], true);

  NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/GithubDeployRole`, [
    { id: 'AwsSolutions-IAM5', reason: 'The deploy role may write releases under server/* only, may send one fixed-content SSM document (the deploy script) to instances carrying this environment tag only, and reads command results, which has no resource-level permission.' },
  ], true);

  // Bucket notifications / auto-delete handlers are not used, but the S3 L2
  // still emits a policy statement with a wildcard for the SSL-only condition.
  NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/Artifacts/Policy`, [
    { id: 'AwsSolutions-IAM5', reason: 'The bucket policy denies non-TLS access to every object, which needs the object wildcard.' },
  ], true);

}

/**
 * Applies suppressions to every construct in the stack whose id contains
 * `fragment`, and everything beneath it. Used for CDK-managed helpers whose
 * exact path is not stable across aws-cdk-lib versions.
 */
function suppressConstructsWithIdContaining(stack: IConstruct, fragment: string, suppressions: NagPackSuppression[]): void {
  const matches = stack.node.findAll().filter((c) => c.node.id.includes(fragment));
  for (const construct of matches) {
    NagSuppressions.addResourceSuppressions(construct, suppressions, true);
  }
}
