# agent-harness

A small coding-agent harness for any OpenAI-compatible `/chat/completions`
API. It reads and writes files, makes exact-string edits, runs shell commands,
and does arithmetic, with an [Ink](https://github.com/vadimdemedes/ink)
terminal UI for interactive use.

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
npm run dev -- --yolo                # skip the tool approval prompt
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
| `AGENT_MAX_OUTPUT_BYTES`| `100000`                                     | `bash` stdout/stderr cap                 |
| `AGENT_BASH_TIMEOUT`    | `120`                                        | Default `bash` timeout in seconds        |
| `AGENT_YOLO`            | `0`                                          | Same as `--yolo`                         |
| `AGENT_PROTECT_SECRETS` | `1`                                          | Block secret reads, scrub bash env       |
| `AGENT_BASH_ENV_ALLOW`  | —                                            | Names to keep in the bash environment    |

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
- `bash` — runs a command with `bash -c` in the workspace root (or a `cwd`
  inside it), inheriting the harness's environment rather than a login
  shell's. Stdin is closed, commands are killed after a timeout (default
  120s), and combined stdout/stderr is capped. Reports the exit code. **Each
  call asks for approval** unless `--yolo`/`AGENT_YOLO=1` is set.
- `read` — reads a UTF-8 text file with numbered lines, or lists a directory.
  Supports `offset` and `limit`, detects binary files, and reports truncation.
  Refuses secret-looking paths (`.env`, private keys, `.ssh`, ...).
- `write` — creates or overwrites a file atomically through a temp file.
- `edit` — exact-string replacement with optional `replace_all`; matches CRLF
  files even when given LF-only snippets.

Paths are resolved against `AGENT_ROOT` and must stay inside it after symlinks
are resolved. The `bash` tool starts in that root, but a shell command can
still reach anything the current user can — it is not sandboxed.

## Approval and secrets

`bash` is the dangerous tool: it runs whatever the model writes. By default
each call pauses and shows the command:

```text
tool: bash
  npm test  (cwd: packages/api)
Run it? [y]es / [a]lways / [N]o
```

`y` runs it once, `a` allows every later command this session, and anything
else denies it (the model sees the denial and is told not to retry). The same
prompt is used by the TUI, the readline chat, and single-shot runs when stdin
is a terminal. Non-interactive runs fail closed with an explanatory tool
error; pass `--yolo` to allow commands there.

`--yolo` (or `AGENT_YOLO=1`) skips all of this. Only use it in a directory
where you would happily let a stranger run `rm -rf` — a prompt-injected file
is enough to steer the model.

Two independent guard rails back the prompt up:

- **Secret files are blocked from `read`**: `.env` and `.env.*` (except
  `.env.example` and friends), `.ssh/`, `.aws/`, `.gnupg/`, `.kube/`,
  `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa`-style keys, and
  `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`/`*.keystore`. The model is told to
  ask you instead. Discrete-file reads are blocked; the `bash` tool can still
  reach them if you approve it.
- **Secret-looking environment variables are stripped from the bash child
  environment**, so `env` or `printenv` cannot dump your keys into the
  transcript the provider sees. This covers names containing `API_KEY`,
  `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTH`, and similar segments.
  Add exceptions with `AGENT_BASH_ENV_ALLOW=GH_TOKEN,NPM_TOKEN` when a tool
  genuinely needs one.

Set `AGENT_PROTECT_SECRETS=0` to disable both. Approval prompts also warn when
a command mentions an obvious secret path.

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
  approval.ts       readline approval prompt (y / a / n)
  agent.ts          conversation history and agent loop
  llm.ts            streaming chat-completions client
  config.ts         environment and .env loading
  env.ts            .env parser
  system-prompt.ts  prompt and help text
  tools/            calculator, bash, read, write, edit, secrets, registry
test/               calculator, env, tools, llm, secrets, and agent tests
```
