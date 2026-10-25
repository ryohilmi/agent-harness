import type { Config } from '../config.js';
import type { ToolSchema } from '../types.js';
import { bashTool } from './bash.js';
import { evaluateExpression } from './calculator.js';
import { editTool } from './edit.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';

export interface ToolDefinition {
  schema: ToolSchema;
  /** Ask the user before running this tool (used by `bash`). */
  requiresApproval?: boolean;
  run(args: Record<string, unknown>): Promise<string> | string;
}

export class ToolRegistry {
  private readonly byName: Map<string, ToolDefinition>;
  private readonly approvalNames: Set<string>;
  readonly schemas: ToolSchema[];

  constructor(definitions: ToolDefinition[]) {
    this.byName = new Map(
      definitions.map((definition) => [definition.schema.function.name, definition]),
    );
    this.approvalNames = new Set(
      definitions
        .filter((definition) => definition.requiresApproval)
        .map((definition) => definition.schema.function.name),
    );
    this.schemas = definitions.map((definition) => definition.schema);
  }

  requiresApproval(name: string): boolean {
    return this.approvalNames.has(name);
  }

  /**
   * Parse and run a tool call. Tool failures are returned as text so the
   * model can recover instead of aborting the turn.
   */
  async execute(name: string, rawArguments: string): Promise<string> {
    const tool = this.byName.get(name);
    if (!tool) return `Error: unknown tool '${name}'`;

    let args: unknown;
    try {
      args = JSON.parse(rawArguments || '{}');
    } catch (error) {
      return `Error: invalid tool arguments: ${(error as Error).message}`;
    }

    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return 'Error: tool arguments must be a JSON object.';
    }

    try {
      return await tool.run(args as Record<string, unknown>);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function oneLine(text: string, max = 300): string {
  const flattened = text.replace(/\s+/g, ' ').trim();
  return flattened.length > max
    ? `${flattened.slice(0, max - 1)}…`
    : flattened;
}

/** A one-line description of a tool call, used in approval prompts. */
export function summarizeToolCall(
  name: string,
  args: Record<string, unknown> | null,
): string {
  if (!args) return name;

  const stringArg = (key: string): string =>
    typeof args[key] === 'string' ? (args[key] as string) : '';

  switch (name) {
    case 'bash': {
      const command = oneLine(stringArg('command'), 200);
      const cwd = stringArg('cwd');
      return cwd ? `${command}  (cwd: ${cwd})` : command;
    }
    case 'read': {
      const parts = [stringArg('path')];
      if (args.offset !== undefined) parts.push(`offset=${String(args.offset)}`);
      if (args.limit !== undefined) parts.push(`limit=${String(args.limit)}`);
      return oneLine(parts.filter(Boolean).join(' '));
    }
    case 'write':
    case 'edit':
      return oneLine(stringArg('path'));
    case 'calculator':
      return oneLine(stringArg('expression'));
    default:
      return oneLine(`${name} ${JSON.stringify(args)}`);
  }
}

export function createTools(config: Config): ToolRegistry {
  return new ToolRegistry([
    {
      schema: {
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Evaluate a safe arithmetic expression.',
          parameters: {
            type: 'object',
            properties: {
              expression: {
                type: 'string',
                description: "Arithmetic expression, e.g. '12 * 34 + 5'.",
              },
            },
            required: ['expression'],
          },
        },
      },
      run: (args) => {
        const expression = args.expression;
        if (typeof expression !== 'string') {
          throw new Error("argument 'expression' must be a string");
        }
        return evaluateExpression(expression);
      },
    },
    {
      requiresApproval: true,
      schema: {
        type: 'function',
        function: {
          name: 'bash',
          description:
            'Run a command with bash in the workspace root. Use this to run ' +
            'tests, builds, git, and other shell commands. The command runs ' +
            'without stdin, so avoid interactive programs. Returns stdout, ' +
            'stderr, and the exit code; long output is truncated. The user ' +
            'must approve each call unless yolo mode is on.',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: "Shell command, e.g. 'npm test'.",
              },
              cwd: {
                type: 'string',
                description:
                  'Directory to run in, relative to the workspace root ' +
                  '(default: the root). Must stay inside the root.',
              },
              timeout_ms: {
                type: 'integer',
                description: `Timeout in milliseconds (default ${config.bashTimeoutMs}).`,
              },
            },
            required: ['command'],
          },
        },
      },
      run: (args) => bashTool(config, args),
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'read',
          description:
            'Read a UTF-8 text file from disk, or list a directory. ' +
            'Returns numbered lines. Paths are relative to the working ' +
            'directory and must stay inside the allowed root.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: "File or directory path, e.g. 'src/index.ts'.",
              },
              offset: {
                type: 'integer',
                description:
                  '1-based line number to start reading from (default 1).',
              },
              limit: {
                type: 'integer',
                description: `Maximum number of lines to return (default ${config.maxReadLines}).`,
              },
            },
            required: ['path'],
          },
        },
      },
      run: (args) => readTool(config, args),
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'write',
          description:
            'Create a new UTF-8 text file, or overwrite an existing one ' +
            "completely. Prefer 'edit' for changes to existing files.",
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: "File path, e.g. 'notes/todo.md'.",
              },
              content: {
                type: 'string',
                description: 'Full file content to write.',
              },
            },
            required: ['path', 'content'],
          },
        },
      },
      run: (args) => writeTool(config, args),
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'edit',
          description:
            'Replace exact text in an existing file. Read the file first ' +
            'and include enough surrounding context for a unique match.',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: "File path, e.g. 'src/index.ts'.",
              },
              old_string: {
                type: 'string',
                description: 'Exact text to replace, including indentation.',
              },
              new_string: {
                type: 'string',
                description: 'Replacement text.',
              },
              replace_all: {
                type: 'boolean',
                description:
                  'Replace every match instead of requiring a unique one.',
              },
            },
            required: ['path', 'old_string', 'new_string'],
          },
        },
      },
      run: (args) => editTool(config, args),
    },
  ]);
}
