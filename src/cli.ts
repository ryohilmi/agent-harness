#!/usr/bin/env node
import { stdin, stdout, stderr, argv } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Conversation } from './agent.js';
import { loadConfig, loadProjectEnv, type Config } from './config.js';
import { HELP_TEXT } from './system-prompt.js';
import { createTools, type ToolRegistry } from './tools/index.js';

const VERSION = '0.1.0';

const USAGE = `agent-harness ${VERSION} — minimal agent loop for OpenAI-compatible APIs

Usage:
  agent-harness                   interactive TUI (or read a prompt from stdin)
  agent-harness "question"        single question, print the answer
  agent-harness --no-tui          plain readline chat

Options:
  --no-tui       use the plain readline interface instead of the Ink TUI
  -h, --help     show this help
  -v, --version  show the version

Environment:
  OPENAI_API_KEY / LLM_API_KEY
  OPENAI_BASE_URL / LLM_BASE_URL   default: https://api.vikey.ai/v1/chat/completions
  OPENAI_MODEL / LLM_MODEL         default: gpt-4o-mini
  AGENT_MAX_TURNS                  default: 8
  OPENAI_TIMEOUT                   seconds, default: 60
  AGENT_ROOT                       directory the file tools may touch
  AGENT_MAX_READ_LINES             default: 2000
  AGENT_MAX_READ_BYTES             default: 1000000

Settings are read from .env next to package.json, then from the process
environment (which takes precedence).`;

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data;
}

async function runOnce(
  prompt: string,
  config: Config,
  tools: ToolRegistry,
): Promise<void> {
  const conversation = new Conversation(config, tools);
  const answer = await conversation.send(prompt);
  stdout.write(`${answer}\n`);
}

async function repl(config: Config, tools: ToolRegistry): Promise<void> {
  const conversation = new Conversation(config, tools);
  const terminal = createInterface({ input: stdin, output: stdout });

  stdout.write('Interactive chat — type /help for commands, /exit to quit.\n');

  try {
    for (;;) {
      let line: string;
      try {
        line = (await terminal.question('you> ')).trim();
      } catch {
        stdout.write('\n');
        break;
      }

      if (!line) continue;

      const command = line.toLowerCase();
      if (command === '/exit' || command === '/quit') break;
      if (command === '/help') {
        stdout.write(`${HELP_TEXT}\n`);
        continue;
      }
      if (command === '/reset') {
        conversation.reset();
        stdout.write('(conversation cleared)\n');
        continue;
      }

      try {
        const answer = await conversation.send(line);
        stdout.write(`\nassistant> ${answer}\n`);
      } catch (error) {
        stderr.write(
          `error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  let noTui = false;
  const promptParts: string[] = [];
  let literal = false;

  for (const argument of argv.slice(2)) {
    if (literal) {
      promptParts.push(argument);
      continue;
    }

    if (argument === '--') {
      literal = true;
    } else if (argument === '--no-tui') {
      noTui = true;
    } else if (argument === '-h' || argument === '--help') {
      stdout.write(`${USAGE}\n`);
      return;
    } else if (argument === '-v' || argument === '--version') {
      stdout.write(`${VERSION}\n`);
      return;
    } else {
      promptParts.push(argument);
    }
  }

  loadProjectEnv();
  const config = loadConfig();
  const tools = createTools(config);

  const prompt = promptParts.join(' ');

  if (prompt) {
    await runOnce(prompt, config, tools);
    return;
  }

  if (!stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (!piped) {
      stdout.write(`${USAGE}\n`);
      return;
    }
    await runOnce(piped, config, tools);
    return;
  }

  if (noTui || !stdout.isTTY || process.env.TERM === 'dumb') {
    await repl(config, tools);
    return;
  }

  const { runTui } = await import('./tui.js');
  await runTui(config, tools);
}

main().catch((error: unknown) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
