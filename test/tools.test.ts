import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createTools } from '../src/tools/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-harness-tools-'));
  const config = loadConfig({ AGENT_ROOT: root });
  const tools = createTools(config);

  return {
    root,
    config,
    tools,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('write creates files and read returns numbered lines', async () => {
  const { tools, cleanup } = fixture();

  try {
    const written = await tools.execute(
      'write',
      JSON.stringify({ path: 'notes/todo.md', content: 'one\ntwo\n' }),
    );
    assert.equal(written, 'Created notes/todo.md (8 bytes, 2 line(s)).');

    assert.equal(
      await tools.execute('read', JSON.stringify({ path: 'notes/todo.md' })),
      '1: one\n2: two',
    );

    assert.equal(
      await tools.execute(
        'read',
        JSON.stringify({ path: 'notes/todo.md', offset: 2, limit: 1 }),
      ),
      '2: two',
    );

    assert.equal(
      await tools.execute(
        'read',
        JSON.stringify({ path: 'notes/todo.md', offset: 5 }),
      ),
      'Error: offset 5 is past the end of the file.',
    );
  } finally {
    cleanup();
  }
});

test('read lists directories with trailing slashes', async () => {
  const { root, tools, cleanup } = fixture();

  try {
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'a.txt'), 'a');

    assert.equal(
      await tools.execute('read', JSON.stringify({ path: '.' })),
      'a.txt\nnotes/',
    );

    assert.equal(
      await tools.execute('read', JSON.stringify({ path: 'notes' })),
      '(empty directory)',
    );
  } finally {
    cleanup();
  }
});

test('read rejects paths outside the root', async () => {
  const { tools, cleanup } = fixture();

  try {
    const relative = await tools.execute(
      'read',
      JSON.stringify({ path: '../../etc/passwd' }),
    );
    assert.match(relative, /is outside the allowed root/);

    const absolute = await tools.execute(
      'read',
      JSON.stringify({ path: '/etc/passwd' }),
    );
    assert.match(absolute, /is outside the allowed root/);
  } finally {
    cleanup();
  }
});

test('read detects binary files', async () => {
  const { root, tools, cleanup } = fixture();

  try {
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));

    assert.match(
      await tools.execute('read', JSON.stringify({ path: 'binary.bin' })),
      /looks like a binary file/,
    );
  } finally {
    cleanup();
  }
});

test('read refuses secret files but allows templates', async () => {
  const { root, tools, cleanup } = fixture();

  try {
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=sk-do-not-leak\n');
    writeFileSync(join(root, '.env.example'), 'OPENAI_API_KEY=\n');
    mkdirSync(join(root, '.ssh'));
    writeFileSync(join(root, '.ssh', 'id_rsa'), 'RSA-MATERIAL-XYZ');

    for (const path of ['.env', '.ssh/id_rsa']) {
      const result = await tools.execute('read', JSON.stringify({ path }));
      assert.match(result, /refusing to read/);
      assert.doesNotMatch(result, /sk-do-not-leak|RSA-MATERIAL-XYZ/);
    }

    assert.equal(
      await tools.execute('read', JSON.stringify({ path: '.env.example' })),
      '1: OPENAI_API_KEY=',
    );
  } finally {
    cleanup();
  }
});

test('AGENT_PROTECT_SECRETS=0 disables the read denylist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-harness-tools-'));
  const config = loadConfig({ AGENT_ROOT: root, AGENT_PROTECT_SECRETS: '0' });
  const tools = createTools(config);

  try {
    writeFileSync(join(root, '.env'), 'TOKEN=visible\n');

    assert.equal(
      await tools.execute('read', JSON.stringify({ path: '.env' })),
      '1: TOKEN=visible',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('edit replaces unique text and refuses ambiguous matches', async () => {
  const { root, tools, cleanup } = fixture();

  try {
    writeFileSync(join(root, 'file.txt'), 'hello world\nhello again\n');

    assert.equal(
      await tools.execute(
        'edit',
        JSON.stringify({
          path: 'file.txt',
          old_string: 'hello world',
          new_string: 'hi world',
        }),
      ),
      'Edited file.txt: replaced 1 occurrence(s).',
    );

    assert.equal(
      readFileSync(join(root, 'file.txt'), 'utf8'),
      'hi world\nhello again\n',
    );

    writeFileSync(join(root, 'file.txt'), 'hello\nhello\n');
    const repeated = await tools.execute(
      'edit',
      JSON.stringify({
        path: 'file.txt',
        old_string: 'hello',
        new_string: 'hi',
      }),
    );
    assert.match(repeated, /appears 2 times/);

    assert.equal(
      await tools.execute(
        'edit',
        JSON.stringify({
          path: 'file.txt',
          old_string: 'hello',
          new_string: 'hi',
          replace_all: true,
        }),
      ),
      'Edited file.txt: replaced 2 occurrence(s).',
    );
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'hi\nhi\n');
  } finally {
    cleanup();
  }
});

test('edit matches CRLF files from LF-only snippets', async () => {
  const { root, tools, cleanup } = fixture();

  try {
    writeFileSync(join(root, 'crlf.txt'), 'first\r\nsecond\r\n');

    assert.equal(
      await tools.execute(
        'edit',
        JSON.stringify({
          path: 'crlf.txt',
          old_string: 'first\nsecond',
          new_string: 'one\ntwo',
        }),
      ),
      'Edited crlf.txt: replaced 1 occurrence(s).',
    );

    assert.equal(
      readFileSync(join(root, 'crlf.txt'), 'utf8'),
      'one\r\ntwo\r\n',
    );
  } finally {
    cleanup();
  }
});

test('edit validates its arguments', async () => {
  const { root, tools, cleanup } = fixture();

  try {
    writeFileSync(join(root, 'file.txt'), 'text');

    assert.equal(
      await tools.execute(
        'edit',
        JSON.stringify({ path: 'file.txt', old_string: '', new_string: 'x' }),
      ),
      'Error: old_string must not be empty.',
    );

    assert.equal(
      await tools.execute(
        'edit',
        JSON.stringify({
          path: 'file.txt',
          old_string: 'text',
          new_string: 'text',
        }),
      ),
      'Error: old_string and new_string are identical; nothing to do.',
    );

    assert.equal(
      await tools.execute(
        'edit',
        JSON.stringify({
          path: 'file.txt',
          old_string: 'missing',
          new_string: 'x',
        }),
      ),
      "Error: old_string not found in 'file.txt'.",
    );
  } finally {
    cleanup();
  }
});

test('bash runs commands in the workspace root', async () => {
  const { config, root, tools, cleanup } = fixture();

  try {
    writeFileSync(join(root, 'note.txt'), 'hello');

    assert.equal(
      await tools.execute('bash', JSON.stringify({ command: 'pwd' })),
      `${config.root}\n[exit code 0]`,
    );

    assert.equal(
      await tools.execute('bash', JSON.stringify({ command: 'cat note.txt' })),
      'hello\n[exit code 0]',
    );
  } finally {
    cleanup();
  }
});

test('bash reports stderr and a non-zero exit code', async () => {
  const { tools, cleanup } = fixture();

  try {
    const result = await tools.execute(
      'bash',
      JSON.stringify({ command: 'echo out; echo err >&2; exit 3' }),
    );

    assert.match(result, /^out$/m);
    assert.match(result, /\[stderr\]\nerr/);
    assert.match(result, /\[exit code 3\]$/);
  } finally {
    cleanup();
  }
});

test('bash honours cwd and keeps it inside the root', async () => {
  const { config, root, tools, cleanup } = fixture();

  try {
    mkdirSync(join(root, 'sub'));

    assert.equal(
      await tools.execute(
        'bash',
        JSON.stringify({ command: 'pwd', cwd: 'sub' }),
      ),
      `${join(config.root, 'sub')}\n[exit code 0]`,
    );

    assert.match(
      await tools.execute(
        'bash',
        JSON.stringify({ command: 'pwd', cwd: '../..' }),
      ),
      /is outside the allowed root/,
    );
  } finally {
    cleanup();
  }
});

test('bash kills commands that exceed the timeout', async () => {
  const { tools, cleanup } = fixture();

  try {
    const started = Date.now();
    const result = await tools.execute(
      'bash',
      JSON.stringify({ command: 'sleep 5', timeout_ms: 100 }),
    );

    assert.match(result, /\[timed out after 100 ms\]/);
    assert.ok(Date.now() - started < 3000, 'timeout should kill the command');
  } finally {
    cleanup();
  }
});

test('bash truncates large output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-harness-tools-'));
  const config = {
    ...loadConfig({ AGENT_ROOT: root }),
    maxOutputBytes: 16,
  };
  const tools = createTools(config);

  try {
    const result = await tools.execute(
      'bash',
      JSON.stringify({ command: "printf 'abcdefghijklmnopqrstuvwxyz'" }),
    );

    assert.ok(
      result.startsWith('abcdefghijklmnop'),
      `unexpected result: ${JSON.stringify(result)}`,
    );
    assert.match(result, /\[output truncated at 16 bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bash validates its arguments', async () => {
  const { tools, cleanup } = fixture();

  try {
    assert.equal(
      await tools.execute('bash', JSON.stringify({ command: '   ' })),
      'Error: command must not be empty.',
    );

    assert.equal(
      await tools.execute(
        'bash',
        JSON.stringify({ command: 'true', timeout_ms: 0 }),
      ),
      'Error: timeout_ms must be 1 or greater.',
    );

    assert.equal(
      await tools.execute('bash', '{}'),
      "Error: argument 'command' must be a string",
    );
  } finally {
    cleanup();
  }
});

test('bash does not expose secret-looking environment variables', async () => {
  const { tools, cleanup } = fixture();
  process.env.AGENT_TEST_FAKE_TOKEN = 'super-secret';

  try {
    const result = await tools.execute(
      'bash',
      JSON.stringify({
        command: 'printenv AGENT_TEST_FAKE_TOKEN || echo unset',
      }),
    );

    assert.match(result, /^unset$/m);
    assert.doesNotMatch(result, /super-secret/);
  } finally {
    delete process.env.AGENT_TEST_FAKE_TOKEN;
    cleanup();
  }
});

test('unknown tools and bad arguments become tool errors', async () => {
  const { tools, cleanup } = fixture();

  try {
    assert.equal(
      await tools.execute('nope', '{}'),
      "Error: unknown tool 'nope'",
    );

    assert.match(
      await tools.execute('read', '{not json'),
      /Error: invalid tool arguments:/,
    );

    assert.equal(
      await tools.execute('read', '[]'),
      'Error: tool arguments must be a JSON object.',
    );

    assert.equal(
      await tools.execute('read', '{}'),
      "Error: argument 'path' must be a string",
    );
  } finally {
    cleanup();
  }
});
