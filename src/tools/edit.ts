import { readFile, stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { Config } from '../config.js';
import { booleanArg, requireString } from './args.js';
import { atomicWrite, resolveInRoot } from './fs.js';

export async function editTool(
  config: Config,
  args: Record<string, unknown>,
): Promise<string> {
  const path = requireString(args, 'path');
  const oldValue = args.old_string;
  const newValue = args.new_string;
  const replaceAll = booleanArg(args, 'replace_all');

  if (typeof oldValue !== 'string' || typeof newValue !== 'string') {
    return 'Error: old_string and new_string must be strings.';
  }

  let oldString: string = oldValue;
  let newString: string = newValue;

  if (!oldString) {
    return 'Error: old_string must not be empty.';
  }
  if (oldString === newString) {
    return 'Error: old_string and new_string are identical; nothing to do.';
  }

  const resolved = resolveInRoot(path, config.root);
  if (!resolved.ok) return resolved.error;

  let targetStat;
  try {
    targetStat = await stat(resolved.path);
  } catch {
    return `Error: no such file: ${path}`;
  }
  if (!targetStat.isFile()) {
    return `Error: not a regular file: ${path}`;
  }
  if (targetStat.size > config.maxReadBytes) {
    return `Error: '${path}' is larger than the edit limit (${config.maxReadBytes} bytes).`;
  }

  const bytes = await readFile(resolved.path);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return `Error: '${path}' is not valid UTF-8 text.`;
  }

  // Match CRLF files even when the model supplies LF-only snippets.
  if (text.includes('\r\n') && !oldString.includes('\r\n')) {
    const oldCrlf = oldString.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const newCrlf = newString.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    if (text.includes(oldCrlf)) {
      oldString = oldCrlf;
      newString = newCrlf;
    }
  }

  const count = text.split(oldString).length - 1;
  if (count === 0) {
    return `Error: old_string not found in '${path}'.`;
  }
  if (count > 1 && !replaceAll) {
    return `Error: old_string appears ${count} times in '${path}'; add more context to make it unique, or pass replace_all=true.`;
  }

  let updated: string;
  if (replaceAll) {
    updated = text.split(oldString).join(newString);
  } else {
    const index = text.indexOf(oldString);
    updated =
      text.slice(0, index) + newString + text.slice(index + oldString.length);
  }

  try {
    await atomicWrite(resolved.path, updated);
  } catch (error) {
    return `Error: could not write '${path}': ${(error as Error).message}`;
  }

  return `Edited ${path}: replaced ${replaceAll ? count : 1} occurrence(s).`;
}
