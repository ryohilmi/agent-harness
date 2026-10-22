import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, parseDotEnv } from '../src/env.js';

test('parses comments, quotes and empty values', () => {
  assert.deepEqual(
    parseDotEnv(`
      # comment
      OPENAI_API_KEY=sk-test
      OPENAI_MODEL="gpt-4o-mini"
      SINGLE='value'
      EMPTY=
      NO_EQUALS
    `),
    {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_MODEL: 'gpt-4o-mini',
      SINGLE: 'value',
      EMPTY: '',
    },
  );
});

test('does not override existing variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'A=from-file\nB=from-file\nC=from-file\n');

  try {
    const env: NodeJS.ProcessEnv = { A: 'from-env', B: '' };
    loadDotEnv(file, env);

    assert.equal(env.A, 'from-env');
    assert.equal(env.B, '');
    assert.equal(env.C, 'from-file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads a missing .env without throwing', () => {
  const env: NodeJS.ProcessEnv = {};
  loadDotEnv('/definitely/not/a/real/.env', env);
  assert.deepEqual(env, {});
});

test('keeps a trailing comment as part of the value', () => {
  assert.deepEqual(parseDotEnv('A=value # not a comment\n'), {
    A: 'value # not a comment',
  });
});
