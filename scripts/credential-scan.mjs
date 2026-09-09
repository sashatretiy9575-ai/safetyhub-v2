/**
 * Credential detection for `check:security`, kept apart from the gate script so
 * the rules can be exercised directly. The gate itself walks the repository and
 * refuses to run outside one, which used to make its most important logic
 * untestable.
 */

// Values that legitimately appear in the repository: vendor-published test
// credentials, documented placeholders, and the throwaway strings the CI
// workflow feeds to its disposable local stack. Listing them explicitly keeps
// the scanner strict everywhere else.
export const ALLOWED_CREDENTIAL_LITERALS = [
  // Cloudflare publishes these as always-pass/always-fail Turnstile secrets.
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
  'local-ci-rate-limit-hmac-secret-not-a-production-value',
  'local-ci-certificate-verification-secret-not-production',
];

export const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bsb_secret_[A-Za-z0-9_-]{20,}\b/gu,
  /\bnpm_[A-Za-z0-9]{36}\b/gu,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  /\b[0-9]{6,12}:[A-Za-z0-9_-]{30,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/gu,
  // Cloudflare Turnstile secret keys, and the Standard Webhooks secret that
  // Supabase Auth signs the send-email hook with.
  /\b0x[A-Za-z0-9_-]{30,}\b/gu,
  /\bwhsec_[A-Za-z0-9+/=]{20,}\b/gu,
];

/**
 * Documentation, infrastructure config and operator scripts hold credentials
 * just as easily as application code, and were previously never scanned.
 */
export const TEXTUAL_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ps1',
  '.py',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

// A database URL that carries its own password is the single most damaging
// string this repository can leak. Local stacks and fixtures legitimately embed
// one, so the host and the password decide: loopback and Docker gateways are
// disposable, and a password that is literally `postgres` is the documented
// default rather than a credential.
const CONNECTION_STRING_PATTERN =
  /\bpostgres(?:ql)?:\/\/([^\s'"`@/:]{1,200}):([^\s'"`@/]{1,200})@([^\s'"`/:]{1,200})/gu;

const DISPOSABLE_DATABASE_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  'host.docker.internal',
  '172.17.0.1',
]);

const NON_SECRET_DATABASE_PASSWORDS = new Set(['postgres', 'password', 'secret%3Avalue']);

function withoutAllowedLiterals(source) {
  let text = source;
  for (const literal of ALLOWED_CREDENTIAL_LITERALS) text = text.replaceAll(literal, '');
  return text;
}

/**
 * Returns the reasons a file must not be committed, or an empty array.
 * Reasons never quote the matched value: a gate that prints the secret it
 * found copies it into CI logs.
 */
export function scanForCredentials(source) {
  const text = withoutAllowedLiterals(source);
  const reasons = [];

  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matched = pattern.test(text);
    pattern.lastIndex = 0;
    if (matched) {
      reasons.push('credential-like value');
      break;
    }
  }

  CONNECTION_STRING_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(CONNECTION_STRING_PATTERN)) {
    const [, , password, host] = match;
    if (DISPOSABLE_DATABASE_HOSTS.has(host)) continue;
    if (NON_SECRET_DATABASE_PASSWORDS.has(password)) continue;
    reasons.push(`database connection string (host ${host})`);
    break;
  }

  return reasons;
}
