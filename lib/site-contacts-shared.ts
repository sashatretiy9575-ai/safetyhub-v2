export type SiteContactSettings = Readonly<{
  phoneE164: string;
  phoneDisplay: string;
  whatsappE164: string;
  whatsappSameAsPhone: boolean;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}>;

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

export function normalizePhoneE164(value: string): string | null {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^0-9]/g, '');
  let normalizedDigits = digits;

  if (normalizedDigits.length === 11 && normalizedDigits.startsWith('8')) {
    normalizedDigits = `7${normalizedDigits.slice(1)}`;
  } else if (normalizedDigits.length === 10) {
    normalizedDigits = `7${normalizedDigits}`;
  }

  const normalized = `+${normalizedDigits}`;
  return E164_PATTERN.test(normalized) ? normalized : null;
}

export function formatPhoneDisplay(e164: string): string {
  if (/^\+7[0-9]{10}$/.test(e164)) {
    return `${e164.slice(0, 2)} ${e164.slice(2, 5)} ${e164.slice(5, 8)} ${e164.slice(8)}`;
  }

  const country = e164.slice(0, Math.min(4, Math.max(2, e164.length - 7)));
  return `${country} ${e164.slice(country.length).replace(/(.{3})(?=.)/g, '$1 ')}`.trim();
}

export function coerceSiteContactSettings(value: unknown): SiteContactSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.phoneE164 !== 'string' ||
    typeof row.phoneDisplay !== 'string' ||
    typeof row.whatsappE164 !== 'string' ||
    typeof row.whatsappSameAsPhone !== 'boolean' ||
    typeof row.version !== 'number'
  ) {
    return null;
  }

  return Object.freeze({
    phoneE164: row.phoneE164,
    phoneDisplay: row.phoneDisplay,
    whatsappE164: row.whatsappE164,
    whatsappSameAsPhone: row.whatsappSameAsPhone,
    version: row.version,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null,
    updatedBy: typeof row.updatedBy === 'string' ? row.updatedBy : null,
  });
}

export function contactPhoneHref(settings: SiteContactSettings) {
  return `tel:${settings.phoneE164}`;
}

export function contactWhatsappHref(settings: SiteContactSettings) {
  return `https://wa.me/${settings.whatsappE164.replace(/\D/g, '')}`;
}
