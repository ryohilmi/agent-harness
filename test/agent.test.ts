import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conversation } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { createTools } from '../src/tools/index.js';
import type { ChatMessage } from '../src/types.js';

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not expose a port');
  }

  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
  });
}

function sse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

function toolCall(name: string, args: string): unknown[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name, arguments: args },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

test('runs tool calls and keeps the full conversation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-harness-agent-'));
  let requests = 0;

  await withServer(
    (request, response) => {
      void readBody(request).then((body) => {
        requests += 1;
        if (requests === 1) {
          sse(response, toolCall('calculator', '{"expression":"12 * 34 + 5"}'));
          return;
        }

        const payload = JSON.parse(body) as { messages: ChatMessage[] };
        const tool = payload.messages.find((message) => message.role === 'tool');
        sse(response, [
          {
            choices: [
              { delta: { content: `Answer: ${tool?.content}.` } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
      });
    },
    async (baseUrl) => {
      try {
        const config = loadConfig({
          OPENAI_BASE_URL: baseUrl,
          OPENAI_MODEL: 'mock',
          OPENAI_API_KEY: 'test',
          AGENT_ROOT: root,
          AGENT_MAX_TURNS: '4',
        });
        const conversation = new Conversation(config, createTools(config));
        const answer = await conversation.send('What is 12 * 34 + 5?');

        assert.equal(answer, 'Answer: 413.');
        assert.deepEqual(
          conversation.messages.map((message) => message.role),
          ['system', 'user', 'assistant', 'tool', 'assistant'],
        );
        assert.equal(conversation.messages[3]?.content, '413');
        assert.equal(conversation.messages[4]?.content, 'Answer: 413.');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test('reports unknown tools back to the model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-harness-agent-'));
  let requests = 0;

  await withServer(
    (request, response) => {
      void readBody(request).then((body) => {
        requests += 1;
        if (requests === 1) {
          sse(response, toolCall('not_a_tool', '{}'));
          return;
        }

        const payload = JSON.parse(body) as { messages: ChatMessage[] };
        const tool = payload.messages.find((message) => message.role === 'tool');
        sse(response, [
          { choices: [{ delta: { content: String(tool?.content) } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
      });
    },
    async (baseUrl) => {
      try {
        const config = loadConfig({
          OPENAI_BASE_URL: baseUrl,
          OPENAI_MODEL: 'mock',
          AGENT_ROOT: root,
        });
        const conversation = new Conversation(config, createTools(config));

        assert.equal(
          await conversation.send('use a missing tool'),
          "Error: unknown tool 'not_a_tool'",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test('rolls back the user message when the request fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-harness-agent-'));

  await withServer(
    (_request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('boom');
    },
    async (baseUrl) => {
      try {
        const config = loadConfig({
          OPENAI_BASE_URL: baseUrl,
          OPENAI_MODEL: 'mock',
          AGENT_ROOT: root,
        });
        const conversation = new Conversation(config, createTools(config));

        await assert.rejects(conversation.send('hello'), /LLM API error 500/);
        assert.equal(conversation.messages.length, 1);
        assert.equal(conversation.messages[0]?.role, 'system');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test('stops after the configured number of turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-harness-agent-'));

  await withServer(
    (_request, response) => {
      sse(response, toolCall('calculator', '{"expression":"1 + 1"}'));
    },
    async (baseUrl) => {
      try {
        const config = loadConfig({
          OPENAI_BASE_URL: baseUrl,
          OPENAI_MODEL: 'mock',
          AGENT_ROOT: root,
          AGENT_MAX_TURNS: '2',
        });
        const conversation = new Conversation(config, createTools(config));

        assert.equal(
          await conversation.send('loop forever'),
          '(stopped: max turns reached)',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test('reset keeps only the system prompt', () => {
  const config = loadConfig({ AGENT_ROOT: process.cwd() });
  const conversation = new Conversation(config, createTools(config));

  conversation.messages.push({ role: 'user', content: 'hello' });
  conversation.reset();

  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0]?.role, 'system');
});
