import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Interface } from 'node:readline/promises';
import { alwaysApprove, createApprover } from '../src/approval.js';
import type { ApprovalRequest } from '../src/agent.js';

function stubTerminal(answers: string[]) {
  const state = { asked: [] as string[], closed: false };

  const terminal = {
    question: async (prompt: string) => {
      state.asked.push(prompt);
      return answers.shift() ?? '';
    },
    close: () => {
      state.closed = true;
    },
  };

  return { terminal: terminal as unknown as Interface, state };
}

function capture() {
  const state = { text: '' };
  const output = {
    write: (chunk: string) => {
      state.text += chunk;
      return true;
    },
  };

  return { output: output as unknown as NodeJS.WritableStream, state };
}

const request: ApprovalRequest = {
  name: 'bash',
  summary: 'npm test  (cwd: packages/api)',
  args: { command: 'npm test', cwd: 'packages/api' },
};

test('approves once, then remembers "always" for the session', async () => {
  const { terminal, state } = stubTerminal(['y', 'a']);
  const { output } = capture();
  const approver = createApprover({ terminal, output });

  assert.equal(await approver.approve(request), true);
  assert.equal(await approver.approve(request), true);
  assert.equal(await approver.approve(request), true);

  assert.equal(state.asked.length, 2, 'auto-approval should skip prompting');
});

test('denies empty, n, and unknown answers', async () => {
  for (const answer of ['', 'n', 'no', 'whatever']) {
    const { terminal } = stubTerminal([answer]);
    const approver = createApprover({ terminal, output: capture().output });
    assert.equal(await approver.approve(request), false, answer);
  }
});

test('shows the command and any warning', async () => {
  const { terminal, state: terminalState } = stubTerminal(['n']);
  const { output, state } = capture();
  const approver = createApprover({ terminal, output });

  await approver.approve({ ...request, warning: 'This command mentions secrets.' });

  assert.match(state.text, /tool: bash/);
  assert.match(state.text, /npm test/);
  assert.match(state.text, /mentions secrets/);
  assert.match(
    terminalState.asked[0] ?? '',
    /\[y\]es \/ \[a\]lways \/ \[N\]o/,
  );
});

test('close leaves a shared terminal open', async () => {
  const { terminal, state } = stubTerminal([]);
  const approver = createApprover({ terminal, output: capture().output });

  approver.close();
  assert.equal(state.closed, false);
});

test('alwaysApprove never asks', async () => {
  assert.equal(await alwaysApprove().approve(request), true);
});
