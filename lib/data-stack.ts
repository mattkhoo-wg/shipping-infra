// The stateful half of one environment: the VPC, the Postgres instance and the
// three secrets the backend reads at boot. It is a separate stack from the
// compute so that tearing down or replacing the instance can never take the
// database with it, and so `prod` can carry termination protection on exactly
// the resources that hold data.

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { EnvironmentConfig } from './config';

export interface DataStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/** Postgres role the backend connects as. Also the `user` key of the database secret. */
export const DATABASE_USER = 'crew';
/** Database name. Matches the local docker-compose so nothing differs between laptop and cloud. */
export const DATABASE_NAME = 'crewreg';
export const DATABASE_PORT = 5432;

/** Secrets the backend's config loader fetches as `<env>/<section>` (ADR 0015). */
export interface BackendSecrets {
  readonly database: secretsmanager.ISecret;
  readonly auth: secretsmanager.ISecret;
  readonly llm: secretsmanager.ISecret;
}

export class DataStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly databaseSecurityGroup: ec2.SecurityGroup;
  readonly database: rds.DatabaseInstance;
  readonly secrets: BackendSecrets;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config } = props;
    const env = config.envName;

    // Two AZs because an RDS subnet group needs two even for a Single-AZ
    // instance. No NAT gateway: the only thing that needs the internet is the
    // API instance, which sits in a public subnet with its own address. The
    // database lives in isolated subnets with no route out at all.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `crewreg-${env}`,
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: `crewreg ${env} database: Postgres from the API instance only`,
      allowAllOutbound: false,
    });

    // The database secret is shaped for the backend, not for RDS. Its JSON keys
    // are exactly db.ConnectionConfig's json tags (host, port, user, password,
    // dbname, sslmode). RDS attaches host, port and dbname after the instance
    // exists; the password is generated here; user and sslmode are fixed.
    //
    // `username` duplicates `user`: the RDS secret attachment refuses to attach
    // unless the secret holds keys named exactly `username` and `password`
    // (verified by a failed first deploy), and the backend ignores keys it does
    // not know. Both must stay, and must stay equal.
    //
    // No punctuation in the password: common/db builds a keyword/value DSN
    // without quoting, so a space, quote or backslash would break the connect.
    const databaseSecret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      secretName: `${env}/database`,
      description: `crewreg ${env}: the backend's database section (db.ConnectionConfig)`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          user: DATABASE_USER,
          username: DATABASE_USER,
          dbname: DATABASE_NAME,
          port: DATABASE_PORT,
          sslmode: 'require',
        }),
        generateStringKey: 'password',
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    // The session-token signing key (ADR 0021). Generated once; rotating it
    // invalidates every token in circulation, which is the only revocation a
    // stateless session has, so it is not rotated automatically.
    const authSecret = new secretsmanager.Secret(this, 'AuthSecret', {
      secretName: `${env}/auth`,
      description: `crewreg ${env}: the backend's auth section (session signing key)`,
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'signing_key',
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    // The LLM section. Provider and models are not secret but the backend
    // fetches the whole section as one JSON document, so they live here. The
    // generated api_key is a placeholder that boots the service and fails every
    // model call; the operator replaces it once with scripts/set-llm-key.sh.
    // After that, edit models in the secret, not here: changing this template
    // regenerates the secret and wipes the real key.
    const llmSecret = new secretsmanager.Secret(this, 'LlmSecret', {
      secretName: `${env}/llm`,
      description: `crewreg ${env}: the backend's llm section. Set api_key with scripts/set-llm-key.sh`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          provider: config.llm.provider,
          text_model: config.llm.textModel,
          vision_model: config.llm.visionModel,
          max_tokens: config.llm.maxTokens,
        }),
        generateStringKey: 'api_key',
        passwordLength: 32,
        excludePunctuation: true,
      },
    });

    this.secrets = { database: databaseSecret, auth: authSecret, llm: llmSecret };

    // Smallest Postgres RDS can run. Single-AZ, encrypted, seven daily backups
    // kept inside the free backup allowance, snapshot on delete so a `cdk
    // destroy` leaves the data recoverable. Not publicly accessible: the only
    // path in is the security group rule the app stack adds for the instance.
    this.database = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: `crewreg-${env}`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_13 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.databaseSecurityGroup],
      credentials: rds.Credentials.fromSecret(databaseSecret, DATABASE_USER),
      databaseName: DATABASE_NAME,
      port: DATABASE_PORT,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      autoMinorVersionUpgrade: true,
      backupRetention: cdk.Duration.days(7),
      deleteAutomatedBackups: true,
      deletionProtection: env === 'prod',
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      enablePerformanceInsights: false,
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
      description: 'Postgres endpoint (also written into the database secret as host)',
    });
    new cdk.CfnOutput(this, 'SecretNames', {
      value: `${env}/database ${env}/auth ${env}/llm`,
      description: 'Secrets Manager names the backend reads at boot',
    });
  }
}
