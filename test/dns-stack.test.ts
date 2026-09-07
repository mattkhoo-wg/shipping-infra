import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { DnsStack } from '../lib/dns-stack';
import { TEST_ENV } from './helpers';

describe('DnsStack', () => {
  const app = new cdk.App();
  const stack = new DnsStack(app, 'crewreg-dns', { env: TEST_ENV, zoneName: 'example.com' });
  const template = Template.fromStack(stack);

  test('creates one public hosted zone for the apex', () => {
    template.resourceCountIs('AWS::Route53::HostedZone', 1);
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'example.com.' });
  });

  test('never deletes the zone with the stack', () => {
    template.hasResource('AWS::Route53::HostedZone', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  test('outputs the nameservers for the registrar and the zone id', () => {
    template.hasOutput('NameServers', { Value: Match.objectLike({ 'Fn::Join': Match.anyValue() }) });
    template.hasOutput('HostedZoneId', { Value: { Ref: Match.stringLikeRegexp('^Zone') } });
  });
});
