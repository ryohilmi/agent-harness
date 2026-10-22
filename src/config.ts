import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.js';

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  maxReadLines: number;
  maxReadBytes: number;
  /** Absolute directory the file tools are confined to. */
  root: string;
}

export const DEFAULT_BASE_URL = 'https://api.vikey.ai/v1/chat/completions';
export const DEFAULT_MODEL = 'gpt-4o-mini';

/** Walk up from this module until a package.json is found. */
export function findProjectRoot(start?: string): string {
  let dir = start ?? dirname(fileURLToPath(import.meta.url));

  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Load `.env` from the project root (next to package.json). */
export function loadProjectEnv(): void {
  loadDotEnv(join(findProjectRoot(), '.env'));
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Absolute, symlink-resolved root used for path confinement. */
function canonicalRoot(path: string): string {
  const absolute = resolve(expandHome(path));
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') {
    throw new Error(`${name} must be an integer (got an empty value).`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

function floatEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') {
    throw new Error(`${name} must be a number (got an empty value).`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number (got ${JSON.stringify(raw)}).`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const configuredRoot =
    env.AGENT_ROOT || env.AGENT_READ_ROOT || process.cwd();

  return {
    apiKey: env.OPENAI_API_KEY || env.LLM_API_KEY || '',
    baseUrl:
      env.OPENAI_BASE_URL || env.LLM_BASE_URL || DEFAULT_BASE_URL,
    model: env.OPENAI_MODEL || env.LLM_MODEL || DEFAULT_MODEL,
    maxTurns: integerEnv(env, 'AGENT_MAX_TURNS', 8),
    timeoutMs: floatEnv(env, 'OPENAI_TIMEOUT', 60) * 1000,
    maxReadLines: integerEnv(env, 'AGENT_MAX_READ_LINES', 2000),
    maxReadBytes: integerEnv(env, 'AGENT_MAX_READ_BYTES', 1_000_000),
    root: canonicalRoot(configuredRoot),
  };
}
