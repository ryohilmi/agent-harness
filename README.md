# agent-harness

A small coding-agent harness for any OpenAI-compatible `/chat/completions`
API. It reads and writes files, makes exact-string edits, and does arithmetic,
with an [Ink](https://github.com/vadimdemedes/ink) terminal UI for interactive
use.

Works with OpenAI, Azure OpenAI, DeepSeek, OpenRouter, Together, Groq, Ollama,
LM Studio, vLLM, llama.cpp, and anything else implementing the OpenAI
chat-completions spec (including function/tool calling).

## Requirements

- Node.js 20.3 or newer (uses the built-in `fetch`, `AbortSignal.any`, and
  native `node:test`)

## Setup

```sh
npm install
cp .env.example .env
# edit .env with your API key, endpoint, and model
```

`.env` is loaded from the project root (next to `package.json`) and never
overrides variables already present in the process environment.

## Usage

```sh
npm run dev                          # interactive TUI
npm run dev -- "What is 12 * 34 + 5?"  # single question, prints the answer
npm run dev -- --no-tui              # plain readline chat
```

After building:

```sh
npm run build
npm start                            # TUI
node dist/cli.js "explain src/agent.ts"
```

The interactive TUI keeps the whole conversation, including tool calls and
their results, so follow-ups like "and multiply that by 2" work.

Commands:

| Command  | Action                         |
| -------- | ------------------------------ |
| `/help`  | Show help                      |
| `/reset` | Clear the conversation history |
| `/exit`  | Quit                           |

Keyboard: `Enter` sends, `Ctrl-C` cancels an in-flight request (or exits when
idle), and `Esc` also cancels a request.

If stdin is piped and no prompt is given, the harness reads one prompt from
stdin:

```sh
echo "summarize this repo" | npm start
```

## Configuration

Settings come from `.env`, then the process environment (which wins).

| Variable                | Default                                      | Purpose                                  |
| ----------------------- | -------------------------------------------- | ---------------------------------------- |
| `OPENAI_API_KEY`        | —                                            | API key (also `LLM_API_KEY`)             |
| `OPENAI_BASE_URL`       | `https://api.vikey.ai/v1/chat/completions`   | Endpoint (also `LLM_BASE_URL`)           |
| `OPENAI_MODEL`          | `gpt-4o-mini`                                | Model name (also `LLM_MODEL`)            |
| `AGENT_MAX_TURNS`       | `8`                                          | Maximum model/tool round trips per turn  |
| `OPENAI_TIMEOUT`        | `60`                                         | Request timeout in seconds               |
| `AGENT_ROOT`            | current directory                            | Directory the file tools may touch       |
| `AGENT_MAX_READ_LINES`  | `2000`                                       | Default `read` line limit                |
| `AGENT_MAX_READ_BYTES`  | `1000000`                                    | Read byte cap and edit size limit        |

Examples for other providers:

```sh
# DeepSeek
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat

# Ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_MODEL=llama3.1
```

## Tools

- `calculator` — safe arithmetic parser (`+ - * / // % **`, parentheses,
  unary signs). It does not use `eval`.
- `read` — reads a UTF-8 text file with numbered lines, or lists a directory.
  Supports `offset` and `limit`, detects binary files, and reports truncation.
- `write` — creates or overwrites a file atomically through a temp file.
- `edit` — exact-string replacement with optional `replace_all`; matches CRLF
  files even when given LF-only snippets.

Paths are resolved against `AGENT_ROOT` and must stay inside it after symlinks
are resolved.

## Development

```sh
npm run dev        # run the TypeScript entry point directly with tsx
npm run typecheck  # tsc --noEmit
npm test           # node:test suites via tsx
npm run build      # compile to dist/
npm start          # run the compiled CLI
```

Project layout:

```text
src/
  cli.ts            argument parsing, single-shot, readline fallback
  tui.tsx           Ink interface
  agent.ts          conversation history and agent loop
  llm.ts            streaming chat-completions client
  config.ts         environment and .env loading
  env.ts            .env parser
  system-prompt.ts  prompt and help text
  tools/            calculator, read, write, edit, registry
test/               calculator, env, tools, llm, and agent tests
```
