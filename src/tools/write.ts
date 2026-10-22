import { stat } from 'node:fs/promises';
import type { Config } from '../config.js';
import { requireString } from './args.js';
import { atomicWrite, resolveInRoot } from './fs.js';

export async function writeTool(
  config: Config,
  args: Record<string, unknown>,
): Promise<string> {
  const path = requireString(args, 'path');
  const content = args.content;
  if (typeof content !== 'string') {
    return 'Error: content must be a string.';
  }

  const resolved = resolveInRoot(path, config.root);
  if (!resolved.ok) return resolved.error;

  let existed = false;
  try {
    const targetStat = await stat(resolved.path);
    if (targetStat.isDirectory()) {
      return `Error: '${path}' is a directory.`;
    }
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `Error: could not write '${path}': ${(error as Error).message}`;
    }
  }

  try {
    await atomicWrite(resolved.path, content);
  } catch (error) {
    return `Error: could not write '${path}': ${(error as Error).message}`;
  }

  const lines =
    (content.match(/\n/g)?.length ?? 0) +
    (content && !content.endsWith('\n') ? 1 : 0);
  const action = existed ? 'Overwrote' : 'Created';
  return `${action} ${path} (${Buffer.byteLength(content, 'utf8')} bytes, ${lines} line(s)).`;
}
