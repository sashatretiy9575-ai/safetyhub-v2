export type LegalDocumentType = 'privacy' | 'terms';

export type LegalDocumentVersion = {
  type: LegalDocumentType;
  title: string;
  version: string;
  effectiveDate: string;
  path: '/privacy' | '/terms';
  bodyRevision: string;
};

export const PRIVACY_POLICY = {
  type: 'privacy',
  title: 'Политика конфиденциальности',
  version: '1.1',
  effectiveDate: '2026-08-13',
  path: '/privacy',
  bodyRevision: 'privacy-1.1',
} as const satisfies LegalDocumentVersion;

export const TERMS_POLICY = {
  type: 'terms',
  title: 'Условия использования',
  version: '2.1',
  effectiveDate: '2026-08-13',
  path: '/terms',
  bodyRevision: 'terms-2.1',
} as const satisfies LegalDocumentVersion;

// Accepted versions must remain addressable after a new version becomes current.
// When adding a version, preserve the corresponding rendered copy on its page.
export const LEGAL_DOCUMENT_VERSIONS = {
  privacy: [PRIVACY_POLICY],
  terms: [TERMS_POLICY],
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
  return `${path}?version=${encodeURIComponent(version)}#document-version`;
}

export function formatLegalDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

export const LEGAL_REFERENCE_LINKS = {
  kazakhstanPersonalData: 'https://adilet.zan.kz/rus/docs/Z1300000094',
  supabaseDpa: 'https://supabase.com/legal/customer-resources/data-processing-addendum',
  supabaseRegions: 'https://supabase.com/docs/guides/platform/regions',
  vercelPrivacy: 'https://vercel.com/legal/privacy-notice',
  vercelDpa: 'https://vercel.com/legal/dpa',
  cloudflareTurnstile: 'https://www.cloudflare.com/turnstile-privacy-policy/',
} as const;
