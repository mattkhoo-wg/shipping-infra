import { Annotations, Match } from 'aws-cdk-lib/assertions';

import { synthesizeEnvironment } from './helpers';

// cdk-nag runs as an aspect in bin/crewreg.ts and fails `cdk synth` on any
// unsuppressed error. This test makes that gate part of `npm test`, so a new
// finding is seen here first with its rule id and path.
describe('cdk-nag AwsSolutions', () => {
  const { oidc, data, appStack } = synthesizeEnvironment();

  test.each([
    ['github-oidc', oidc],
    ['data', data],
    ['app', appStack],
  ])('%s stack has no unsuppressed errors', (_name, stack) => {
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));

    expect(errors.map((e) => `${e.id}: ${JSON.stringify(e.entry.data)}`)).toEqual([]);
  });

  test.each([
    ['github-oidc', oidc],
    ['data', data],
    ['app', appStack],
  ])('%s stack has no unsuppressed warnings', (_name, stack) => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));

    expect(warnings.map((w) => `${w.id}: ${JSON.stringify(w.entry.data)}`)).toEqual([]);
  });
});
