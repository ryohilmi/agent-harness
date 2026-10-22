export function requireString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`argument '${key}' must be a string`);
  }
  return value;
}

export function integerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    return Number(value);
  }

  throw new Error('offset and limit must be integers.');
}

export function booleanArg(
  args: Record<string, unknown>,
  key: string,
): boolean {
  const value = args[key];
  if (typeof value === 'string') {
    return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}
