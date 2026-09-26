// Shared by the scripts/content/apply-*.mjs publication tools: argument parsing, the target
// guard (the same host rules as publish-course-batch), the operator session and the CLI shell.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { operatorSession } from '../publish-course-batch.mjs';
import { createSupabaseRepository } from '../publish-stage6-localizations.mjs';
import {
  CURRENT_PRODUCTION_PROJECT_REF,
  assertLinkedProductionProjectRef,
} from '../production-operator-safety.mjs';

export const LOCALES = ['ru', 'kk', 'en', 'zh'];
export const TRANSLATED = ['kk', 'en', 'zh'];
const SHA256 = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const MARKUP = /<\s*script/iu;

export class ContentFixError extends Error {
  constructor(code, details = []) {
    super(code);
    this.name = 'ContentFixError';
    this.code = code;
    this.details = details;
  }
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const clean = (value) => (typeof value === 'string' ? value.trim() : value);
export const isObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  return value;
}
export const sameJson = (left, right) =>
  JSON.stringify(sortJson(left ?? null)) === JSON.stringify(sortJson(right ?? null));

/** The text rules the course and article RPCs enforce, as a refusal code or null. */
export function textProblem(value, max) {
  if (typeof value !== 'string' || !value.trim()) return 'TEXT_EMPTY';
  if ([...value.trim()].length > max) return 'TEXT_TOO_LONG';
  if (CONTROL.test(value)) return 'TEXT_CONTROL_CHARACTER';
  if (MARKUP.test(value)) return 'TEXT_MARKUP';
  return null;
}

/**
 * --plan|--apply, --target, --confirm-hash, --pending-draft, --operator-email, --diff and the
 * tool's own `--name=value` arguments; `required` names must be present.
 */
export function parseCommonArguments(argv, { names, required }) {
  const flags = new Set(['--plan', '--apply', '--diff']);
  const all = ['target', 'confirm-hash', 'pending-draft', 'operator-email', ...names];
  for (const argument of argv)
    if (!flags.has(argument) && !all.some((name) => argument.startsWith(`--${name}=`)))
      throw new ContentFixError('UNKNOWN_ARGUMENT', [argument]);
  const values = {};
  for (const name of all) {
    const found = argv.filter((argument) => argument.startsWith(`--${name}=`));
    if (found.length > 1) throw new ContentFixError('DUPLICATE_ARGUMENT', [name]);
    values[name] = found[0]?.slice(name.length + 3) || null;
  }
  if (argv.includes('--plan') === argv.includes('--apply'))
    throw new ContentFixError('CHOOSE_PLAN_OR_APPLY');
  if (!['local', 'production'].includes(values.target))
    throw new ContentFixError('TARGET_REQUIRED');
  for (const name of required)
    if (!values[name]) throw new ContentFixError(`${name.toUpperCase()}_REQUIRED`);
  if (values['pending-draft'] && !['publish', 'discard'].includes(values['pending-draft']))
    throw new ContentFixError('PENDING_DRAFT_INVALID');
  if (values['confirm-hash'] && !SHA256.test(values['confirm-hash']))
    throw new ContentFixError('CONFIRM_HASH_INVALID');
  return {
    mode: argv.includes('--plan') ? 'plan' : 'apply',
    target: values.target,
    confirmHash: values['confirm-hash'],
    pendingDraft: values['pending-draft'],
    operatorEmail: values['operator-email'],
    diff: argv.includes('--diff'),
    values,
  };
}

/** The same host rules as publish-course-batch, plus the reviewed-file hash for production. */
export function guardTarget({ target, mode, url, secret, confirmHash, fileSha256 }) {
  if (!url || !secret) throw new ContentFixError('ENVIRONMENT_REQUIRED');
  const parsed = new URL(url);
  const local = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (target !== (local ? 'local' : 'production')) throw new ContentFixError('TARGET_MISMATCH');
  if (
    !local &&
    (parsed.protocol !== 'https:' ||
      parsed.hostname !== `${CURRENT_PRODUCTION_PROJECT_REF}.supabase.co`)
  )
    throw new ContentFixError('PRODUCTION_TARGET_MISMATCH');
  if (confirmHash && confirmHash !== fileSha256)
    throw new ContentFixError('CONFIRM_HASH_MISMATCH', [`file sha256 is ${fileSha256}`]);
  if (!local && mode === 'apply' && !confirmHash)
    throw new ContentFixError('REVIEWED_FILE_HASH_REQUIRED', [`--confirm-hash=${fileSha256}`]);
  return { local, host: parsed.hostname };
}

/** Guarded service-key client for the target named on the command line. */
export async function connectTarget(options, fileSha256, environment = process.env) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const secret = environment.SUPABASE_SECRET_KEY;
  const { local, host } = guardTarget({ ...options, url, secret, fileSha256 });
  if (!local) await assertLinkedProductionProjectRef(CURRENT_PRODUCTION_PROJECT_REF);
  const service = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { service, url, secret, local, host };
}

/**
 * The operator the writes are attributed to: the local seeded admin, or on production the
 * SAFETYHUB_CONTENT_OPERATOR_ACCESS_TOKEN session or a magic-link session for --operator-email.
 */
export async function operatorRepository({ service, url, secret, local, operatorEmail, receipt }) {
  const { token, operator, actorId } = await operatorSession(
    service,
    url,
    secret,
    local,
    operatorEmail,
  );
  const repo = createSupabaseRepository({
    url,
    serviceSecret: secret,
    operatorAccessToken: token,
    root: process.cwd(),
    batchHash: receipt,
  });
  await repo.assertOperator(actorId);
  return { repo, operator, actorId };
}

/** Prints the report (or the refusal) as JSON and sets the exit code. */
export async function runCli(moduleUrl, run) {
  if (!process.argv[1] || pathToFileURL(path.resolve(process.argv[1])).href !== moduleUrl) return;
  try {
    const report = await run(process.argv.slice(2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error.code ?? error.message,
          details: error.details ?? [error.message],
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
