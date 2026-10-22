import { readFileSync } from 'node:fs';

/**
 * Parse simple KEY=VALUE lines from a .env file.
 *
 * Blank lines and lines starting with `#` are ignored. A single pair of
 * matching single or double quotes around the value is stripped.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;

    const equals = line.indexOf('=');
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();

    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === "'" || value[0] === '"')
    ) {
      value = value.slice(1, -1);
    }

    if (key) values[key] = value;
  }

  return values;
}

/**
 * Load a .env file without overriding variables that already exist.
 * A variable that is present but empty still counts as set, matching
 * Python's os.environ.setdefault behaviour.
 */
export function loadDotEnv(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (!(key in env)) env[key] = value;
  }
}
