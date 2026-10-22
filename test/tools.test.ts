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
