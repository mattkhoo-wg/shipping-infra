import * as cdk from 'aws-cdk-lib';

import { instanceArchitecture, isOrigin, loadEnvironmentConfig, mailFromDomain, validateEnvironmentConfig } from '../lib/config';
import { TEST_CONTEXT } from './helpers';

const raw = () => JSON.parse(JSON.stringify(TEST_CONTEXT.crewreg.dev)) as Record<string, unknown>;

describe('validateEnvironmentConfig', () => {
  test('accepts the example configuration and normalises the hostname', () => {
    const cfg = validateEnvironmentConfig('dev', { ...raw(), apiHost: 'API.Example.com ' });

    expect(cfg.envName).toBe('dev');
    expect(cfg.apiHost).toBe('api.example.com');
    expect(cfg.corsAllowedOrigins).toEqual(TEST_CONTEXT.crewreg.dev.corsAllowedOrigins);
    expect(cfg.llm.provider).toBe('gemini');
    expect(cfg.amiId).toBeUndefined();
    expect(cfg.hostedZoneId).toBeUndefined();
    expect(cfg.frontendOrigin).toBe('https://app.example.com');
    expect(cfg.mailFrom).toBe('Crewreg <no-reply@example.com>');
    expect(cfg.mailDomain).toBe('example.com');
  });

  test.each([
    ['local', 'environment must be one of'],
    ['production', 'environment must be one of'],
  ])('rejects environment %s', (env, message) => {
    expect(() => validateEnvironmentConfig(env, raw())).toThrow(message);
  });

  test.each<[string, unknown, string]>([
    ['region', 'mumbai', 'not an AWS region'],
    ['apiHost', 'https://api.example.com', 'not a DNS hostname'],
    ['apiHost', 'api.example.com/v1', 'not a DNS hostname'],
    ['apiHost', '', 'is required'],
    ['acmeEmail', 'not-an-email', 'not an email address'],
    ['budgetEmail', 'billing@', 'not an email address'],
    ['budgetUsd', 0, 'positive integer'],
    ['budgetUsd', '40', 'positive integer'],
    ['budgetUsd', 12.5, 'positive integer'],
    ['corsAllowedOrigins', 'https://app.example.com', 'array of strings'],
    ['corsAllowedOrigins', ['https://app.example.com/'], 'corsAllowedOrigins[0]'],
    ['corsAllowedOrigins', ['https://ok.example.com', 'app.example.com'], 'corsAllowedOrigins[1]'],
    ['corsAllowedOrigins', ['*'], 'corsAllowedOrigins[0]'],
    ['githubRepo', 'shipping-backend', 'owner/repo'],
    ['instanceType', 'micro', 'not an EC2 instance type'],
    ['amiId', 'ami', 'ami-0123456789abcdef0'],
    ['amiId', 42, 'ami-0123456789abcdef0'],
    ['hostedZoneName', 'not a zone', 'DNS name'],
    ['hostedZoneName', 'other.com', 'not inside hostedZoneName'],
    ['hostedZoneId', 'zone-1', 'hosted zone id'],
    ['hostedZoneId', 42, 'hosted zone id'],
    ['frontendOrigin', 'app.example.com', 'frontendOrigin'],
    ['frontendOrigin', 'https://app.example.com/', 'frontendOrigin'],
    ['frontendOrigin', '', 'is required'],
    ['mailFrom', 'no-reply', 'local@domain'],
    ['mailFrom', '"Crewreg" <no-reply@example.com>', 'local@domain'],
    ['mailFrom', 'Crewreg <no-reply@example.com', 'local@domain'],
    ['mailFrom', 'no-reply@other.com', 'not inside hostedZoneName'],
    ['mailFrom', 'Crewreg <no-reply@mail.other.com>', 'not inside hostedZoneName'],
  ])('rejects bad %s = %p', (field, value, message) => {
    expect(() => validateEnvironmentConfig('dev', { ...raw(), [field]: value })).toThrow(message);
  });

  test('rejects an unknown LLM provider and non-positive tunables', () => {
    const badProvider = { ...raw(), llm: { ...TEST_CONTEXT.crewreg.dev.llm, provider: 'mistral' } };
    expect(() => validateEnvironmentConfig('dev', badProvider)).toThrow('llm.provider');

    const badExtract = { ...raw(), extract: { ...TEST_CONTEXT.crewreg.dev.extract, visionDpi: -1 } };
    expect(() => validateEnvironmentConfig('dev', badExtract)).toThrow('extract.visionDpi');

    expect(() => validateEnvironmentConfig('dev', { ...raw(), llm: 'gemini' })).toThrow('llm. must be an object');
  });

  test('accepts an AMI pin and an empty origin list', () => {
    const cfg = validateEnvironmentConfig('prod', { ...raw(), amiId: 'ami-0123456789abcdef0', corsAllowedOrigins: [] });

    expect(cfg.envName).toBe('prod');
    expect(cfg.amiId).toBe('ami-0123456789abcdef0');
    expect(cfg.corsAllowedOrigins).toEqual([]);
  });

  test('accepts an apex apiHost equal to the zone, and no zone at all', () => {
    expect(validateEnvironmentConfig('dev', { ...raw(), apiHost: 'Example.com', hostedZoneName: 'EXAMPLE.com' }).hostedZoneName).toBe('example.com');
    const noZone = { ...raw() } as Record<string, unknown>;
    delete noZone.hostedZoneName;
    expect(validateEnvironmentConfig('dev', noZone).hostedZoneName).toBeUndefined();
  });

  test('imports an existing zone by id, and refuses an id without a name', () => {
    expect(validateEnvironmentConfig('dev', { ...raw(), hostedZoneId: 'Z04086442AMPWSPJV0TW2' }).hostedZoneId).toBe('Z04086442AMPWSPJV0TW2');
    const noZone = { ...raw(), hostedZoneId: 'Z04086442AMPWSPJV0TW2' } as Record<string, unknown>;
    delete noZone.hostedZoneName;
    expect(() => validateEnvironmentConfig('dev', noZone)).toThrow('needs hostedZoneName');
  });

  test('accepts a bare sender, a subdomain sender inside the zone, and any sender without a zone', () => {
    expect(validateEnvironmentConfig('dev', { ...raw(), mailFrom: 'no-reply@example.com' }).mailDomain).toBe('example.com');
    expect(validateEnvironmentConfig('dev', { ...raw(), mailFrom: 'Crewreg <no-reply@Mail.Example.com>' }).mailDomain).toBe('mail.example.com');
    const noZone = { ...raw(), mailFrom: 'no-reply@other.com' } as Record<string, unknown>;
    delete noZone.hostedZoneName;
    expect(validateEnvironmentConfig('dev', noZone).mailDomain).toBe('other.com');
  });

  test('rejects a non-object block', () => {
    expect(() => validateEnvironmentConfig('dev', 'dev')).toThrow('must be an object');
  });
});

describe('loadEnvironmentConfig', () => {
  test('reads the named environment from app context', () => {
    const app = new cdk.App({ context: TEST_CONTEXT });

    const cfg = loadEnvironmentConfig(app, 'dev');

    expect(cfg.apiHost).toBe('api.example.com');
  });

  test('applies a command-line amiId override', () => {
    const app = new cdk.App({ context: { ...TEST_CONTEXT, amiId: 'ami-0abcdef1234567890' } });

    expect(loadEnvironmentConfig(app, 'dev').amiId).toBe('ami-0abcdef1234567890');
  });

  test('names the missing block', () => {
    const app = new cdk.App({ context: TEST_CONTEXT });

    expect(() => loadEnvironmentConfig(app, 'staging')).toThrow('crewreg.staging');
    expect(() => loadEnvironmentConfig(new cdk.App(), 'dev')).toThrow('context "crewreg" is missing');
  });
});

describe('mailFromDomain', () => {
  test.each<[string, string | undefined]>([
    ['no-reply@example.com', 'example.com'],
    ['Crewreg <no-reply@example.com>', 'example.com'],
    [' Crew Reg <No-Reply@Example.COM> ', 'example.com'],
    ['no-reply', undefined],
    ['<no-reply@example.com', undefined],
    ['a@b@c', undefined],
  ])('%s -> %p', (value, expected) => {
    expect(mailFromDomain(value)).toBe(expected);
  });
});

describe('instanceArchitecture', () => {
  test.each<[string, 'arm64' | 'x86_64']>([
    ['t3.micro', 'x86_64'],
    ['t3a.micro', 'x86_64'],
    ['m5.large', 'x86_64'],
    ['c6i.large', 'x86_64'],
    ['t4g.micro', 'arm64'],
    ['m7g.large', 'arm64'],
    ['c6gn.medium', 'arm64'],
    ['r8g.large', 'arm64'],
    ['a1.medium', 'arm64'],
  ])('%s is %s', (type, arch) => {
    expect(instanceArchitecture(type)).toBe(arch);
  });
});

describe('isOrigin', () => {
  test.each([
    ['https://app.example.com', true],
    ['http://localhost:5173', true],
    ['https://main.d1234567890abc.amplifyapp.com', true],
    ['https://app.example.com/', false],
    ['https://app.example.com/path', false],
    ['https://app.example.com?x=1', false],
    ['https://user:pw@app.example.com', false],
    ['ftp://app.example.com', false],
    ['app.example.com', false],
    ['https://*.example.com', false],
    ['', false],
  ])('%s -> %s', (value, expected) => {
    expect(isOrigin(value)).toBe(expected);
  });
});
