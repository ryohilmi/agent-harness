import { useEffect, useRef, useState } from 'react';
import { Box, Static, Text, render, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { Conversation, type ApprovalRequest } from './agent.js';
import type { Config } from './config.js';
import { HELP_TEXT } from './system-prompt.js';
import type { ToolRegistry } from './tools/index.js';
import type { ChatMessage, ToolCall } from './types.js';

type Entry =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'assistant'; text: string }
  | {
      id: number;
      kind: 'tool';
      name: string;
      detail: string;
      status: 'ok' | 'error';
      durationMs: number;
      result: string;
    }
  | {
      id: number;
      kind: 'notice';
      text: string;
      tone: 'info' | 'warn' | 'error';
    };

interface LiveTool {
  name: string;
  detail: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type NewEntry = DistributiveOmit<Entry, 'id'>;

function oneLine(text: string, max: number): string {
  const flattened = text.replace(/\s+/g, ' ').trim();
  return flattened.length > max
    ? `${flattened.slice(0, max - 1)}…`
    : flattened;
}

function formatToolDetail(
  name: string,
  args: Record<string, unknown> | null,
): string {
  if (!args) return '';

  const stringArg = (key: string): string =>
    typeof args[key] === 'string' ? (args[key] as string) : '';

  switch (name) {
    case 'calculator':
      return oneLine(stringArg('expression'), 60);
    case 'read': {
      const parts = [stringArg('path')];
      if (args.offset !== undefined) parts.push(`offset=${String(args.offset)}`);
      if (args.limit !== undefined) parts.push(`limit=${String(args.limit)}`);
      return oneLine(parts.filter(Boolean).join(', '), 80);
    }
    case 'write':
    case 'edit':
      return oneLine(stringArg('path'), 80);
    case 'bash': {
      const parts = [stringArg('command')];
      if (args.cwd !== undefined) parts.push(`cwd=${stringArg('cwd')}`);
      if (args.timeout_ms !== undefined) {
        parts.push(`timeout=${String(args.timeout_ms)}ms`);
      }
      return oneLine(parts.filter(Boolean).join(', '), 100);
    }
    default:
      return oneLine(JSON.stringify(args), 80);
  }
}

function resultPreview(result: string): { text: string; extra: number } {
  const trimmed = result.replace(/\s+$/, '');
  if (!trimmed) return { text: '(empty result)', extra: 0 };

  const lines = trimmed.split('\n');
  let first = lines[0] ?? '';
  if (first.length > 200) first = `${first.slice(0, 199)}…`;

  return { text: first || '(blank line)', extra: Math.max(0, lines.length - 1) };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      80,
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <Box marginLeft={2}>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            you
          </Text>
          <Text dimColor> › </Text>
          <Text>{entry.text}</Text>
        </Box>
      );

    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text color="green" bold>
            assistant
          </Text>
          <Text dimColor> › </Text>
          <Text>{entry.text}</Text>
        </Box>
      );

    case 'tool': {
      const preview = resultPreview(entry.result);
      const suffix = preview.extra > 0 ? ` (+${preview.extra} lines)` : '';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box marginLeft={2}>
            <Text color={entry.status === 'error' ? 'red' : 'green'}>
              {entry.status === 'error' ? '✗' : '✓'}
            </Text>
            <Text> </Text>
            <Text bold>{entry.name}</Text>
            {entry.detail ? <Text dimColor>({entry.detail})</Text> : null}
            <Text dimColor> · {entry.durationMs}ms</Text>
          </Box>
          <Box marginLeft={4}>
            <Text
              color={entry.status === 'error' ? 'red' : undefined}
              dimColor={entry.status !== 'error'}
            >
              {preview.text}
              {suffix}
            </Text>
          </Box>
        </Box>
      );
    }

    case 'notice': {
      const color =
        entry.tone === 'error'
          ? 'red'
          : entry.tone === 'warn'
            ? 'yellow'
            : undefined;
      return (
        <Box marginTop={1}>
          <Text color={color} dimColor={entry.tone === 'info'}>
            {entry.text}
          </Text>
        </Box>
      );
    }
  }
}

export function App({ config, tools }: { config: Config; tools: ToolRegistry }) {
  const { exit } = useApp();
  const [conversation] = useState(() => new Conversation(config, tools));
  const nextId = useRef(1);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const toolDetailRef = useRef(new Map<ToolCall, string>());
  const autoApproveRef = useRef(false);
  const approvalRef = useRef<((approved: boolean) => void) | null>(null);

  const [committed, setCommitted] = useState<Entry[]>([
    {
      id: 0,
      kind: 'notice',
      tone: 'info',
      text: `agent-harness · ${config.model}\nroot: ${config.root}${
        config.yolo ? '\nyolo: tool calls run without approval' : ''
      }\n\nType /help for commands, /exit to quit.`,
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveTool, setLiveTool] = useState<LiveTool | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);

  const settleApproval = (approved: boolean): void => {
    const resolve = approvalRef.current;
    approvalRef.current = null;
    setApproval(null);
    resolve?.(approved);
  };

  const requestApproval = (request: ApprovalRequest): Promise<boolean> => {
    if (config.yolo || autoApproveRef.current) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      approvalRef.current = resolve;
      setApproval(request);
    });
  };

  const commit = (entry: NewEntry): void => {
    const id = nextId.current++;
    setCommitted((current) => [...current, { ...entry, id } as Entry]);
  };

  const resetLive = (): void => {
    setLiveText('');
    setLiveTool(null);
  };

  useInput((character, key) => {
    if (approvalRef.current) {
      if (key.ctrl && character === 'c') {
        settleApproval(false);
        abortRef.current?.abort();
        return;
      }
      if (character === 'y' || character === 'Y' || key.return) {
        settleApproval(true);
        return;
      }
      if (character === 'a' || character === 'A') {
        autoApproveRef.current = true;
        settleApproval(true);
        commit({
          kind: 'notice',
          tone: 'warn',
          text: '(auto-approving tool calls for this session)',
        });
        return;
      }
      if (character === 'n' || character === 'N' || key.escape) {
        settleApproval(false);
        return;
      }
      return;
    }

    if (key.ctrl && character === 'c') {
      if (busyRef.current) {
        abortRef.current?.abort();
      } else {
        exit();
      }
      return;
    }

    if (key.escape && busyRef.current) {
      abortRef.current?.abort();
      return;
    }

    if (key.ctrl && character === 'd' && !busyRef.current) {
      exit();
    }
  });

  const submit = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text || busyRef.current) return;

    setInput('');

    const command = text.toLowerCase();
    if (command === '/exit' || command === '/quit') {
      exit();
      return;
    }
    if (command === '/help') {
      commit({ kind: 'notice', tone: 'info', text: HELP_TEXT });
      return;
    }
    if (command === '/reset') {
      conversation.reset();
      commit({ kind: 'notice', tone: 'warn', text: '(conversation cleared)' });
      return;
    }

    commit({ kind: 'user', text });
    resetLive();

    const controller = new AbortController();
    abortRef.current = controller;
    busyRef.current = true;
    setBusy(true);

    const onAssistantMessage = (message: ChatMessage): void => {
      const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
      const messageContent =
        typeof message.content === 'string' ? message.content : '';

      // Final answers are committed from the value returned by send(), so
      // only preambles that precede tool calls are committed here.
      if (hasToolCalls && messageContent) {
        commit({ kind: 'assistant', text: messageContent });
        setLiveText('');
      }
    };

    try {
      const answer = await conversation.send(text, {
        signal: controller.signal,
        approve: requestApproval,
        events: {
          onText: (delta) => setLiveText((current) => current + delta),
          onAssistantMessage,
          onToolStart: (call: ToolCall, args) => {
            const name = call.function?.name || 'tool';
            const detail = formatToolDetail(name, args);
            toolDetailRef.current.set(call, detail);
            setLiveText('');
            setLiveTool({ name, detail });
          },
          onToolEnd: (call, result, durationMs) => {
            const name = call.function?.name || 'tool';
            const detail = toolDetailRef.current.get(call) ?? '';
            toolDetailRef.current.delete(call);
            setLiveTool(null);
            commit({
              kind: 'tool',
              name,
              detail,
              status: /^\s*Error:/.test(result) ? 'error' : 'ok',
              durationMs,
              result,
            });
          },
        },
      });

      if (answer === '(stopped: max turns reached)') {
        commit({ kind: 'notice', tone: 'warn', text: answer });
      } else {
        commit({ kind: 'assistant', text: answer });
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        commit({ kind: 'notice', tone: 'warn', text: '(cancelled)' });
      } else {
        commit({
          kind: 'notice',
          tone: 'error',
          text: `error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      if (approvalRef.current) settleApproval(false);
      abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
      resetLive();
    }
  };

  return (
    <Box flexDirection="column">
      <Static items={committed}>
        {(entry) => <EntryView key={entry.id} entry={entry} />}
      </Static>

      {liveText ? (
        <Box marginTop={1}>
          <Text color="green" bold>
            assistant
          </Text>
          <Text dimColor> › </Text>
          <Text>
            {liveText}
            <Text color="green">▌</Text>
          </Text>
        </Box>
      ) : null}

      {liveTool ? (
        <Box marginTop={1} marginLeft={2}>
          <Text color="cyan">⠿</Text>
          <Text> </Text>
          <Text bold>{liveTool.name}</Text>
          {liveTool.detail ? (
            <Text dimColor>({liveTool.detail})</Text>
          ) : null}
        </Box>
      ) : null}

      {busy && !liveText && !liveTool ? (
        <Box marginTop={1}>
          <Spinner label="thinking…" />
        </Box>
      ) : null}

      {approval ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
        >
          <Text color="yellow" bold>
            approve {approval.name}?
          </Text>
          <Text>{approval.summary}</Text>
          {approval.warning ? (
            <Text color="red">{approval.warning}</Text>
          ) : null}
          <Text dimColor>y run once · a always · n deny</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="cyan" bold>
          you
        </Text>
        <Text dimColor> › </Text>
        {approval ? (
          <Text color="yellow">(waiting for approval)</Text>
        ) : busy ? (
          <Text dimColor>(waiting — ctrl+c to cancel)</Text>
        ) : (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={(value) => void submit(value)}
            placeholder="Ask anything, or /help"
          />
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {approval
            ? 'y approve · a always · n deny · ctrl+c cancel'
            : `enter send · ctrl+c ${busy ? 'cancel' : 'exit'} · /help commands`}
        </Text>
      </Box>
    </Box>
  );
}

export async function runTui(config: Config, tools: ToolRegistry): Promise<void> {
  const app = render(<App config={config} tools={tools} />, {
    exitOnCtrlC: false,
    interactive: true,
  });
  await app.waitUntilExit();
}
