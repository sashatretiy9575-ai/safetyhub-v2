import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

export type AuthEmailLocale = 'ru' | 'kk' | 'en';
export type AuthEmailActionType =
  | 'signup'
  | 'magiclink'
  | 'recovery'
  | 'invite'
  | 'email_change'
  | 'reauthentication'
  | 'email';

export type SendEmailHookPayload = Readonly<{
  email: string;
  actionType: AuthEmailActionType;
  token: string;
  locale: AuthEmailLocale;
}>;

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const TOKEN_PATTERN = /^\d{6,10}$/u;
const ACTION_TYPES: ReadonlySet<string> = new Set([
  'signup',
  'magiclink',
  'recovery',
  'invite',
  'email_change',
  'reauthentication',
  'email',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Supabase Auth signs HTTP hooks with the Standard Webhooks scheme: the
 * secret is `v1,whsec_<base64>` (several may be joined with `|`) and the
 * `webhook-signature` header carries space-separated `v1,<base64 hmac>`
 * entries computed over `${id}.${timestamp}.${body}`.
 */
export function parseHookSecrets(configured: string | undefined) {
  return (configured ?? '')
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^v1,whsec_(?<key>[A-Za-z0-9+/=]+)$/u);
      if (!match?.groups?.key) throw new Error('SEND_EMAIL_HOOK_SECRET_INVALID');
      return Buffer.from(match.groups.key, 'base64');
    });
}

export function verifyStandardWebhook({
  secrets,
  id,
  timestamp,
  signature,
  body,
  now = Date.now(),
}: Readonly<{
  secrets: readonly Buffer[];
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
}>) {
  if (secrets.length === 0 || !id || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/u.test(timestamp)) return false;
  const skew = Math.abs(now / 1000 - Number(timestamp));
  if (skew > SIGNATURE_TOLERANCE_SECONDS) return false;

  const presented = signature
    .split(' ')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => Buffer.from(entry.slice(3), 'base64'));
  if (presented.length === 0) return false;

  const signedContent = `${id}.${timestamp}.${body}`;
  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(signedContent).digest();
    return presented.some(
      (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );
  });
}

function detectLocale(userMetadata: unknown, redirectTo: unknown): AuthEmailLocale {
  const metadataLocale = record(userMetadata)?.locale;
  if (metadataLocale === 'en' || metadataLocale === 'kk') return metadataLocale;
  if (typeof redirectTo === 'string') {
    try {
      const pathname = new URL(redirectTo).pathname;
      if (pathname.startsWith('/en/')) return 'en';
      if (pathname.startsWith('/kk/')) return 'kk';
    } catch {
      // A malformed redirect never changes the default locale.
    }
  }
  return 'ru';
}

export function parseSendEmailHookPayload(payload: unknown): SendEmailHookPayload {
  const root = record(payload);
  const user = record(root?.user);
  const emailData = record(root?.email_data);
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
  const actionType = emailData?.email_action_type;
  const token = typeof emailData?.token === 'string' ? emailData.token : '';
  if (!email || !email.includes('@') || email.length > 320) {
    throw new Error('SEND_EMAIL_HOOK_EMAIL_INVALID');
  }
  if (typeof actionType !== 'string' || !ACTION_TYPES.has(actionType)) {
    throw new Error('SEND_EMAIL_HOOK_ACTION_INVALID');
  }
  if ((actionType === 'signup' || actionType === 'magiclink') && !TOKEN_PATTERN.test(token)) {
    throw new Error('SEND_EMAIL_HOOK_TOKEN_INVALID');
  }
  return {
    email,
    actionType: actionType as AuthEmailActionType,
    token,
    locale: detectLocale(user?.user_metadata, emailData?.redirect_to),
  };
}

const CARD_OPEN =
  '<div style="max-width:520px;margin:0 auto;padding:32px 20px"><div style="border-radius:20px;background:#ffffff;padding:32px;box-shadow:0 8px 30px rgba(23,61,43,.08)">';
const CARD_CLOSE = '</div></div>';

function page(lang: AuthEmailLocale, body: string) {
  return [
    '<!doctype html>',
    `<html lang="${lang}">`,
    '  <body style="margin:0;background:#f4f7f5;color:#173d2b;font-family:Arial,sans-serif">',
    `    ${CARD_OPEN}`,
    body,
    `    ${CARD_CLOSE}`,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

function codeCard(heading: string, lead: string, token: string, validity: string, ignore: string) {
  return [
    `      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${heading}</h1>`,
    `      <p style="margin:0 0 20px;font-size:16px;line-height:1.6">${lead}</p>`,
    `      <div style="margin:0 0 20px;border-radius:14px;background:#e7f5ed;padding:18px;text-align:center;font-family:Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:8px">${token}</div>`,
    `      <p style="margin:0 0 12px;font-size:14px;line-height:1.6">${validity}</p>`,
    `      <p style="margin:0;font-size:14px;line-height:1.6;color:#5f7168">${ignore}</p>`,
  ].join('\n');
}

const CODE_COPY: Record<
  AuthEmailLocale,
  Readonly<{
    loginHeading: string;
    signupHeading: string;
    lead: string;
    validity: string;
    loginIgnore: string;
    signupIgnore: string;
  }>
> = {
  en: {
    loginHeading: 'Your SafetyHub code',
    signupHeading: 'Create your SafetyHub account',
    lead: 'Enter this one-time code in SafetyHub:',
    validity: 'The code is valid for one hour and can only be used once. Do not share it.',
    loginIgnore: 'If you did not request this code, ignore this email.',
    signupIgnore: 'If you are not creating an account, ignore this email.',
  },
  kk: {
    loginHeading: 'SafetyHub кодыңыз',
    signupHeading: 'SafetyHub аккаунтын жасау',
    lead: 'Осы бір реттік кодты SafetyHub-та енгізіңіз:',
    validity: 'Код бір сағат жарамды және бір рет қана қолданылады. Оны ешкімге айтпаңыз.',
    loginIgnore: 'Егер кодты сұратпаған болсаңыз, бұл хатты елемеңіз.',
    signupIgnore: 'Егер аккаунт жасамасаңыз, бұл хатты елемеңіз.',
  },
  ru: {
    loginHeading: 'Код SafetyHub',
    signupHeading: 'Создание аккаунта SafetyHub',
    lead: 'Введите этот одноразовый код в SafetyHub:',
    validity: 'Код действует один час и используется только один раз. Никому его не сообщайте.',
    loginIgnore: 'Если вы не запрашивали код, просто проигнорируйте это письмо.',
    signupIgnore: 'Если вы не создаёте аккаунт, просто проигнорируйте это письмо.',
  },
};

function noticeCard(heading: string, lead: string, hint: string) {
  return [
    `      <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25">${heading}</h1>`,
    `      <p style="margin:0 0 12px;font-size:16px;line-height:1.6">${lead}</p>`,
    `      <p style="margin:0;font-size:14px;line-height:1.6;color:#5f7168">${hint}</p>`,
  ].join('\n');
}

/**
 * Mirrors `supabase/templates/*.html`: signup and magic-link carry the code,
 * recovery and invite are static retirement notices without token or link.
 * Returns null for action types SafetyHub never emails.
 */
export function renderAuthEmail(
  payload: Pick<SendEmailHookPayload, 'actionType' | 'token' | 'locale'>,
): Readonly<{ subject: string; html: string }> | null {
  const copy = CODE_COPY[payload.locale];
  switch (payload.actionType) {
    case 'magiclink':
      return {
        subject: 'SafetyHub',
        html: page(
          payload.locale,
          codeCard(copy.loginHeading, copy.lead, payload.token, copy.validity, copy.loginIgnore),
        ),
      };
    case 'signup':
      return {
        subject: 'SafetyHub',
        html: page(
          payload.locale,
          codeCard(copy.signupHeading, copy.lead, payload.token, copy.validity, copy.signupIgnore),
        ),
      };
    case 'recovery':
      return {
        subject: 'Пароль в SafetyHub не используется',
        html: page(
          'ru',
          noticeCard(
            'Пароль в SafetyHub не используется',
            'В SafetyHub нет восстановления или установки пароля.',
            'Чтобы войти, откройте SafetyHub и запросите одноразовый код на ваш email. Это письмо не содержит ссылки или кода для входа.',
          ),
        ),
      };
    case 'invite':
      return {
        subject: 'Приглашения с паролем в SafetyHub отключены',
        html: page(
          'ru',
          noticeCard(
            'Приглашения с паролем отключены',
            'В SafetyHub не используются приглашения, пароли и ссылки для установки пароля.',
            'Для доступа создайте аккаунт или запросите одноразовый код входа на странице SafetyHub. Это письмо не содержит ссылки или кода для входа.',
          ),
        ),
      };
    default:
      return null;
  }
}
