import { createInterface, type Interface } from 'node:readline/promises';
import { stderr, stdin, stdout } from 'node:process';
import type { ApprovalRequest } from './agent.js';

export interface Approver {
  approve(request: ApprovalRequest): Promise<boolean>;
  /** Close a terminal this approver created; a shared one is left alone. */
  close(): void;
}

export interface ApproverOptions {
  /** Reuse an existing readline terminal (the REPL owns and closes it). */
  terminal?: Interface;
  /** Where prompts go. Defaults to stdout on a TTY, otherwise stderr. */
  output?: NodeJS.WritableStream;
}

/** Approver used by `--yolo`: every call is allowed. */
export function alwaysApprove(): Approver {
  return { approve: async () => true, close: () => {} };
}

/**
 * Ask the user before a tool runs. Approval is per call unless the user
 * picks "always" for the rest of the session.
 */
export function createApprover(options: ApproverOptions = {}): Approver {
  const output = options.output ?? (stdout.isTTY ? stdout : stderr);
  let terminal = options.terminal;
  let owned = false;
  let autoApprove = false;

  const getTerminal = (): Interface => {
    if (!terminal) {
      terminal = createInterface({ input: stdin, output });
      owned = true;
    }
    return terminal;
  };

  return {
    async approve(request: ApprovalRequest): Promise<boolean> {
      if (autoApprove) return true;

      const lines = [
        '',
        `tool: ${request.name}`,
        `  ${request.summary}`,
      ];
      if (request.warning) lines.push(`  warning: ${request.warning}`);
      output.write(`${lines.join('\n')}\n`);

      let answer: string;
      try {
        answer = await getTerminal().question(
          'Run it? [y]es / [a]lways / [N]o ',
        );
      } catch {
        return false;
      }

      const choice = answer.trim().toLowerCase();
      if (choice === 'a' || choice === 'always') {
        autoApprove = true;
        output.write(
          '  (auto-approving tool calls for the rest of this session)\n',
        );
        return true;
      }
      return choice === 'y' || choice === 'yes';
    },

    close(): void {
      if (owned) terminal?.close();
      terminal = undefined;
      owned = false;
    },
  };
}
