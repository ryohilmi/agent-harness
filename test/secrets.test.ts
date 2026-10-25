import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildBashEnv } from '../src/tools/bash.js';
import {
  isSecretEnvName,
  isSecretPath,
  mentionsSecretPath,
  secretPathReason,
} from '../src/tools/secrets.js';

test('recognises secret-looking paths', () => {
  for (const path of [
    '/repo/.env',
    '/repo/.env.local',
    '/repo/.env.production',
    '/home/user/.ssh/id_rsa',
    '/home/user/.aws/credentials',
    '/repo/certs/server.pem',
    '/repo/keys/deploy.key',
    '/repo/.npmrc',
    '/repo/.netrc',
    '/repo/bundle.p12',
  ]) {
    assert.equal(isSecretPath(path), true, path);
    assert.ok(secretPathReason(path), path);
  }
});

test('leaves templates and ordinary files alone', () => {
  for (const path of [
    '/repo/.env.example',
    '/repo/.env.sample',
    '/repo/.env.template',
    '/repo/src/config.ts',
    '/repo/keys/server.pub',
    '/repo/README.md',
    '/repo/src/tools/secrets.ts',
  ]) {
    assert.equal(isSecretPath(path), false, path);
    assert.equal(secretPathReason(path), null, path);
  }
});

test('flags secret-looking environment variable names', () => {
  for (const name of [
    'OPENAI_API_KEY',
    'LLM_API_KEY',
    'GH_TOKEN',
    'MY_SECRET',
    'DB_PASSWORD',
    'AWS_ACCESS_KEY_ID',
    'NPM_CONFIG__AUTH',
    'SSH_AUTH_SOCK_EXTRA',
  ]) {
    assert.equal(isSecretEnvName(name), true, name);
  }

  for (const name of ['PATH', 'HOME', 'NO_COLOR', 'OPENAI_BASE_URL', 'SSH_AUTH_SOCK']) {
    assert.equal(isSecretEnvName(name), false, name);
  }
});

test('buildBashEnv strips secrets unless they are allowlisted', () => {
  const source = {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'sk-test',
    GH_TOKEN: 'gh-test',
    SAFE_VALUE: 'ok',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
  };

  const scrubbed = buildBashEnv(
    { protectSecrets: true, bashEnvAllow: [] },
    source,
  );
  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.SAFE_VALUE, 'ok');
  assert.equal(scrubbed.OPENAI_API_KEY, undefined);
  assert.equal(scrubbed.GH_TOKEN, undefined);
  assert.equal(scrubbed.SSH_AUTH_SOCK, '/tmp/agent.sock');
  assert.equal(scrubbed.NO_COLOR, '1');

  const allowlisted = buildBashEnv(
    { protectSecrets: true, bashEnvAllow: ['gh_token'] },
    source,
  );
  assert.equal(allowlisted.GH_TOKEN, 'gh-test');
  assert.equal(allowlisted.OPENAI_API_KEY, undefined);

  const unprotected = buildBashEnv(
    { protectSecrets: false, bashEnvAllow: [] },
    source,
  );
  assert.equal(unprotected.OPENAI_API_KEY, 'sk-test');
});

test('mentionsSecretPath warns about commands that touch secrets', () => {
  assert.equal(mentionsSecretPath('cat .env'), true);
  assert.equal(mentionsSecretPath('cat ~/.ssh/id_rsa'), true);
  assert.equal(mentionsSecretPath('openssl x509 -in cert.pem'), true);
  assert.equal(mentionsSecretPath('npm test'), false);
  assert.equal(mentionsSecretPath('cat .env.example'), false);
});

test('parses yolo, protection, and the env allowlist', () => {
  const config = loadConfig({
    AGENT_YOLO: 'yes',
    AGENT_PROTECT_SECRETS: 'off',
    AGENT_BASH_ENV_ALLOW: 'GH_TOKEN, NPM_TOKEN',
  });

  assert.equal(config.yolo, true);
  assert.equal(config.protectSecrets, false);
  assert.deepEqual(config.bashEnvAllow, ['GH_TOKEN', 'NPM_TOKEN']);
});

test('protects secrets by default and rejects bad booleans', () => {
  assert.equal(loadConfig({}).protectSecrets, true);
  assert.equal(loadConfig({}).yolo, false);

  assert.throws(
    () => loadConfig({ AGENT_YOLO: 'maybe' }),
    /AGENT_YOLO must be a boolean/,
  );
});

