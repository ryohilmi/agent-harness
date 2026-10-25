import { chatStream } from './llm.js';
import type { Config } from './config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { summarizeToolCall, type ToolRegistry } from './tools/index.js';
import { mentionsSecretPath } from './tools/secrets.js';
import type { ChatMessage, ToolCall } from './types.js';

export interface AgentEvents {
  /** Incremental assistant text from the current model response. */
  onText?: (delta: string) => void;
  /** A complete assistant message, including any tool calls. */
  onAssistantMessage?: (message: ChatMessage, finishReason: string | null) => void;
  onToolStart?: (
    call: ToolCall,
    args: Record<string, unknown> | null,
  ) => void;
  onToolEnd?: (call: ToolCall, result: string, durationMs: number) => void;
}

/** One tool call that needs an explicit yes/no from the user. */
export interface ApprovalRequest {
  name: string;
  /** One-line description, e.g. the shell command. */
  summary: string;
  args: Record<string, unknown>;
  /** Extra caution to show above the prompt. */
  warning?: string;
}

export interface SendOptions {
  events?: AgentEvents;
  signal?: AbortSignal;
  /**
   * Called before a tool that requires approval runs. Resolve false to skip
   * it. When omitted, such tools fail closed with an explanatory error.
   */
  approve?: (request: ApprovalRequest) => Promise<boolean>;
}

function approvalWarning(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  if (name === 'bash' && typeof args.command === 'string') {
    if (mentionsSecretPath(args.command)) {
      return 'This command mentions files or directories that usually hold secrets.';
    }
  }
  return undefined;
}

async function callTool(
  name: string,
  rawArguments: string,
  args: Record<string, unknown> | null,
  tools: ToolRegistry,
  approve: SendOptions['approve'],
): Promise<string> {
  if (!args || !tools.requiresApproval(name)) {
    return tools.execute(name, rawArguments);
  }

  const request: ApprovalRequest = {
    name,
    summary: summarizeToolCall(name, args),
    args,
    warning: approvalWarning(name, args),
  };

  // Fail closed when there is no way to ask, e.g. a piped single-shot run.
  if (!approve) {
    return `Error: '${name}' requires interactive approval, but no approval prompt is available. Ask the user to approve it, or rerun the harness with --yolo to allow tool execution without approval.`;
  }

  if (!(await approve(request))) {
    return `Error: the user denied this ${name} call. Do not retry it; explain what you wanted to do and ask how to proceed.`;
  }

  return tools.execute(name, rawArguments);
}

export function messageText(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : '';
}

function parseToolArguments(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Invalid JSON is reported by ToolRegistry.execute.
  }
  return null;
}

export async function runTurn(
  messages: ChatMessage[],
  config: Config,
  tools: ToolRegistry,
  options: SendOptions = {},
): Promise<string> {
  const events = options.events ?? {};

  for (let turn = 0; turn < config.maxTurns; turn += 1) {
    const { message, finishReason } = await chatStream(
      config,
      messages,
      tools.schemas,
      { onText: events.onText, signal: options.signal },
    );

    messages.push(message);
    events.onAssistantMessage?.(message, finishReason);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const text = messageText(message);
      if (text) return text;
      return finishReason
        ? `(no text; finish_reason=${finishReason})`
        : '(no text)';
    }

    for (const call of calls) {
      const name = call.function?.name ?? '';
      const rawArguments = call.function?.arguments || '{}';
      const args = parseToolArguments(rawArguments);
      events.onToolStart?.(call, args);

      const started = Date.now();
      const result = await callTool(
        name,
        rawArguments,
        args,
        tools,
        options.approve,
      );
      const durationMs = Date.now() - started;

      events.onToolEnd?.(call, result, durationMs);
      messages.push({
        role: 'tool',
        tool_call_id: call.id ?? '',
        content: result,
      });
    }
  }

  return '(stopped: max turns reached)';
}

/** A chat history that can be continued across multiple user turns. */
export class Conversation {
  messages: ChatMessage[];

  constructor(
    readonly config: Config,
    readonly tools: ToolRegistry,
    systemPrompt: string = buildSystemPrompt(),
  ) {
    this.messages = [{ role: 'system', content: systemPrompt }];
  }

  /** Drop everything except the system prompt. */
  reset(): void {
    this.messages = this.messages.slice(0, 1);
  }

  /** Append a user message, run the agent loop, and return the reply. */
  async send(userInput: string, options: SendOptions = {}): Promise<string> {
    const start = this.messages.length;
    this.messages.push({ role: 'user', content: userInput });

    try {
      return await runTurn(this.messages, this.config, this.tools, options);
    } catch (error) {
      // Don't leave a dangling user message behind if the call failed.
      this.messages.splice(start);
      throw error;
    }
  }
}
