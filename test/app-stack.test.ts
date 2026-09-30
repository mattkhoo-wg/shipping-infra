import { Match, Template } from 'aws-cdk-lib/assertions';

import { synthesizeEnvironment } from './helpers';

describe('AppStack', () => {
  const { appStack } = synthesizeEnvironment();
  const template = Template.fromStack(appStack);

  test('launches one t3.micro with IMDSv2, standard credits and an encrypted gp3 root volume', () => {
    template.resourceCountIs('AWS::EC2::Instance', 1);
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't3.micro',
      Monitoring: false,
      CreditSpecification: { CPUCredits: 'standard' },
      BlockDeviceMappings: [{
        DeviceName: '/dev/xvda',
        Ebs: Match.objectLike({ VolumeType: 'gp3', VolumeSize: 10, Encrypted: true, DeleteOnTermination: true }),
      }],
    });
    // arrayWith is order-sensitive and CloudFormation tags are sorted, so each
    // tag is asserted on its own.
    template.hasResourceProperties('AWS::EC2::Instance', { Tags: Match.arrayWith([{ Key: 'crewreg:role', Value: 'api' }]) });
    template.hasResourceProperties('AWS::EC2::Instance', { Tags: Match.arrayWith([{ Key: 'crewreg:env', Value: 'dev' }]) });
    template.hasResourceProperties('AWS::EC2::Instance', { Tags: Match.arrayWith([{ Key: 'Name', Value: 'crewreg-dev-api' }]) });
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: { HttpTokens: 'required' },
      }),
    });
  });

  test('opens only 80 and 443 to the internet and never 22 or 8080', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('API instance'),
      SecurityGroupIngress: [
        Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 80, ToPort: 80, IpProtocol: 'tcp' }),
        Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 443, ToPort: 443, IpProtocol: 'tcp' }),
      ],
    });
    const groups = template.findResources('AWS::EC2::SecurityGroup');
    for (const group of Object.values(groups)) {
      const ingress = (group.Properties?.SecurityGroupIngress ?? []) as Array<{ FromPort?: number }>;
      expect(ingress.map((r) => r.FromPort)).not.toContain(22);
      expect(ingress.map((r) => r.FromPort)).not.toContain(8080);
    }
    template.resourceCountIs('AWS::EC2::KeyPair', 0);
  });

  test('lets the instance, and only the instance, reach Postgres', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      GroupId: Match.objectLike({ 'Fn::ImportValue': Match.stringLikeRegexp('DatabaseSecurityGroup') }),
      SourceSecurityGroupId: Match.objectLike({ 'Fn::GetAtt': [Match.stringLikeRegexp('ApiSecurityGroup'), 'GroupId'] }),
    });
  });

  test('pins a fixed public address to the instance', () => {
    template.hasResourceProperties('AWS::EC2::EIP', { Domain: 'vpc' });
    template.hasResourceProperties('AWS::EC2::EIPAssociation', {
      InstanceId: { Ref: Match.stringLikeRegexp('^Api') },
    });
  });

  test('writes the API A record into the hosted zone, pointing at the Elastic IP', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.example.com.',
      Type: 'A',
      TTL: '300',
      ResourceRecords: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^Eip'), 'PublicIp'] }],
      HostedZoneId: Match.objectLike({ 'Fn::ImportValue': Match.stringLikeRegexp('crewreg-dns') }),
    });
  });

  test('imports an existing zone by id instead of creating one, and writes the A record there', () => {
    const imported = synthesizeEnvironment({ hostedZoneId: 'Z04086442AMPWSPJV0TW2' });
    expect(imported.dns).toBeUndefined();
    const t = Template.fromStack(imported.appStack);
    t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'api.example.com.', Type: 'A', HostedZoneId: 'Z04086442AMPWSPJV0TW2' });
    t.resourceCountIs('AWS::Route53::HostedZone', 0);
    expect(JSON.stringify(t.toJSON())).not.toContain('crewreg-dns');
  });

  test('leaves DNS to the registrar when no hosted zone is configured', () => {
    const manual = synthesizeEnvironment({ hostedZoneName: undefined });
    Template.fromStack(manual.appStack).resourceCountIs('AWS::Route53::RecordSet', 0);
    Template.fromStack(manual.appStack).hasOutput('ElasticIp', { Description: Match.stringLikeRegexp('Point the A record') });
  });

  test('keeps CVs in a private, TLS-only bucket that survives destroy', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
    const cv = Object.entries(template.findResources('AWS::S3::Bucket')).find(([id]) => id.startsWith('CvDocuments'));
    expect(cv).toBeDefined();
    const [, resource] = cv!;
    expect(resource.DeletionPolicy).toBe('Retain');
    expect(resource.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
    expect(resource.Properties.BucketEncryption).toBeDefined();
    template.hasOutput('CvBucket', { Value: { Ref: Match.stringLikeRegexp('^CvDocuments') } });
  });

  test('creates the SES domain identity for the sender and writes its DKIM records into the zone', () => {
    template.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'example.com' });
    const dkim = Object.values(template.findResources('AWS::Route53::RecordSet', { Properties: { Type: 'CNAME' } }));
    expect(dkim).toHaveLength(3);
    for (const record of dkim) {
      // SES returns the full name; a zone suffix appended on top would never verify.
      expect(Match.exact({ 'Fn::Join': ['', [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^MailIdentity'), Match.stringLikeRegexp('^DkimDNSTokenName')] }, '.']] }).test(record.Properties.Name).hasFailed()).toBe(false);
      expect(JSON.stringify(record.Properties.ResourceRecords)).toContain('DkimDNSTokenValue');
    }
    template.hasOutput('MailIdentityName', { Value: { Ref: Match.stringLikeRegexp('^MailIdentity') } });
  });

  test('outputs the DKIM records for the registrar when there is no zone', () => {
    const manual = Template.fromStack(synthesizeEnvironment({ hostedZoneName: undefined }).appStack);
    manual.resourceCountIs('AWS::Route53::RecordSet', 0);
    for (const n of [1, 2, 3]) {
      manual.hasOutput(`MailDkimRecord${n}`, { Description: Match.stringLikeRegexp('registrar') });
    }
  });

  test('keeps releases in a private, versioned, TLS-only bucket that survives destroy', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: Match.objectLike({ ServerSideEncryptionConfiguration: Match.anyValue() }),
      LifecycleConfiguration: { Rules: [Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 }, Status: 'Enabled' })] },
    });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });

  test('grants the instance role SSM, its three secrets and read on releases only', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'crewreg-dev-api-instance',
      AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: 'ec2.amazonaws.com' } })] },
      ManagedPolicyArns: [Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('AmazonSSMManagedInstanceCore')])]) })],
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: Match.stringLikeRegexp('InstanceRoleDefaultPolicy'),
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'] }),
          Match.objectLike({
            Action: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
            Resource: Match.arrayWith([Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith(['/server/*'])]) })]),
          }),
        ]),
      },
    });
    const policies = template.findResources('AWS::IAM::Policy');
    const instancePolicy = Object.values(policies).find((p) => String(p.Properties?.PolicyName).includes('InstanceRoleDefaultPolicy'));
    const statements = instancePolicy?.Properties?.PolicyDocument?.Statement as Array<{ Action: string | string[]; Resource: unknown }>;
    const withPut = statements.filter((s) => JSON.stringify(s.Action).includes('s3:PutObject'));
    expect(withPut).toHaveLength(1);
    expect(JSON.stringify(withPut[0].Resource)).toContain('CvDocuments');
    expect(JSON.stringify(withPut[0].Resource)).not.toContain('Artifacts');
    const actions = JSON.stringify(instancePolicy?.Properties?.PolicyDocument);
    expect(actions).not.toContain('s3:DeleteObject');
    expect(actions).not.toContain('ssm:SendCommand');
  });

  test('lets the instance send mail as its identity and check that identity, nothing more in SES', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: Match.stringLikeRegexp('InstanceRoleDefaultPolicy'),
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ses:SendEmail', 'ses:SendRawEmail'],
            Resource: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(':ses:ap-south-1:123456789012:identity/')])]) }),
          }),
          Match.objectLike({
            Sid: 'CheckMailIdentity',
            Action: 'ses:GetEmailIdentity',
            Resource: Match.arrayWith([Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('identity/no-reply@example.com')])]) })]),
          }),
        ]),
      },
    });
    const instancePolicy = Object.values(template.findResources('AWS::IAM::Policy')).find((p) => String(p.Properties?.PolicyName).includes('InstanceRoleDefaultPolicy'));
    expect(JSON.stringify(instancePolicy?.Properties?.PolicyDocument)).not.toContain('"ses:*"');
  });

  test('creates the GitHub deploy role trusting one repository and one environment', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'crewreg-dev-github-deploy',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('oidc-provider/token.actions.githubusercontent.com')])]) }) },
          Condition: {
            StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
            StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:mattkhoo-wg/shipping-backend:environment:dev' },
          },
        })],
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyName: Match.stringLikeRegexp('GithubDeployRoleDefaultPolicy'),
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'UploadReleases', Action: ['s3:PutObject', 's3:AbortMultipartUpload'] }),
          Match.objectLike({
            Sid: 'SendToTaggedInstances',
            Action: 'ssm:SendCommand',
            Condition: { StringEquals: { 'ssm:resourceTag/crewreg:env': 'dev' } },
          }),
          Match.objectLike({
            Sid: 'SendDeployDocumentOnly',
            Action: 'ssm:SendCommand',
            Resource: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(':document/crewreg-dev-deploy$')])]) }),
          }),
        ]),
      },
    });
    const policy = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policy).not.toContain('AWS-RunShellScript');
  });

  test('fixes the deploy command in an SSM document that takes only a git sha', () => {
    template.hasResourceProperties('AWS::SSM::Document', {
      Name: 'crewreg-dev-deploy',
      DocumentType: 'Command',
      UpdateMethod: 'NewVersion',
      Content: Match.objectLike({
        schemaVersion: '2.2',
        parameters: { Sha: Match.objectLike({ type: 'String', allowedPattern: '^[0-9a-f]{7,40}$' }) },
        mainSteps: [Match.objectLike({
          action: 'aws:runShellScript',
          inputs: Match.objectLike({ runCommand: ['/usr/local/bin/crewreg-deploy {{ Sha }}'] }),
        })],
      }),
    });
    template.hasOutput('DeployDocument', { Value: 'crewreg-dev-deploy' });
  });

  test('sets a monthly budget with actual and forecast alerts', () => {
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { BudgetName: 'crewreg-dev-monthly', BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: 40, Unit: 'USD' } },
      NotificationsWithSubscribers: [
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 80 }), Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'billing@example.com' }] }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }) }),
      ],
    });
  });

  test('manages log retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/crewreg/dev/server', RetentionInDays: 14 });
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: '/crewreg/dev/caddy', RetentionInDays: 14 });
  });

  test('outputs everything the GitHub environment and the DNS record need', () => {
    for (const name of ['ElasticIp', 'ApiHost', 'ArtifactsBucket', 'CvBucket', 'MailIdentityName', 'DeployRoleArn', 'Region', 'InstanceId', 'SessionCommand']) {
      template.hasOutput(name, Match.anyValue());
    }
    template.hasOutput('ApiHost', { Value: 'api.example.com' });
    template.hasOutput('Region', { Value: 'ap-south-1' });
  });

  test('honours an AMI pin and a Graviton instance type', () => {
    const pinned = synthesizeEnvironment({ amiId: 'ami-0fedcba9876543210', instanceType: 't4g.micro' });
    Template.fromStack(pinned.appStack).hasResourceProperties('AWS::EC2::Instance', {
      ImageId: 'ami-0fedcba9876543210',
      InstanceType: 't4g.micro',
    });
  });

  test('looks up the latest Amazon Linux 2023 image when no AMI is pinned', () => {
    // Without account context the lookup resolves to a placeholder that names
    // the SSM parameter; that is enough to prove the lookup path and the
    // architecture it asks for.
    const looked = synthesizeEnvironment({ amiId: undefined });
    Template.fromStack(looked.appStack).hasResourceProperties('AWS::EC2::Instance', {
      ImageId: Match.stringLikeRegexp('al2023-ami-kernel-.*-x86_64'),
    });
    const arm = synthesizeEnvironment({ amiId: undefined, instanceType: 't4g.micro' });
    Template.fromStack(arm.appStack).hasResourceProperties('AWS::EC2::Instance', {
      ImageId: Match.stringLikeRegexp('al2023-ami-kernel-.*-arm64'),
    });
  });
});
