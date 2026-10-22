import type { Config } from './config.js';
import type { ChatMessage, ToolCall, ToolSchema, Usage } from './types.js';

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
  usage?: Usage;
}

export interface ChatOptions {
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions')
    ? base
    : `${base}/chat/completions`;
}

function contentToText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (
          part &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
    return text || null;
  }
  return null;
}

function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((call) => {
    const record = (call ?? {}) as Record<string, unknown>;
    const fn = (record.function ?? {}) as Record<string, unknown>;
    return {
      id: typeof record.id === 'string' ? record.id : '',
      type: 'function',
      function: {
        name: typeof fn.name === 'string' ? fn.name : '',
        arguments:
          typeof fn.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {}),
      },
    };
  });
}

function normalizeMessage(raw: unknown): ChatMessage {
  const record = (raw ?? {}) as Record<string, unknown>;
  const message: ChatMessage = {
    role: 'assistant',
    content: contentToText(record.content),
  };

  const toolCalls = normalizeToolCalls(record.tool_calls);
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return message;
}

interface StreamState {
  content: string;
  toolCalls: Map<number, ToolCall>;
  finishReason: string | null;
  usage?: Usage;
  sawChoice: boolean;
}

function appendName(current: string, fragment: string): string {
  if (!current) return fragment;
  if (fragment === current) return current;
  return current + fragment;
}

function consumeChunk(
  chunk: unknown,
  state: StreamState,
  onText?: (delta: string) => void,
): void {
  const record = (chunk ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];

  if (record.usage && typeof record.usage === 'object') {
    state.usage = record.usage as Usage;
  }

  if (choices.length === 0) return;
  state.sawChoice = true;

  const choice = (choices[0] ?? {}) as Record<string, unknown>;
  if (typeof choice.finish_reason === 'string') {
    state.finishReason = choice.finish_reason;
  }

  const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;

  const content = contentToText(delta.content);
  if (content) {
    state.content += content;
    onText?.(content);
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const [fallbackIndex, rawCall] of delta.tool_calls.entries()) {
      if (!rawCall || typeof rawCall !== 'object') continue;

      const raw = rawCall as Record<string, unknown>;
      const index =
        typeof raw.index === 'number' ? raw.index : fallbackIndex;
      let call = state.toolCalls.get(index);
      if (!call) {
        call = {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        state.toolCalls.set(index, call);
      }

      if (typeof raw.id === 'string' && raw.id) call.id = raw.id;

      const fn = raw.function;
      if (fn && typeof fn === 'object') {
        const fnRecord = fn as Record<string, unknown>;
        if (typeof fnRecord.name === 'string' && fnRecord.name) {
          call.function.name = appendName(call.function.name, fnRecord.name);
        }
        if (typeof fnRecord.arguments === 'string') {
          call.function.arguments += fnRecord.arguments;
        }
      }
    }
  }
}

function streamMessage(state: StreamState): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: state.content || null,
  };

  const toolCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);

  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export async function chatStream(
  config: Config,
  messages: ChatMessage[],
  tools: ToolSchema[],
  options: ChatOptions = {},
): Promise<ChatResult> {
  const url = chatCompletionsUrl(config.baseUrl);
  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
  };

  if (tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const signals: AbortSignal[] = [];
  if (config.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(config.timeoutMs));
  }
  if (options.signal) signals.push(options.signal);
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(
        `Request to ${url} timed out after ${config.timeoutMs / 1000}s`,
      );
    }
    if (isAbortError(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${url}: ${reason}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LLM API error ${response.status} from ${url}: ${body}`);
  }

  const contentType = response.headers.get('content-type') ?? '';

  // Some gateways ignore stream=true and return a normal JSON body.
  if (!contentType.includes('text/event-stream')) {
    const data = (await response.json()) as Record<string, unknown>;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    if (choices.length === 0) {
      throw new Error(`LLM returned no choices: ${JSON.stringify(data)}`);
    }

    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    return {
      message: normalizeMessage(choice.message),
      finishReason:
        typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      usage: data.usage as Usage | undefined,
    };
  }

  if (!response.body) {
    throw new Error(`LLM returned an empty response body from ${url}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = {
    content: '',
    toolCalls: new Map(),
    finishReason: null,
    sawChoice: false,
  };

  let buffer = '';
  let done = false;

  const processLine = (line: string): boolean => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!trimmed.startsWith('data:')) return false;

    const data = trimmed.slice(5).trim();
    if (!data) return false;
    if (data === '[DONE]') return true;

    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return false;
    }

    consumeChunk(chunk, state, options.onText);
    return false;
  };

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;

      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (processLine(line)) {
          done = true;
          break;
        }
      }
    }

    if (!done && buffer) processLine(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!state.sawChoice && !state.content && state.toolCalls.size === 0) {
    throw new Error('LLM returned no choices');
  }

  return {
    message: streamMessage(state),
    finishReason: state.finishReason,
    usage: state.usage,
  };
}
