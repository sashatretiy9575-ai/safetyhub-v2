import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

export type AuthEmailLocale = 'ru' | 'kk' | 'en';
export type AuthEmailActionType =
  'signup' | 'magiclink' | 'recovery' | 'invite' | 'email_change' | 'reauthentication' | 'email';

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
/**
 * Supabase generates a 32-byte hook secret. Anything shorter is a hand-written
 * value, and `whsec_=` decodes to an empty HMAC key that would verify a
 * signature anybody can compute. A weak entry is dropped rather than thrown,
 * so one bad element of a rotation pair cannot silence the healthy one; if
 * nothing survives the route answers SEND_EMAIL_HOOK_NOT_CONFIGURED and no
 * unsigned call is ever accepted.
 */
export const MINIMUM_HOOK_SECRET_BYTES = 32;

export function parseHookSecrets(configured: string | undefined) {
  return (configured ?? '')
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^v1,whsec_(?<key>[A-Za-z0-9+/=]+)$/u);
      if (!match?.groups?.key) throw new Error('SEND_EMAIL_HOOK_SECRET_INVALID');
      return Buffer.from(match.groups.key, 'base64');
    })
    .filter((secret) => secret.byteLength >= MINIMUM_HOOK_SECRET_BYTES);
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
      (candidate) => candidate.length === expected.length && timingSafeEqual(expected, candidate),
    );
  });
}

function isAuthEmailLocale(value: unknown): value is AuthEmailLocale {
  return value === 'ru' || value === 'kk' || value === 'en';
}

/**
 * The language of the sign-in page the person is looking at right now. The
 * request route puts it into `redirect_to` as `?email_locale=` (and the path
 * prefix says the same), so it wins over `user_metadata.locale`, which Auth
 * froze at the very first sign-in and which the profile never updates.
 */
export function detectLocale(userMetadata: unknown, redirectTo: unknown): AuthEmailLocale {
  if (typeof redirectTo === 'string') {
    try {
      const url = new URL(redirectTo);
      const requested = url.searchParams.get('email_locale');
      if (isAuthEmailLocale(requested)) return requested;
      if (url.pathname.startsWith('/en/')) return 'en';
      if (url.pathname.startsWith('/kk/')) return 'kk';
    } catch {
      // A malformed redirect never changes the default locale.
    }
  }
  const metadataLocale = record(userMetadata)?.locale;
  if (metadataLocale === 'en' || metadataLocale === 'kk') return metadataLocale;
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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function page(lang: AuthEmailLocale, title: string, preheader: string, body: string) {
  return [
    '<!doctype html>',
    `<html lang="${lang}">`,
    '  <head>',
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${escapeHtml(title)}</title>`,
    '  </head>',
    '  <body style="margin:0;background:#f4f7f5;color:#173d2b;font-family:Arial,sans-serif">',
    // Mail clients show this line next to the subject; it stays invisible in the body.
    `    <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f4f7f5">${escapeHtml(preheader)}</div>`,
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

/**
 * Sign-in and sign-up codes. Mirrors supabase/templates/{magic-link,confirmation}.html
 * and the subjects in supabase/config.toml; keep all three in step.
 */
const CODE_COPY: Record<
  AuthEmailLocale,
  Readonly<{
    loginSubject: string;
    signupSubject: string;
    preheader: string;
    loginHeading: string;
    signupHeading: string;
    loginLead: string;
    signupLead: string;
    validity: string;
    ignore: string;
  }>
> = {
  en: {
    loginSubject: 'SafetyHub: your sign-in code',
    signupSubject: 'SafetyHub: your sign-up code',
    preheader: 'Valid for 1 hour.',
    loginHeading: 'Your sign-in code',
    signupHeading: 'Welcome to SafetyHub',
    loginLead: 'Enter this code in SafetyHub to sign in:',
    signupLead: 'Enter this code in SafetyHub to finish signing up:',
    validity:
      'The code works for 1 hour and only once. Don’t share it — SafetyHub staff will never ask for it.',
    ignore: 'If you didn’t request a code, just delete this email — nothing will happen.',
  },
  kk: {
    loginSubject: 'SafetyHub: кіру коды',
    signupSubject: 'SafetyHub: тіркелу коды',
    preheader: 'Код 1 сағат жарамды.',
    loginHeading: 'Кіру кодыңыз',
    signupHeading: 'SafetyHub-қа қош келдіңіз',
    loginLead: 'SafetyHub-қа кіру үшін осы кодты енгізіңіз:',
    signupLead: 'Тіркелуді аяқтау үшін осы кодты SafetyHub-та енгізіңіз:',
    validity:
      'Код 1 сағат жарамды және бір рет қана қолданылады. Оны ешкімге айтпаңыз — SafetyHub қызметкерлері кодты сұрамайды.',
    ignore: 'Егер кодты сұратпаған болсаңыз, бұл хатты жай ғана өшіріңіз — ештеңе болмайды.',
  },
  ru: {
    loginSubject: 'SafetyHub: код для входа',
    signupSubject: 'SafetyHub: код для регистрации',
    preheader: 'Код действует 1 час.',
    loginHeading: 'Ваш код для входа',
    signupHeading: 'Добро пожаловать в SafetyHub',
    loginLead: 'Введите этот код в SafetyHub, чтобы войти:',
    signupLead: 'Введите этот код в SafetyHub, чтобы завершить регистрацию:',
    validity:
      'Код действует 1 час и подходит только один раз. Никому его не сообщайте — сотрудники SafetyHub его не спрашивают.',
    ignore: 'Если вы не запрашивали код, просто удалите это письмо — ничего не произойдёт.',
  },
};

/**
 * The retirement notices, in the recipient's language. The wording
 * deliberately says the mail carries no link and no code: that is what makes
 * a phishing copy of it stand out, so keep it in every translation, and keep
 * supabase/templates/{recovery,invite}.html in step with what is written here.
 */
const NOTICE_COPY: Record<
  AuthEmailLocale,
  Readonly<{
    preheader: string;
    recoverySubject: string;
    recoveryLead: string;
    inviteSubject: string;
    inviteLead: string;
    hint: string;
  }>
> = {
  en: {
    preheader: 'No link and no code inside.',
    recoverySubject: 'SafetyHub signs you in without a password',
    recoveryLead: 'SafetyHub has no passwords, so there is nothing to reset or set up.',
    inviteSubject: 'SafetyHub does not send invitations',
    inviteLead: 'SafetyHub has no invitations, passwords or password-setup links.',
    hint: 'To sign in, open SafetyHub and request a one-time code for your email. This message has no link and no code: a similar email with a link is a fake.',
  },
  kk: {
    preheader: 'Хатта сілтеме де, код та жоқ.',
    recoverySubject: 'SafetyHub-қа кіру құпиясөзсіз',
    recoveryLead:
      'SafetyHub-та құпиясөз жоқ, сондықтан оны қалпына келтірудің де, орнатудың да қажеті жоқ.',
    inviteSubject: 'SafetyHub-та шақырулар қолданылмайды',
    inviteLead: 'SafetyHub-та шақырулар, құпиясөздер және оларды орнату сілтемелері жоқ.',
    hint: 'Кіру үшін SafetyHub-ты ашып, поштаңызға бір реттік код сұратыңыз. Бұл хатта сілтеме де, код та жоқ: сілтемесі бар ұқсас хат келсе, ол жалған.',
  },
  ru: {
    preheader: 'В письме нет ни ссылки, ни кода.',
    recoverySubject: 'В SafetyHub вход без пароля',
    recoveryLead:
      'Пароль в SafetyHub не используется, поэтому восстанавливать или задавать его не нужно.',
    inviteSubject: 'Приглашения в SafetyHub не используются',
    inviteLead: 'В SafetyHub нет приглашений, паролей и ссылок для их установки.',
    hint: 'Чтобы войти, откройте SafetyHub и запросите одноразовый код на свою почту. В этом письме нет ни ссылки, ни кода — если вам пришло похожее письмо со ссылкой, это подделка.',
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
  const notice = NOTICE_COPY[payload.locale];
  switch (payload.actionType) {
    case 'magiclink':
      return {
        subject: copy.loginSubject,
        html: page(
          payload.locale,
          copy.loginSubject,
          copy.preheader,
          codeCard(copy.loginHeading, copy.loginLead, payload.token, copy.validity, copy.ignore),
        ),
      };
    case 'signup':
      return {
        subject: copy.signupSubject,
        html: page(
          payload.locale,
          copy.signupSubject,
          copy.preheader,
          codeCard(copy.signupHeading, copy.signupLead, payload.token, copy.validity, copy.ignore),
        ),
      };
    case 'recovery':
      return {
        subject: notice.recoverySubject,
        html: page(
          payload.locale,
          notice.recoverySubject,
          notice.preheader,
          noticeCard(notice.recoverySubject, notice.recoveryLead, notice.hint),
        ),
      };
    case 'invite':
      return {
        subject: notice.inviteSubject,
        html: page(
          payload.locale,
          notice.inviteSubject,
          notice.preheader,
          noticeCard(notice.inviteSubject, notice.inviteLead, notice.hint),
        ),
      };
    default:
      return null;
  }
}
