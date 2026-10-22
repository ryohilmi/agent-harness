import {
  chmod,
  mkdir,
  open,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Resolve symlinks for the deepest existing ancestor of a path. */
function realpathOfNearest(path: string): string {
  let current = path;
  const missing: string[] = [];

  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}


export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Resolve a user/model supplied path inside the workspace root.
 * Relative paths are resolved against the root; absolute paths are allowed
 * as long as they stay inside it after symlinks are resolved.
 */
export function resolveInRoot(
  input: unknown,
  root: string,
): ResolveResult {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, error: 'Error: path must be a non-empty string.' };
  }

  const target = expandHome(input);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const resolved = realpathOfNearest(absolute);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;

  if (resolved !== root && !resolved.startsWith(rootPrefix)) {
    return {
      ok: false,
      error: `Error: '${input}' is outside the allowed root (${root}).`,
    };
  }

  return { ok: true, path: resolved };
}

/**
 * Write through a temp file in the same directory so a failure cannot
 * truncate the original. Preserves the mode of an existing target.
 */
export async function atomicWrite(target: string, text: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });

  const temp = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`,
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.close();
    handle = undefined;

    try {
      const targetStat = await stat(target);
      await chmod(temp, targetStat.mode & 0o777);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
