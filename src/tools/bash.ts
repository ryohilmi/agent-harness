import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import { integerArg, requireString } from './args.js';
import { resolveInRoot } from './fs.js';
import { isSecretEnvName } from './secrets.js';

const MAX_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The child gets a copy of the process environment with credential-looking
 * variables removed, so a model-issued `env` cannot leak API keys back into
 * the transcript. Names listed in `AGENT_BASH_ENV_ALLOW` pass through.
 */
export function buildBashEnv(
  config: Pick<Config, 'protectSecrets' | 'bashEnvAllow'>,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set(
    config.bashEnvAllow.map((name) => name.toLowerCase()),
  );
  const result: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (
      config.protectSecrets &&
      !allowed.has(name.toLowerCase()) &&
      isSecretEnvName(name)
    ) {
      continue;
    }
    result[name] = value;
  }

  result.NO_COLOR = '1';
  return result;
}

interface Output {
  chunks: Buffer[];
  bytes: number;
}

export async function bashTool(
  config: Config,
  args: Record<string, unknown>,
): Promise<string> {
  const command = requireString(args, 'command');
  if (!command.trim()) return 'Error: command must not be empty.';

  const timeoutMs = integerArg(args, 'timeout_ms', config.bashTimeoutMs);
  if (timeoutMs < 1) return 'Error: timeout_ms must be 1 or greater.';
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return `Error: timeout_ms must be at most ${MAX_TIMEOUT_MS}.`;
  }

  let cwd = config.root;
  if (args.cwd !== undefined) {
    const resolved = resolveInRoot(args.cwd, config.root);
    if (!resolved.ok) return resolved.error;
    cwd = resolved.path;
  }

  return new Promise<string>((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: buildBashEnv(config),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Give the command its own process group so a timeout can kill any
      // children it spawned (test runners, watchers, and so on).
      detached: process.platform !== 'win32',
    });

    const stdout: Output = { chunks: [], bytes: 0 };
    const stderr: Output = { chunks: [], bytes: 0 };
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (output: Output, data: Buffer): void => {
      if (truncated) return;

      const remaining = config.maxOutputBytes - totalBytes;
      if (data.length > remaining) {
        if (remaining > 0) {
          output.chunks.push(data.subarray(0, remaining));
          output.bytes += remaining;
          totalBytes += remaining;
        }
        truncated = true;
        return;
      }

      output.chunks.push(data);
      output.bytes += data.length;
      totalBytes += data.length;
    };

    child.stdout.on('data', (data: Buffer) => collect(stdout, data));
    child.stderr.on('data', (data: Buffer) => collect(stderr, data));

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Fall through to killing just the shell.
        }
      }
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) {
        resolve(`Error: could not run command: ${error.message}`);
        return;
      }

      resolve(
        formatResult(
          Buffer.concat(stdout.chunks, stdout.bytes).toString('utf8'),
          Buffer.concat(stderr.chunks, stderr.bytes).toString('utf8'),
          {
            code: child.exitCode,
            signal: child.signalCode,
            timedOut,
            truncated,
            maxOutputBytes: config.maxOutputBytes,
            timeoutMs,
          },
        ),
      );
    };

    child.on('error', finish);
    child.on('close', () => finish());
  });
}

interface ResultDetails {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  maxOutputBytes: number;
  timeoutMs: number;
}

function formatResult(
  stdout: string,
  stderr: string,
  details: ResultDetails,
): string {
  const lines: string[] = [];

  const out = stdout.replace(/\n+$/, '');
  const err = stderr.replace(/\n+$/, '');

  if (out) lines.push(out);
  if (err) lines.push(out ? `[stderr]\n${err}` : err);
  if (!out && !err && !details.truncated) lines.push('(no output)');

  if (details.truncated) {
    lines.push(
      `[output truncated at ${details.maxOutputBytes} bytes; narrow the command]`,
    );
  }

  if (details.timedOut) {
    lines.push(`[timed out after ${details.timeoutMs} ms]`);
  } else if (details.signal) {
    lines.push(`[terminated by signal ${details.signal}]`);
  } else {
    lines.push(`[exit code ${details.code ?? 1}]`);
  }

  return lines.join('\n');
}
