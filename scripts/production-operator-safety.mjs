import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { PRODUCTION_PROJECT_REF } from './load-test-safety.mjs';

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ENV_FILE_BYTES = 64 * 1024;
const MAX_STDIN_SECRET_BYTES = 8 * 1024;

export class ProductionOperatorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProductionOperatorError';
    this.code = code;
  }
}

function fail(code) {
  throw new ProductionOperatorError(code);
}

function requireCondition(condition, code) {
  if (!condition) fail(code);
}

export const CURRENT_PRODUCTION_PROJECT_REF = PRODUCTION_PROJECT_REF;

export function assertProjectRef(value, code = 'OPERATOR_PROJECT_REF_INVALID') {
  requireCondition(typeof value === 'string' && PROJECT_REF_PATTERN.test(value), code);
  return value;
}

export function assertCurrentProductionProjectRef(value) {
  const projectRef = assertProjectRef(value);
  requireCondition(
    projectRef === CURRENT_PRODUCTION_PROJECT_REF,
    'OPERATOR_PROJECT_REF_NOT_CURRENT_PRODUCTION',
  );
  return projectRef;
}

export function assertProductionMutationConfirmation(projectRef, confirmation) {
  const expected = assertCurrentProductionProjectRef(projectRef);
  requireCondition(confirmation === expected, 'OPERATOR_PROJECT_REF_CONFIRMATION_MISMATCH');
  return expected;
}

export function productionSupabaseUrl(projectRef) {
  return `https://${assertCurrentProductionProjectRef(projectRef)}.supabase.co`;
}

export function assertIdempotencyKey(value) {
  requireCondition(
    typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value),
    'OPERATOR_IDEMPOTENCY_KEY_INVALID',
  );
  return value;
}

export function assertReason(value) {
  requireCondition(
    typeof value === 'string' &&
      value.length >= 8 &&
      value.length <= 500 &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    'OPERATOR_REASON_INVALID',
  );
  return value;
}

export async function assertLinkedProductionProjectRef(
  expectedProjectRef,
  { projectRefFile = path.resolve('supabase', '.temp', 'project-ref') } = {},
) {
  const expected = assertCurrentProductionProjectRef(expectedProjectRef);
  const absoluteFile = path.resolve(projectRefFile);
  let stats;
  let bytes;
  try {
    stats = await lstat(absoluteFile);
    requireCondition(
      stats.isFile() && !stats.isSymbolicLink(),
      'OPERATOR_LINKED_PROJECT_REF_UNAVAILABLE',
    );
    requireCondition(stats.size > 0 && stats.size <= 128, 'OPERATOR_LINKED_PROJECT_REF_INVALID');
    const resolved = await realpath(absoluteFile);
    requireCondition(resolved === absoluteFile, 'OPERATOR_LINKED_PROJECT_REF_ALIAS_REJECTED');
    bytes = await readFile(absoluteFile);
  } catch (error) {
    if (error instanceof ProductionOperatorError) throw error;
    fail('OPERATOR_LINKED_PROJECT_REF_UNAVAILABLE');
  }
  try {
    const linked = bytes.toString('utf8').trim();
    requireCondition(PROJECT_REF_PATTERN.test(linked), 'OPERATOR_LINKED_PROJECT_REF_INVALID');
    requireCondition(linked === expected, 'OPERATOR_LINKED_PROJECT_REF_MISMATCH');
    return linked;
  } finally {
    bytes?.fill(0);
  }
}

function requiredAssignmentCount(serialized, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return serialized.match(new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`, 'gmu'))?.length ?? 0;
}

export async function readOperatorEnvironmentFile(environmentFile, requiredNames) {
  requireCondition(
    typeof environmentFile === 'string' && path.isAbsolute(environmentFile),
    'OPERATOR_ENV_FILE_PATH_INVALID',
  );
  requireCondition(
    Array.isArray(requiredNames) &&
      requiredNames.length > 0 &&
      new Set(requiredNames).size === requiredNames.length &&
      requiredNames.every((name) => /^[A-Z][A-Z0-9_]*$/u.test(name)),
    'OPERATOR_ENV_REQUIRED_NAMES_INVALID',
  );
  let stats;
  let bytes;
  try {
    stats = await lstat(environmentFile);
    requireCondition(stats.isFile() && !stats.isSymbolicLink(), 'OPERATOR_ENV_FILE_UNAVAILABLE');
    requireCondition(
      stats.size > 0 && stats.size <= MAX_ENV_FILE_BYTES,
      'OPERATOR_ENV_FILE_SIZE_INVALID',
    );
    bytes = await readFile(environmentFile);
  } catch (error) {
    if (error instanceof ProductionOperatorError) throw error;
    fail('OPERATOR_ENV_FILE_UNAVAILABLE');
  }
  try {
    const serialized = bytes.toString('utf8');
    requireCondition(!serialized.includes('\0'), 'OPERATOR_ENV_FILE_INVALID');
    let parsed;
    try {
      parsed = parseEnv(serialized);
    } catch {
      fail('OPERATOR_ENV_FILE_INVALID');
    }
    const selected = Object.create(null);
    for (const name of requiredNames) {
      requireCondition(
        requiredAssignmentCount(serialized, name) === 1,
        'OPERATOR_ENV_ASSIGNMENT_INVALID',
      );
      const value = parsed[name];
      requireCondition(
        typeof value === 'string' && value.length > 0 && !/[\r\n]/u.test(value),
        'OPERATOR_ENV_VALUE_INVALID',
      );
      selected[name] = value;
    }
    return selected;
  } finally {
    bytes?.fill(0);
  }
}

async function readSecretTextFromStdin(input, parse) {
  requireCondition(
    input && typeof input[Symbol.asyncIterator] === 'function',
    'OPERATOR_STDIN_UNAVAILABLE',
  );
  requireCondition(input.isTTY !== true, 'OPERATOR_STDIN_TTY_REJECTED');
  const chunks = [];
  let total = 0;
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
      total += chunk.byteLength;
      requireCondition(total <= MAX_STDIN_SECRET_BYTES, 'OPERATOR_STDIN_SECRET_TOO_LARGE');
      chunks.push(chunk);
    }
    requireCondition(total > 0, 'OPERATOR_STDIN_SECRET_MISSING');
    const combined = Buffer.concat(chunks, total);
    try {
      let end = combined.length;
      if (end > 0 && combined[end - 1] === 0x0a) {
        end -= 1;
        if (end > 0 && combined[end - 1] === 0x0d) end -= 1;
      }
      const value = combined.subarray(0, end).toString('utf8');
      requireCondition(
        value.length > 0 && !value.includes('\u0000') && !value.includes('\ufffd'),
        'OPERATOR_STDIN_SECRET_INVALID',
      );
      return parse(value);
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function readRawSecretFromStdin(input = process.stdin) {
  return readSecretTextFromStdin(input, (value) => {
    requireCondition(!/[\r\n]/u.test(value), 'OPERATOR_STDIN_SECRET_INVALID');
    return value;
  });
}

export async function readExactSecretAssignmentsFromStdin(requiredNames, input = process.stdin) {
  requireCondition(
    Array.isArray(requiredNames) &&
      requiredNames.length > 0 &&
      new Set(requiredNames).size === requiredNames.length &&
      requiredNames.every((name) => /^[A-Z][A-Z0-9_]*$/u.test(name)),
    'OPERATOR_STDIN_REQUIRED_NAMES_INVALID',
  );
  return readSecretTextFromStdin(input, (serialized) => {
    const lines = serialized.split(/\r?\n/u);
    requireCondition(lines.length === requiredNames.length, 'OPERATOR_STDIN_ASSIGNMENT_INVALID');
    const selected = Object.create(null);
    for (const [index, name] of requiredNames.entries()) {
      const prefix = `${name}=`;
      const line = lines[index];
      requireCondition(line.startsWith(prefix), 'OPERATOR_STDIN_ASSIGNMENT_INVALID');
      const value = line.slice(prefix.length);
      requireCondition(
        value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value),
        'OPERATOR_STDIN_SECRET_INVALID',
      );
      selected[name] = value;
    }
    return selected;
  });
}

export async function readBoundedJsonResponse(response, { maxBytes = 16 * 1024 } = {}) {
  requireCondition(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1024 * 1024,
    'OPERATOR_RESPONSE_LIMIT_INVALID',
  );
  requireCondition(
    response?.body && typeof response.body.getReader === 'function',
    'OPERATOR_RESPONSE_INVALID',
  );
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      requireCondition(result && typeof result === 'object', 'OPERATOR_RESPONSE_INVALID');
      if (result.done === true) break;
      requireCondition(
        result.done === false && result.value instanceof Uint8Array,
        'OPERATOR_RESPONSE_INVALID',
      );
      total += result.value.byteLength;
      requireCondition(total <= maxBytes, 'OPERATOR_RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(result.value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
    } catch {
      fail('OPERATOR_RESPONSE_INVALID');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock?.();
    for (const chunk of chunks) chunk.fill(0);
  }
}
