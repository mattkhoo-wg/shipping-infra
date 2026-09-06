// The compute half of one environment: the API instance and everything that
// exists to run or deploy it. Nothing here holds state; the instance is
// replaced whenever its bootstrap changes and comes back on the last deployed
// release.

import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

import { EnvironmentConfig, instanceArchitecture } from './config';
import { BackendSecrets, DATABASE_PORT } from './data-stack';
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_HOST, githubOidcProviderArn } from './github-oidc-stack';
import { renderUserData } from './user-data';

export interface AppStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly databaseSecurityGroup: ec2.ISecurityGroup;
  readonly secrets: BackendSecrets;
}

/** Caddy release installed on the instance. Bump deliberately; it replaces the instance. */
export const CADDY_VERSION = '2.11.4';

/** Tag keys the deploy role's SSM permission and the workflows target. */
export const TAG_ENV = 'crewreg:env';
export const TAG_ROLE = 'crewreg:role';
export const ROLE_API = 'api';

/** Key prefix in the artifacts bucket under which releases live. */
export const RELEASE_PREFIX = 'server/';

/** Where the bootstrap installs the deploy script; the SSM document runs exactly this. */
export const DEPLOY_SCRIPT_PATH = '/usr/local/bin/crewreg-deploy';

/** Name of the SSM document for an environment. The Deploy workflow derives it the same way. */
export function deployDocumentName(envName: string): string {
  return `crewreg-${envName}-deploy`;
}

export class AppStack extends cdk.Stack {
  readonly instance: ec2.Instance;
  readonly artifactsBucket: s3.Bucket;
  readonly deployRole: iam.Role;
  readonly deployDocument: ssm.CfnDocument;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, vpc, secrets } = props;
    const env = config.envName;

    // Releases. Versioned so an overwritten `server/current` pointer can be
    // recovered; old object versions age out after a month. Retained on
    // destroy: the contents are rebuildable from git, but deleting a bucket
    // with history in it should be a person's decision.
    this.artifactsBucket = new s3.Bucket(this, 'Artifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(30) }],
    });

    // Log groups are created here so retention is managed; the agent would
    // otherwise create them with no expiry.
    const serverLogGroup = new logs.LogGroup(this, 'ServerLogs', {
      logGroupName: `/crewreg/${env}/server`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const caddyLogGroup = new logs.LogGroup(this, 'CaddyLogs', {
      logGroupName: `/crewreg/${env}/caddy`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Inbound: only what Caddy serves. 80 exists for the ACME challenge and the
    // redirect; 443 is the API. 8080 is never opened: the binary binds it, but
    // only Caddy on the same host talks to it. No SSH: access is SSM.
    const securityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      description: `crewreg ${env} API instance: HTTPS in, everything out`,
      allowAllOutbound: true,
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'ACME challenge and redirect to HTTPS');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'API over HTTPS');
    // Declared as a standalone rule IN THIS STACK. Calling addIngressRule on
    // the database group would put the rule in the data stack, which would
    // then depend on this stack while this stack depends on it (a cycle).
    new ec2.CfnSecurityGroupIngress(this, 'DatabaseIngressFromApi', {
      groupId: props.databaseSecurityGroup.securityGroupId,
      sourceSecurityGroupId: securityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: DATABASE_PORT,
      toPort: DATABASE_PORT,
      description: 'Postgres from the API instance',
    });

    // What the process on the box may do. Read its three secrets, read
    // releases, be an SSM managed node, ship logs. Nothing else.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      roleName: `crewreg-${env}-api-instance`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: `crewreg ${env} API instance: read secrets and releases, SSM, CloudWatch logs`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    secrets.database.grantRead(instanceRole);
    secrets.auth.grantRead(instanceRole);
    secrets.llm.grantRead(instanceRole);
    this.artifactsBucket.grantRead(instanceRole, `${RELEASE_PREFIX}*`);
    serverLogGroup.grantWrite(instanceRole);
    caddyLogGroup.grantWrite(instanceRole);
    instanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DescribeLogGroupsForAgent',
      actions: ['logs:DescribeLogGroups'],
      resources: ['*'],
    }));

    const userData = ec2.UserData.custom(renderUserData({
      config,
      artifactsBucket: this.artifactsBucket.bucketName,
      serverLogGroup: serverLogGroup.logGroupName,
      caddyLogGroup: caddyLogGroup.logGroupName,
      caddyVersion: CADDY_VERSION,
    }));

    const arch = instanceArchitecture(config.instanceType);
    const machineImage = config.amiId !== undefined
      ? ec2.MachineImage.genericLinux({ [config.region]: config.amiId })
      : ec2.MachineImage.latestAmazonLinux2023({
        cpuType: arch === 'arm64' ? ec2.AmazonLinuxCpuType.ARM_64 : ec2.AmazonLinuxCpuType.X86_64,
        cachedInContext: true,
      });

    this.instance = new ec2.Instance(this, 'Api', {
      instanceName: `crewreg-${env}-api`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage,
      securityGroup,
      role: instanceRole,
      userData,
      // The bootstrap IS the instance: change it and get a fresh box rather
      // than a box that half-applied the change. All state is in RDS and S3.
      userDataCausesReplacement: true,
      requireImdsv2: true,
      detailedMonitoring: false,
      // Standard credits cannot run a surprise bill; the instance just slows
      // down when it has burnt its CPU credits.
      creditSpecification: ec2.CpuCredits.STANDARD,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(10, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
          deleteOnTermination: true,
        }),
      }],
    });
    cdk.Tags.of(this.instance).add(TAG_ROLE, ROLE_API);
    if (config.amiId !== undefined) {
      // A pinned AMI is a deliberate operator choice (see config.ts), not an
      // accident the template validator needs to warn about on every synth.
      cdk.Validations.of(this.instance).acknowledge({
        id: 'CloudFormation-Validate::W9010',
        reason: `amiId is pinned on purpose for ${env}; the default path looks the AMI up and caches it in cdk.context.json`,
      });
    }

    // A fixed address for the DNS A record in Namecheap. Re-associated with
    // whatever instance replaces this one.
    const eip = new ec2.CfnEIP(this, 'Eip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `crewreg-${env}-api` }],
    });
    new ec2.CfnEIPAssociation(this, 'EipAssociation', {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    this.deployDocument = this.createDeployDocument(config);
    this.deployRole = this.createDeployRole(config);
    this.createBudget(config);

    new cdk.CfnOutput(this, 'ElasticIp', {
      value: eip.attrPublicIp,
      description: `Point the A record for ${config.apiHost} at this address`,
    });
    new cdk.CfnOutput(this, 'ApiHost', { value: config.apiHost, description: 'GitHub environment variable API_HOST' });
    new cdk.CfnOutput(this, 'ArtifactsBucket', { value: this.artifactsBucket.bucketName, description: 'GitHub environment variable ARTIFACTS_BUCKET' });
    new cdk.CfnOutput(this, 'DeployRoleArn', { value: this.deployRole.roleArn, description: 'GitHub environment variable AWS_ROLE_ARN' });
    new cdk.CfnOutput(this, 'Region', { value: config.region, description: 'GitHub environment variable AWS_REGION' });
    new cdk.CfnOutput(this, 'DeployDocument', { value: deployDocumentName(env), description: 'SSM document the deploy role may send (derived from the environment name)' });
    new cdk.CfnOutput(this, 'InstanceId', { value: this.instance.instanceId, description: 'Current instance (changes on replacement; the deploy targets tags, not this id)' });
    new cdk.CfnOutput(this, 'SessionCommand', {
      value: `aws ssm start-session --region ${config.region} --target ${this.instance.instanceId}`,
      description: 'Shell on the instance (no SSH)',
    });
  }

  /**
   * The one command the deploy role may run on the instance. A custom SSM
   * document whose content is fixed here: the deploy script with a single
   * parameter, constrained to a git sha. The generic AWS-RunShellScript
   * document would let whoever holds the role run anything as root, and the
   * instance role can read every secret, so "anything as root" would mean
   * every secret. IAM cannot restrict a document's parameters, so the
   * restriction has to live in the document itself.
   */
  private createDeployDocument(config: EnvironmentConfig): ssm.CfnDocument {
    return new ssm.CfnDocument(this, 'DeployCommand', {
      name: deployDocumentName(config.envName),
      documentType: 'Command',
      documentFormat: 'JSON',
      // A named document cannot be replaced in place; new content becomes a
      // new default version instead.
      updateMethod: 'NewVersion',
      content: {
        schemaVersion: '2.2',
        description: `Install one release of the crewreg backend on the ${config.envName} instance and switch the service to it.`,
        parameters: {
          Sha: {
            type: 'String',
            description: 'git commit sha of the release under server/<sha>/ in the artifacts bucket',
            allowedPattern: '^[0-9a-f]{7,40}$',
          },
        },
        mainSteps: [{
          action: 'aws:runShellScript',
          name: 'deploy',
          inputs: {
            timeoutSeconds: '600',
            runCommand: [`${DEPLOY_SCRIPT_PATH} {{ Sha }}`],
          },
        }],
      },
    });
  }

  /**
   * The role the backend repo's Deploy workflow assumes through GitHub OIDC.
   * Trust is pinned to one repository AND one GitHub environment, so a job that
   * does not declare `environment: <env>` cannot assume it. It may write
   * releases and send the deploy document to instances tagged for this
   * environment, and nothing else: no other document, so no other command.
   */
  private createDeployRole(config: EnvironmentConfig): iam.Role {
    const env = config.envName;
    const role = new iam.Role(this, 'GithubDeployRole', {
      roleName: `crewreg-${env}-github-deploy`,
      description: `crewreg ${env}: assumed by ${config.githubRepo} GitHub Actions (environment ${env}) to deploy the backend`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubOidcProviderArn(this), {
        StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE },
        StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: `repo:${config.githubRepo}:environment:${env}` },
      }),
    });

    role.addToPolicy(new iam.PolicyStatement({
      sid: 'UploadReleases',
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: [this.artifactsBucket.arnForObjects(`${RELEASE_PREFIX}*`)],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'SendToTaggedInstances',
      actions: ['ssm:SendCommand'],
      resources: [this.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' })],
      conditions: { StringEquals: { [`ssm:resourceTag/${TAG_ENV}`]: env } },
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'SendDeployDocumentOnly',
      actions: ['ssm:SendCommand'],
      resources: [this.formatArn({ service: 'ssm', resource: 'document', resourceName: deployDocumentName(env) })],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadCommandResults',
      actions: ['ssm:ListCommandInvocations', 'ssm:GetCommandInvocation', 'ssm:ListCommands'],
      resources: ['*'],
    }));
    return role;
  }

  /**
   * An account-wide monthly cost alert. Budgets cost nothing for the first two
   * and are the cheapest guard against a forgotten resource.
   */
  private createBudget(config: EnvironmentConfig): void {
    const subscribers = [{ subscriptionType: 'EMAIL', address: config.budgetEmail }];
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `crewreg-${config.envName}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.budgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers,
        },
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers,
        },
      ],
    });
  }
}
