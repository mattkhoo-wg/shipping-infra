// The public hosted zone for the owner's domain. One per account, shared by
// every environment and by the frontend: the app stack writes the API's A
// record into it, and Amplify writes its own records for the frontend's
// custom domain. The registrar (Namecheap) is pointed at this zone's four
// nameservers once, by hand, and never touched again.
//
// The zone is RETAINED on stack deletion. Deleting it would change the
// domain's nameservers out from under the registrar and take every record
// with it, which is never what `cdk destroy` of an MVP environment means.

import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export interface DnsStackProps extends cdk.StackProps {
  /** Apex of the zone, e.g. `example.com`. */
  readonly zoneName: string;
}

export class DnsStack extends cdk.Stack {
  readonly zone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    this.zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: props.zoneName,
      comment: 'crewreg: the API A record is managed by the app stack; the frontend (Amplify) adds its own records',
    });
    this.zone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(' ', this.zone.hostedZoneNameServers ?? []),
      description: `Set these four as Custom DNS nameservers for ${props.zoneName} at the registrar`,
    });
    new cdk.CfnOutput(this, 'HostedZoneId', { value: this.zone.hostedZoneId });
  }
}
