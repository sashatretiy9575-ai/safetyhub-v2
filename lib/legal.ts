export type LegalDocumentType = 'privacy' | 'terms';

export const LEGAL_EFFECTIVE_TIME_ZONE = 'Asia/Oral';

export type LegalDocumentVersion = {
  type: LegalDocumentType;
  title: string;
  version: string;
  effectiveDate: string;
  path: '/privacy' | '/terms';
  bodyRevision: string;
};

/**
 * Historical legal copies remain exported and addressable so a person can
 * always reopen exactly the version they accepted. Do not edit these values
 * or the matching rendered components; publish a new version instead.
 */
export const PRIVACY_POLICY_V1_1 = {
  type: 'privacy',
  title: 'Политика конфиденциальности',
  version: '1.1',
  effectiveDate: '2026-08-13',
  path: '/privacy',
  bodyRevision: 'privacy-1.1',
} as const satisfies LegalDocumentVersion;

export const TERMS_POLICY_V2_1 = {
  type: 'terms',
  title: 'Условия использования',
  version: '2.1',
  effectiveDate: '2026-08-13',
  path: '/terms',
  bodyRevision: 'terms-2.1',
} as const satisfies LegalDocumentVersion;

export const PRIVACY_POLICY_V1_2 = {
  type: 'privacy',
  title: 'Политика конфиденциальности',
  version: '1.2',
  effectiveDate: '2026-08-31',
  path: '/privacy',
  bodyRevision: 'privacy-1.2',
} as const satisfies LegalDocumentVersion;

export const TERMS_POLICY_V2_2 = {
  type: 'terms',
  title: 'Условия использования',
  version: '2.2',
  effectiveDate: '2026-08-31',
  path: '/terms',
  bodyRevision: 'terms-2.2',
} as const satisfies LegalDocumentVersion;

export const PRIVACY_POLICY_V1_3 = {
  type: 'privacy',
  title: 'Политика конфиденциальности',
  version: '1.3',
  effectiveDate: '2026-09-01',
  path: '/privacy',
  bodyRevision: 'privacy-1.3',
} as const satisfies LegalDocumentVersion;

export const TERMS_POLICY_V2_3 = {
  type: 'terms',
  title: 'Условия использования',
  version: '2.3',
  effectiveDate: '2026-09-01',
  path: '/terms',
  bodyRevision: 'terms-2.3',
} as const satisfies LegalDocumentVersion;

export const PRIVACY_POLICY = {
  type: 'privacy',
  title: 'Политика конфиденциальности',
  version: '1.4',
  effectiveDate: '2026-09-02',
  path: '/privacy',
  bodyRevision: 'privacy-1.4',
} as const satisfies LegalDocumentVersion;

export const TERMS_POLICY = {
  type: 'terms',
  title: 'Условия использования',
  version: '2.4',
  effectiveDate: '2026-09-02',
  path: '/terms',
  bodyRevision: 'terms-2.4',
} as const satisfies LegalDocumentVersion;

// Accepted versions must remain addressable after a new version becomes current.
// When adding a version, preserve the corresponding rendered copy on its page.
export const LEGAL_DOCUMENT_VERSIONS = {
  privacy: [PRIVACY_POLICY_V1_1, PRIVACY_POLICY_V1_2, PRIVACY_POLICY_V1_3, PRIVACY_POLICY],
  terms: [TERMS_POLICY_V2_1, TERMS_POLICY_V2_2, TERMS_POLICY_V2_3, TERMS_POLICY],
} as const satisfies Record<LegalDocumentType, readonly LegalDocumentVersion[]>;

export function resolveLegalDocumentVersion(
  type: LegalDocumentType,
  requestedVersion?: string,
): LegalDocumentVersion | null {
  const versions = LEGAL_DOCUMENT_VERSIONS[type];
  const current = type === 'privacy' ? PRIVACY_POLICY : TERMS_POLICY;
  if (!requestedVersion) return current;
  return versions.find((document) => document.version === requestedVersion) ?? null;
}

export function legalDocumentHref(type: LegalDocumentType, version: string) {
  const path = type === 'privacy' ? PRIVACY_POLICY.path : TERMS_POLICY.path;
  return `${path}/${encodeURIComponent(version)}#document-version`;
}

export function formatLegalDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: LEGAL_EFFECTIVE_TIME_ZONE,
  }).format(new Date(`${value}T00:00:00+05:00`));
}

/**
 * Legal versions are activated at the beginning of an Asia/Oral calendar day.
 * Compare the database timestamp in that business timezone instead of slicing
 * UTC text, which would otherwise turn a local midnight into the prior date.
 */
export function legalEffectiveDateInAppTimezone(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('LEGAL_EFFECTIVE_DATE_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LEGAL_EFFECTIVE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .map((part) => [part.type, part.value]),
  ) as Record<'year' | 'month' | 'day', string>;
  return `${values.year}-${values.month}-${values.day}`;
}

export const LEGAL_REFERENCE_LINKS = {
  kazakhstanPersonalData: 'https://adilet.zan.kz/rus/docs/Z1300000094',
  supabaseDpa: 'https://supabase.com/legal/customer-resources/data-processing-addendum',
  supabaseRegions: 'https://supabase.com/docs/guides/platform/regions',
  vercelPrivacy: 'https://vercel.com/legal/privacy-notice',
  vercelDpa: 'https://vercel.com/legal/dpa',
  cloudflareTurnstile: 'https://www.cloudflare.com/turnstile-privacy-policy/',
  telegramPrivacy: 'https://telegram.org/privacy',
} as const;
