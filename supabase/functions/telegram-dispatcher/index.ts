/* eslint-disable */
// @ts-nocheck

import { createClient } from 'npm:@supabase/supabase-js@2.111.0';

const CLAIM_LIMIT = 12;
const CLAIM_LEASE_SECONDS = 45;
const SEND_CONCURRENCY = 3;
const TELEGRAM_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 16_384;
const MAX_BEARER_BYTES = 512;
const NO_STORE_HEADERS = { 'cache-control': 'no-store' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BOT_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,80}$/u;
const PRIVATE_CHAT_ID_PATTERN = /^-?\d{6,20}$/u;
const MACHINE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/u;
const PHONE_COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const PHONE_E164_PATTERN = /^\+[1-9][0-9]{1,14}$/u;
const ALLOWED_EVENT_TYPES = new Set([
  'account.approval_requested',
  'course.completed',
  'system.alert',
]);

class DispatcherError extends Error {
  category: string;
  retryAfterSeconds: number | null;

  constructor(category: string, retryAfterSeconds: number | null = null) {
    super(category);
    this.name = 'DispatcherError';
    this.category = category;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function fail(category: string, retryAfterSeconds: number | null = null): never {
  throw new DispatcherError(category, retryAfterSeconds);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], category: string) {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) fail(category);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.join('\0') === expected.join('\0');
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) fail(`MISSING_${name}`);
  return value;
}

function requiredUuid(value: unknown, category = 'NOTIFICATION_PAYLOAD_INVALID') {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) fail(category);
  return value.toLowerCase();
}

function requiredTimestamp(value: unknown, category = 'NOTIFICATION_PAYLOAD_INVALID') {
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) {
    fail(category);
  }
  return value;
}

function requiredText(
  value: unknown,
  maxLength: number,
  category = 'NOTIFICATION_PAYLOAD_INVALID',
) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail(category);
  }
  const normalized = value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  if (!normalized) fail(category);
  return normalized;
}

function requiredAdminPath(value: unknown) {
  const path = requiredText(value, 240);
  if (!/^\/admin(?:\/|$)/u.test(path) || path.includes('\\')) {
    fail('NOTIFICATION_PAYLOAD_INVALID');
  }
  return path;
}

function requiredLocale(value: unknown) {
  if (value !== 'ru' && value !== 'kk' && value !== 'en' && value !== 'zh') {
    fail('NOTIFICATION_PAYLOAD_INVALID');
  }
  return value;
}

function requiredInteger(value: unknown, min: number, max: number) {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    fail('NOTIFICATION_PAYLOAD_INVALID');
  }
  return Number(value);
}

function requiredPhoneCountry(value: unknown) {
  if (typeof value !== 'string' || !PHONE_COUNTRY_PATTERN.test(value)) {
    fail('NOTIFICATION_PAYLOAD_INVALID');
  }
  return value;
}

function requiredPhoneE164(value: unknown) {
  if (typeof value !== 'string' || !PHONE_E164_PATTERN.test(value)) {
    fail('NOTIFICATION_PAYLOAD_INVALID');
  }
  return value;
}

function parsePayload(eventType: unknown, value: unknown) {
  if (!isRecord(value)) fail('NOTIFICATION_PAYLOAD_INVALID');
  if (eventType === 'account.approval_requested') {
    if (hasExactKeys(value, ['schemaVersion', 'locale', 'requestedAt', 'adminPath'])) {
      if (value.schemaVersion !== 2) fail('NOTIFICATION_PAYLOAD_INVALID');
      return {
        approvalKind: 'generic_v2' as const,
        schemaVersion: 2 as const,
        locale: requiredLocale(value.locale),
        requestedAt: requiredTimestamp(value.requestedAt),
        adminPath: requiredAdminPath(value.adminPath),
      };
    }

    const hasApplicationDetails = Object.hasOwn(value, 'job');
    if (hasApplicationDetails) {
      exactKeys(
        value,
        ['name', 'surname', 'job', 'organization', 'phoneCountryIso2', 'phoneE164'],
        'NOTIFICATION_PAYLOAD_INVALID',
      );
      return {
        approvalKind: 'legacy_full' as const,
        name: requiredText(value.name, 120),
        surname: requiredText(value.surname, 120),
        job: requiredText(value.job, 160),
        organization: requiredText(value.organization, 160),
        phoneCountryIso2: requiredPhoneCountry(value.phoneCountryIso2),
        phoneE164: requiredPhoneE164(value.phoneE164),
      };
    }

    exactKeys(
      value,
      ['name', 'surname', 'locale', 'requestedAt', 'adminPath'],
      'NOTIFICATION_PAYLOAD_INVALID',
    );
    const locale = requiredLocale(value.locale);
    const requestedAt = requiredTimestamp(value.requestedAt);
    const adminPath = requiredAdminPath(value.adminPath);
    if (value.name === '' && value.surname === '' && locale === 'zh') {
      return {
        approvalKind: 'legacy_blank_zh' as const,
        locale,
        requestedAt,
        adminPath,
      };
    }
    return {
      approvalKind: 'legacy_generic' as const,
      name: requiredText(value.name, 120),
      surname: requiredText(value.surname, 120),
      locale,
      requestedAt,
      adminPath,
    };
  }
  if (eventType === 'course.completed') {
    exactKeys(
      value,
      [
        'attemptId',
        'userId',
        'name',
        'surname',
        'locale',
        'courseTitle',
        'result',
        'score',
        'total',
        'completedAt',
        'adminPath',
      ],
      'NOTIFICATION_PAYLOAD_INVALID',
    );
    const score = requiredInteger(value.score, 0, 1000);
    const total = requiredInteger(value.total, 1, 1000);
    if (score > total || (value.result !== 'passed' && value.result !== 'failed')) {
      fail('NOTIFICATION_PAYLOAD_INVALID');
    }
    return {
      attemptId: requiredUuid(value.attemptId),
      userId: requiredUuid(value.userId),
      name: requiredText(value.name, 120),
      surname: requiredText(value.surname, 120),
      locale: requiredLocale(value.locale),
      courseTitle: requiredText(value.courseTitle, 240),
      result: value.result,
      score,
      total,
      completedAt: requiredTimestamp(value.completedAt),
      adminPath: requiredAdminPath(value.adminPath),
    };
  }
  if (eventType === 'system.alert') {
    exactKeys(value, ['machineCode', 'correlationId', 'adminPath'], 'NOTIFICATION_PAYLOAD_INVALID');
    const machineCode = requiredText(value.machineCode, 80);
    if (!MACHINE_CODE_PATTERN.test(machineCode)) fail('NOTIFICATION_PAYLOAD_INVALID');
    return {
      machineCode,
      correlationId: requiredUuid(value.correlationId),
      adminPath: requiredAdminPath(value.adminPath),
    };
  }
  fail('NOTIFICATION_EVENT_TYPE_INVALID');
}

function parseClaim(value: unknown) {
  if (!isRecord(value)) fail('NOTIFICATION_CLAIM_INVALID');
  exactKeys(value, ['items'], 'NOTIFICATION_CLAIM_INVALID');
  if (!Array.isArray(value.items) || value.items.length > CLAIM_LIMIT) {
    fail('NOTIFICATION_CLAIM_INVALID');
  }
  return value.items;
}

// This first pass validates the lease tuple without looking at the event
// payload. A malformed payload can therefore be failed for its own delivery
// rather than aborting every other row claimed in the same batch.
function parseLeaseClaim(value: unknown) {
  if (!isRecord(value)) fail('NOTIFICATION_CLAIM_INVALID');
  return {
    deliveryId: requiredUuid(value.deliveryId, 'NOTIFICATION_CLAIM_INVALID'),
    leaseToken: requiredUuid(value.leaseToken, 'NOTIFICATION_CLAIM_INVALID'),
    raw: value,
  };
}

function parseDeliveryClaim(lease: ReturnType<typeof parseLeaseClaim>) {
  const value = lease.raw;
  exactKeys(
    value,
    [
      'deliveryId',
      'leaseToken',
      'attempt',
      'eventId',
      'eventType',
      'correlationId',
      'occurredAt',
      'payload',
    ],
    'NOTIFICATION_CLAIM_INVALID',
  );
  if (typeof value.eventType !== 'string' || !ALLOWED_EVENT_TYPES.has(value.eventType)) {
    fail('NOTIFICATION_EVENT_TYPE_INVALID');
  }
  const correlationId = requiredUuid(value.correlationId, 'NOTIFICATION_CLAIM_INVALID');
  const payload = parsePayload(value.eventType, value.payload);
  if (value.eventType === 'system.alert' && payload.correlationId !== correlationId) {
    fail('NOTIFICATION_PAYLOAD_INVALID');
  }
  return {
    ...lease,
    attempt: requiredInteger(value.attempt, 1, 10),
    eventId: requiredUuid(value.eventId, 'NOTIFICATION_CLAIM_INVALID'),
    eventType: value.eventType,
    correlationId,
    occurredAt: requiredTimestamp(value.occurredAt, 'NOTIFICATION_CLAIM_INVALID'),
    payload,
  };
}

function parseSiteOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('SAFETYHUB_SITE_URL_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    fail('SAFETYHUB_SITE_URL_INVALID');
  }
  return url.origin;
}

function messageTime(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Oral',
  }).format(new Date(value));
}

function localeLabel(value: string) {
  return ({ ru: 'RU', kk: 'KK', en: 'EN', zh: 'ZH' } as const)[value];
}

function eventMessage(claim: ReturnType<typeof parseDeliveryClaim>, siteOrigin: string) {
  const payload = claim.payload;
  if (claim.eventType === 'account.approval_requested') {
    if (payload.approvalKind === 'legacy_full') {
      return [
        '🔔 Новая заявка на обучение',
        `Имя: ${payload.name}`,
        `Фамилия: ${payload.surname}`,
        `Должность: ${payload.job}`,
        `Организация: ${payload.organization}`,
        `Страна: ${payload.phoneCountryIso2}`,
        `Контактный телефон: ${payload.phoneE164}`,
      ].join('\n');
    }
    const deepLink = new URL(payload.adminPath, siteOrigin).toString();
    if (payload.approvalKind === 'generic_v2' || payload.approvalKind === 'legacy_blank_zh') {
      return [
        '🔔 Новая заявка на обучение',
        '',
        `🌐 Язык: ${localeLabel(payload.locale)}`,
        `🕒 Время: ${messageTime(payload.requestedAt)}`,
        '',
        `🔗 Открыть в админ-панели:`,
        deepLink,
      ].join('\n');
    }
    return [
      '🔔 Новая заявка на обучение',
      '',
      `👤 Участник: ${payload.surname} ${payload.name}`,
      `🌐 Язык: ${localeLabel(payload.locale)}`,
      `🕒 Время: ${messageTime(payload.requestedAt)}`,
      '',
      `🔗 Открыть в админ-панели:`,
      deepLink,
    ].join('\n');
  }
  if (!('adminPath' in payload)) fail('NOTIFICATION_PAYLOAD_INVALID');
  const deepLink = new URL(payload.adminPath, siteOrigin).toString();
  if (claim.eventType === 'course.completed') {
    return [
      payload.result === 'passed' ? '✅ Курс пройден' : '❌ Курс не пройден',
      '',
      `👤 Участник: ${payload.surname} ${payload.name}`,
      `📚 Курс: ${payload.courseTitle}`,
      `📊 Результат: ${payload.result === 'passed' ? 'сдан' : 'не сдан'} (${payload.score}/${payload.total})`,
      `🕒 Время: ${messageTime(payload.completedAt)}`,
      '',
      `🔗 Результат в админ-панели:`,
      deepLink,
    ].join('\n');
  }
  return [
    '⚠️ Системное уведомление',
    '',
    `🏷️ Код: ${payload.machineCode}`,
    `🕒 Время: ${messageTime(claim.occurredAt)}`,
    `🔍 Корреляция: ${payload.correlationId}`,
    '',
    `🔗 Подробности:`,
    deepLink,
  ].join('\n');
}

function utf8Length(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function constantTimeEqual(left: string, right: string) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function bearerToken(request: Request) {
  const match = /^Bearer ([^\s,]+)$/u.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? '';
}

async function readBoundedJson(response: Response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail('TELEGRAM_RESPONSE_INVALID');
  if (!response.body) fail('TELEGRAM_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail('TELEGRAM_RESPONSE_INVALID');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail('TELEGRAM_RESPONSE_INVALID');
  }
}

async function sendTelegramMessage(botToken: string, chatId: string, text: string) {
  if (text.length < 1 || text.length > 4096) fail('TELEGRAM_MESSAGE_INVALID');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        protect_content: true,
      }),
      signal: controller.signal,
    });
    body = await readBoundedJson(response);
  } catch (error) {
    if (error instanceof DispatcherError) throw error;
    if (controller.signal.aborted) fail('TELEGRAM_TIMEOUT');
    fail('TELEGRAM_NETWORK');
  } finally {
    clearTimeout(timeout);
  }

  if (
    response.ok &&
    isRecord(body) &&
    body.ok === true &&
    isRecord(body.result) &&
    Number.isInteger(body.result.message_id)
  ) {
    return String(body.result.message_id);
  }

  const retryAfter =
    isRecord(body) &&
    isRecord(body.parameters) &&
    Number.isInteger(body.parameters.retry_after) &&
    Number(body.parameters.retry_after) >= 1 &&
    Number(body.parameters.retry_after) <= 86_400
      ? Number(body.parameters.retry_after)
      : null;
  if (response.status === 429) fail('TELEGRAM_RATE_LIMITED', retryAfter ?? 60);
  if (response.status === 401 || response.status === 403) fail('TELEGRAM_AUTH_REJECTED');
  if (response.status >= 400 && response.status < 500) fail('TELEGRAM_REQUEST_REJECTED');
  if (response.status >= 500) fail('TELEGRAM_UNAVAILABLE');
  fail('TELEGRAM_RESPONSE_INVALID');
}

async function rpc(client: ReturnType<typeof createClient>, name: string, args: object) {
  const { data, error } = await client.rpc(name, args);
  if (error) fail('NOTIFICATION_RPC_FAILED');
  return data;
}

function failure(error: unknown) {
  if (error instanceof DispatcherError) return error;
  return new DispatcherError('NOTIFICATION_DISPATCH_FAILED');
}

async function processDelivery(
  client: ReturnType<typeof createClient>,
  lease: ReturnType<typeof parseLeaseClaim>,
  botToken: string,
  chatId: string,
  siteOrigin: string,
) {
  try {
    const claim = parseDeliveryClaim(lease);
    const remoteMessageId = await sendTelegramMessage(
      botToken,
      chatId,
      eventMessage(claim, siteOrigin),
    );
    const completed = await rpc(client, 'complete_notification_delivery', {
      p_delivery_id: claim.deliveryId,
      p_lease_token: claim.leaseToken,
      p_remote_message_id: remoteMessageId,
    });
    if (completed !== true) fail('NOTIFICATION_COMPLETION_REJECTED');
    return 'completed' as const;
  } catch (error) {
    const safe = failure(error);
    try {
      await rpc(client, 'fail_notification_delivery', {
        p_delivery_id: lease.deliveryId,
        p_lease_token: lease.leaseToken,
        p_error_category: safe.category,
        p_retry_after_seconds: safe.retryAfterSeconds,
      });
    } catch {
      console.error('TELEGRAM_DISPATCH_STATE_FAILED', { category: safe.category });
    }
    return 'failed' as const;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { ...NO_STORE_HEADERS, allow: 'POST' },
    });
  }

  try {
    const dispatcherSecret = requiredEnv('TELEGRAM_DISPATCHER_SECRET');
    if (
      utf8Length(dispatcherSecret) < 32 ||
      utf8Length(dispatcherSecret) > MAX_BEARER_BYTES ||
      dispatcherSecret === 'replace-with-at-least-32-random-characters'
    ) {
      fail('TELEGRAM_DISPATCHER_SECRET_INVALID');
    }
    const token = bearerToken(request);
    if (
      utf8Length(token) > MAX_BEARER_BYTES ||
      !(await constantTimeEqual(token, dispatcherSecret))
    ) {
      return new Response('Forbidden', { status: 403, headers: NO_STORE_HEADERS });
    }

    const botToken = requiredEnv('TELEGRAM_BOT_TOKEN');
    const chatId =
      Deno.env.get('TELEGRAM_CHAT_ID')?.trim() ||
      Deno.env.get('TELEGRAM_ADMIN_CHAT_ID')?.trim() ||
      requiredEnv('TELEGRAM_CHAT_ID');
    if (!BOT_TOKEN_PATTERN.test(botToken)) fail('TELEGRAM_BOT_TOKEN_INVALID');
    if (!PRIVATE_CHAT_ID_PATTERN.test(chatId)) fail('TELEGRAM_CHAT_ID_INVALID');
    const siteOrigin = parseSiteOrigin(requiredEnv('SAFETYHUB_SITE_URL'));
    const client = createClient(
      requiredEnv('SUPABASE_URL'),
      requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const workerId = crypto.randomUUID();
    const claimedItems = parseClaim(
      await rpc(client, 'claim_notification_deliveries', {
        p_worker_id: workerId,
        p_limit: CLAIM_LIMIT,
        p_lease_seconds: CLAIM_LEASE_SECONDS,
      }),
    );
    const claims: ReturnType<typeof parseLeaseClaim>[] = [];
    let invalidLeaseClaims = 0;
    for (const item of claimedItems) {
      try {
        claims.push(parseLeaseClaim(item));
      } catch {
        // Without a valid delivery ID and lease token the worker cannot safely
        // transition this one row. Do not let it suppress other valid rows;
        // the bounded lease will expire and remain visible for investigation.
        invalidLeaseClaims += 1;
        console.error('TELEGRAM_CLAIM_ITEM_INVALID');
      }
    }

    let cursor = 0;
    const results: string[] = [];
    const workers = Array.from({ length: Math.min(SEND_CONCURRENCY, claims.length) }, async () => {
      while (cursor < claims.length) {
        const claim = claims[cursor];
        cursor += 1;
        if (!claim) break;
        results.push(await processDelivery(client, claim, botToken, chatId, siteOrigin));
      }
    });
    await Promise.all(workers);
    await rpc(client, 'prune_notification_data', { p_limit: 500 }).catch(() => undefined);

    return Response.json(
      {
        ok: true,
        claimed: claimedItems.length,
        leaseValid: claims.length,
        invalidLeaseClaims,
        completed: results.filter((result) => result === 'completed').length,
        failed: results.filter((result) => result === 'failed').length,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('TELEGRAM_DISPATCH_FAILED', {
      category: failure(error).category,
    });
    return Response.json(
      { error: 'TELEGRAM_DISPATCH_FAILED' },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
});
