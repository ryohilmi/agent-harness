import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from '../src/config.js';
import { chatCompletionsUrl, chatStream } from '../src/llm.js';

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

function configFor(baseUrl: string) {
  return loadConfig({
    OPENAI_BASE_URL: baseUrl,
    OPENAI_MODEL: 'test-model',
    OPENAI_API_KEY: 'test-key',
  });
}

function writeSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.write('data: [DONE]\n\n');
  response.end();
}

test('builds the chat completions URL', () => {
  assert.equal(
    chatCompletionsUrl('https://api.example.com/v1'),
    'https://api.example.com/v1/chat/completions',
  );
  assert.equal(
    chatCompletionsUrl('https://api.example.com/v1/chat/completions'),
    'https://api.example.com/v1/chat/completions',
  );
  assert.equal(
    chatCompletionsUrl('https://api.example.com/v1/'),
    'https://api.example.com/v1/chat/completions',
  );
});

test('streams assistant text deltas', async () => {
  await withServer(
    (_request, response) => {
      writeSse(response, [
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    },
    async (baseUrl) => {
      const deltas: string[] = [];
      const result = await chatStream(
        configFor(baseUrl),
        [{ role: 'user', content: 'hi' }],
        [],
        { onText: (delta) => deltas.push(delta) },
      );

      assert.equal(result.message.content, 'Hello');
      assert.deepEqual(deltas, ['Hel', 'lo']);
      assert.equal(result.finishReason, 'stop');
    },
  );
});

test('assembles streamed tool calls', async () => {
  await withServer(
    (_request, response) => {
      writeSse(response, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read', arguments: '{"pa' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'th":"x"}' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]);
    },
    async (baseUrl) => {
      const result = await chatStream(
        configFor(baseUrl),
        [{ role: 'user', content: 'read x' }],
        [],
      );

      assert.equal(result.message.content, null);
      assert.equal(result.finishReason, 'tool_calls');
      assert.equal(result.message.tool_calls?.length, 1);
      assert.equal(result.message.tool_calls?.[0]?.id, 'call_1');
      assert.equal(result.message.tool_calls?.[0]?.function.name, 'read');
      assert.equal(
        result.message.tool_calls?.[0]?.function.arguments,
        '{"path":"x"}',
      );
    },
  );
});

test('falls back to a non-streaming JSON response', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'Hi' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    },
    async (baseUrl) => {
      const result = await chatStream(
        configFor(baseUrl),
        [{ role: 'user', content: 'hi' }],
        [],
      );

      assert.equal(result.message.content, 'Hi');
      assert.equal(result.finishReason, 'stop');
    },
  );
});

test('surfaces API errors with the response body', async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('boom');
    },
    async (baseUrl) => {
      await assert.rejects(
        chatStream(configFor(baseUrl), [{ role: 'user', content: 'hi' }], []),
        /LLM API error 500 from .*: boom/,
      );
    },
  );
});
