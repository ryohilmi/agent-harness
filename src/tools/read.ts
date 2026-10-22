import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { integerArg, requireString } from './args.js';
import { resolveInRoot } from './fs.js';

interface Line {
  data: Buffer;
  /** Bytes consumed in the file, including the newline. */
  bytes: number;
}

async function* readLines(handle: FileHandle): AsyncGenerator<Line> {
  let pending = Buffer.alloc(0);

  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;

    const next = chunk.subarray(0, bytesRead);
    pending = pending.length
      ? Buffer.concat([pending, next])
      : Buffer.from(next);

    let newline: number;
    while ((newline = pending.indexOf(0x0a)) !== -1) {
      yield { data: pending.subarray(0, newline), bytes: newline + 1 };
      pending = pending.subarray(newline + 1);
    }
  }

  if (pending.length > 0) {
    yield { data: pending, bytes: pending.length };
  }
}

async function listDirectory(path: string, limit: number): Promise<string> {
  const dirents = await readdir(path, { withFileTypes: true });
  const entries: string[] = [];

  for (const dirent of dirents) {
    let isDirectory = dirent.isDirectory();
    if (!isDirectory && dirent.isSymbolicLink()) {
      try {
        isDirectory = (await stat(join(path, dirent.name))).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    entries.push(dirent.name + (isDirectory ? '/' : ''));
  }

  entries.sort();

  if (entries.length === 0) return '(empty directory)';
  if (entries.length > limit) {
    const extra = entries.length - limit;
    return [...entries.slice(0, limit), `... (${extra} more entries)`].join(
      '\n',
    );
  }
  return entries.join('\n');
}

export async function readTool(
  config: Config,
  args: Record<string, unknown>,
): Promise<string> {
  const path = requireString(args, 'path');
  const offset = integerArg(args, 'offset', 1);
  const limit = integerArg(args, 'limit', config.maxReadLines);

  if (offset < 1) return 'Error: offset must be 1 or greater.';
  if (limit < 1) return 'Error: limit must be 1 or greater.';

  const resolved = resolveInRoot(path, config.root);
  if (!resolved.ok) return resolved.error;

  let fileStat;
  try {
    fileStat = await stat(resolved.path);
  } catch {
    return `Error: no such file or directory: ${path}`;
  }

  if (fileStat.isDirectory()) {
    return listDirectory(resolved.path, limit);
  }
  if (!fileStat.isFile()) {
    return `Error: not a regular file: ${path}`;
  }

  const handle = await open(resolved.path, 'r');
  try {
    const probe = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (probe.subarray(0, bytesRead).includes(0)) {
      return `Error: '${path}' looks like a binary file; only text is supported.`;
    }

    const lines = readLines(handle);

    // Skip to the requested line without loading the whole file.
    for (let line = 1; line < offset; line += 1) {
      const skipped = await lines.next();
      if (skipped.done) {
        return `Error: offset ${offset} is past the end of the file.`;
      }
    }

    const collected: Line[] = [];
    let size = 0;
    let truncated = false;

    while (collected.length < limit) {
      const next = await lines.next();
      if (next.done) break;

      if (size + next.value.bytes > config.maxReadBytes) {
        truncated = true;
        break;
      }

      size += next.value.bytes;
      collected.push(next.value);
    }

    let hasMore = false;
    if (!truncated) {
      hasMore = !(await lines.next()).done;
    }

    if (collected.length === 0) return '(empty file)';

    const output = collected.map(
      (line, index) =>
        `${offset + index}: ${line.data.toString('utf8').replace(/\r$/, '')}`,
    );

    if (truncated) {
      output.push(
        `... (read limit of ${config.maxReadBytes} bytes reached)`,
      );
    } else if (hasMore) {
      output.push(
        `... (more lines; use offset=${offset + collected.length})`,
      );
    }

    return output.join('\n');
  } finally {
    await handle.close();
  }
}
