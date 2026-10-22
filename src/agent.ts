import { chatStream } from './llm.js';
import type { Config } from './config.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { ToolRegistry } from './tools/index.js';
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

export interface SendOptions {
  events?: AgentEvents;
  signal?: AbortSignal;
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
      events.onToolStart?.(call, parseToolArguments(rawArguments));

      const started = Date.now();
      const result = await tools.execute(name, rawArguments);
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
