import { Match, Template } from 'aws-cdk-lib/assertions';

import { synthesizeEnvironment } from './helpers';

describe('DataStack', () => {
  const { data } = synthesizeEnvironment();
  const template = Template.fromStack(data);

  test('builds a two-AZ VPC with public and isolated subnets and no NAT gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::Subnet', 4);
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.20.0.0/16' });
  });

  test('runs the smallest encrypted Single-AZ Postgres, private, with backups and a final snapshot', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DBInstanceIdentifier: 'crewreg-dev',
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16\\.'),
      DBInstanceClass: 'db.t4g.micro',
      AllocatedStorage: '20',
      StorageType: 'gp3',
      StorageEncrypted: true,
      MultiAZ: false,
      PubliclyAccessible: false,
      BackupRetentionPeriod: 7,
      DeletionProtection: false,
      DBName: 'crewreg',
      Port: '5432',
      MasterUsername: 'crew',
      AutoMinorVersionUpgrade: true,
      EnablePerformanceInsights: false,
    });
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
    });
    template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
      SubnetIds: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp('isolated') })]),
    });
  });

  test('takes the database password from the backend-shaped secret', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      MasterUserPassword: Match.objectLike({
        'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(':SecretString:password::')])]),
      }),
    });
    template.resourceCountIs('AWS::SecretsManager::SecretTargetAttachment', 1);
  });

  test('creates the three secrets the config loader fetches, with its JSON keys', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'dev/database',
      GenerateSecretString: {
        SecretStringTemplate: JSON.stringify({ user: 'crew', username: 'crew', dbname: 'crewreg', port: 5432, sslmode: 'require' }),
        GenerateStringKey: 'password',
        PasswordLength: 32,
        ExcludePunctuation: true,
      },
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'dev/auth',
      GenerateSecretString: { SecretStringTemplate: '{}', GenerateStringKey: 'signing_key', PasswordLength: 64, ExcludePunctuation: true },
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'dev/llm',
      GenerateSecretString: {
        SecretStringTemplate: JSON.stringify({ provider: 'gemini', text_model: 'gemini-flash-lite-latest', vision_model: 'gemini-3.5-flash', max_tokens: 8192 }),
        GenerateStringKey: 'api_key',
      },
    });
    template.resourceCountIs('AWS::SecretsManager::Secret', 3);
  });

  test('gives the database security group no inbound rule of its own and no outbound', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('database'),
      SecurityGroupIngress: Match.absent(),
      SecurityGroupEgress: [Match.objectLike({ CidrIp: '255.255.255.255/32' })],
    });
  });

  test('protects prod with deletion protection', () => {
    const prod = synthesizeEnvironment({ envName: 'prod' });
    Template.fromStack(prod.data).hasResourceProperties('AWS::RDS::DBInstance', { DeletionProtection: true });
  });
});
