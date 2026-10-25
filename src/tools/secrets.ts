/**
 * Best-effort secret protection for the file and bash tools.
 *
 * This is a guard rail, not a sandbox: it stops the model from casually
 * reading `.env` or dumping `OPENAI_API_KEY` into a tool result, but an
 * approved bash command can still reach anything the current user can.
 */

const SECRET_ENV =
  /(?:^|_)(?:API_?KEY|AUTH|SECRET|SECRETS|TOKEN|TOKENS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|CREDENTIALS|PRIVATE_?KEY|ACCESS_?KEY|SESSION_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY)(?:_|$)/i;

/** Names that look secret-ish but must keep working (git over ssh, etc.). */
const ENV_KEEP = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID']);

/** Directories that usually hold credentials. */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);

/** Exact file names that hold credentials. */
const SECRET_NAMES = new Set([
  '.netrc',
  '.pgpass',
  '.git-credentials',
  '.npmrc',
  'credentials',
  'credentials.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
]);

const SECRET_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.p8'];

const PRIVATE_KEY_NAME = /^id_(?:rsa|dsa|ecdsa|ed25519)$/i;

const ENV_FILE = /^\.env(?:\.([\w.-]+))?$/i;

/** `.env` and friends, but not templates such as `.env.example`. */
const ENV_FILE_TEMPLATES = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'schema',
  'defaults',
]);

function looksLikeEnvFile(name: string): boolean {
  const match = ENV_FILE.exec(name);
  if (!match) return false;
  const suffix = (match[1] ?? '').toLowerCase();
  return !ENV_FILE_TEMPLATES.has(suffix);
}

export function isSecretEnvName(name: string): boolean {
  if (ENV_KEEP.has(name.toUpperCase())) return false;
  return SECRET_ENV.test(name);
}

/** True when a path matches the built-in credential denylist. */
export function isSecretPath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const name = segments.pop() ?? '';

  if (segments.some((segment) => SECRET_DIRS.has(segment.toLowerCase()))) {
    return true;
  }

  if (looksLikeEnvFile(name)) return true;

  const lower = name.toLowerCase();
  if (SECRET_NAMES.has(lower)) return true;
  if (PRIVATE_KEY_NAME.test(name)) return true;
  return SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** A short explanation for why a read was refused, or null when it is fine. */
export function secretPathReason(path: string): string | null {
  if (!isSecretPath(path)) return null;
  return (
    'it matches the harness secret-file denylist ' +
    '(env files, private keys, and credential stores)'
  );
}

const SECRET_MENTION =
  /(?:^|[\s"'`=<>|;&()/,])(?:\.env(?!\.(?:example|sample|template)\b)(?:\.[\w.-]+)?|\.ssh|\.aws|\.gnupg|\.kube|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|[^\s"'`|;&()]+\.(?:pem|key|p12|pfx|jks|keystore))\b/i;

/** Used to warn on the approval prompt when a command touches secrets. */
export function mentionsSecretPath(command: string): boolean {
  return SECRET_MENTION.test(command);
}
