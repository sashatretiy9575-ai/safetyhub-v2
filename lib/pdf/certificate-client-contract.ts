export const CERTIFICATE_CLIENT_SCHEMA_VERSION = 1 as const;
export const CERTIFICATE_EXPORT_MAX_ITEMS = 500;
export const CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS = 100;
export const CERTIFICATE_RENDER_CONCURRENCY = 2;

export const CERTIFICATE_LOCALES = ['ru', 'kk', 'en', 'zh'] as const;
export type CertificateLocale = (typeof CERTIFICATE_LOCALES)[number];

export type CertificateRenderMetadata = Readonly<{
  schemaVersion: typeof CERTIFICATE_CLIENT_SCHEMA_VERSION;
  certificateId: string;
  filename: string;
  locale: CertificateLocale;
  templateVersion: number;
  titleSnapshot: string;
  templateUrl: string;
  fontUrl: string;
  fullName: string;
  position: string | null;
  organization: string | null;
  score: number;
  total: number;
  passScore: number;
  certificateNumber: string;
  completedAt: string;
  issuedAt: string;
  verificationUrl: string;
}>;

export type CertificateExportSkip = Readonly<{
  attestationId: string;
  reason: string;
}>;

export type CertificateExportMetadata = Readonly<{
  schemaVersion: typeof CERTIFICATE_CLIENT_SCHEMA_VERSION;
  filename: string;
  generatedAt: string;
  requested: number;
  total: number;
  eligible: number;
  reportFontUrl: string;
  skipped: readonly CertificateExportSkip[];
  items: readonly CertificateRenderMetadata[];
  archivePolicy: Readonly<{
    maxItemsPerBufferedArchive: typeof CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS;
    maxItems: typeof CERTIFICATE_EXPORT_MAX_ITEMS;
    renderConcurrency: typeof CERTIFICATE_RENDER_CONCURRENCY;
  }>;
}>;

export type CertificateWorkerProgress = Readonly<{
  completed: number;
  total: number;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CERTIFICATE_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/u;
const SAFE_ASSET_PATH_PATTERN = /^\/certificate-assets\/font\?locale=(?:ru|zh)&v=(?:1|Sans2\.004)$/u;

function assertString(value: unknown, code: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new Error(code);
  }
}

function assertOptionalString(
  value: unknown,
  code: string,
  maxLength: number,
): asserts value is string | null {
  if (value !== null && (typeof value !== 'string' || value.length < 1 || value.length > maxLength)) {
    throw new Error(code);
  }
}

function assertInteger(value: unknown, code: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(code);
  }
}

export function assertCertificateRenderMetadata(
  value: unknown,
): asserts value is CertificateRenderMetadata {
  if (!value || typeof value !== 'object') throw new Error('CERTIFICATE_METADATA_INVALID');
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== CERTIFICATE_CLIENT_SCHEMA_VERSION) {
    throw new Error('CERTIFICATE_METADATA_VERSION_INVALID');
  }
  assertString(item.certificateId, 'CERTIFICATE_ID_INVALID', 36);
  if (!UUID_PATTERN.test(item.certificateId)) throw new Error('CERTIFICATE_ID_INVALID');
  assertString(item.filename, 'CERTIFICATE_FILENAME_INVALID', 192);
  if (
    !item.filename.toLowerCase().endsWith('.pdf') ||
    /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(item.filename) ||
    item.filename.startsWith('.')
  ) {
    throw new Error('CERTIFICATE_FILENAME_INVALID');
  }
  if (!CERTIFICATE_LOCALES.includes(item.locale as CertificateLocale)) {
    throw new Error('CERTIFICATE_LOCALE_INVALID');
  }
  assertInteger(item.templateVersion, 'CERTIFICATE_TEMPLATE_VERSION_INVALID', 1, 100);
  assertString(item.titleSnapshot, 'CERTIFICATE_TITLE_INVALID', 240);
  assertString(item.templateUrl, 'CERTIFICATE_TEMPLATE_URL_INVALID', 256);
  assertString(item.fontUrl, 'CERTIFICATE_FONT_URL_INVALID', 256);
  const expectedFontUrl = `/certificate-assets/font?locale=${item.locale}&v=${item.locale === 'zh' ? 'Sans2.004' : '1'}`;
  if (
    item.templateUrl !== `/certificates/template-v${item.templateVersion}.pdf` ||
    item.fontUrl !== expectedFontUrl
  ) {
    throw new Error('CERTIFICATE_ASSET_URL_INVALID');
  }
  assertString(item.fullName, 'CERTIFICATE_NAME_INVALID', 200);
  assertOptionalString(item.position, 'CERTIFICATE_POSITION_INVALID', 160);
  assertOptionalString(item.organization, 'CERTIFICATE_ORGANIZATION_INVALID', 200);
  assertInteger(item.score, 'CERTIFICATE_SCORE_INVALID', 0, 10_000);
  assertInteger(item.total, 'CERTIFICATE_TOTAL_INVALID', 1, 10_000);
  assertInteger(item.passScore, 'CERTIFICATE_PASS_SCORE_INVALID', 0, 10_000);
  if (Number(item.score) > Number(item.total) || Number(item.passScore) > Number(item.total)) {
    throw new Error('CERTIFICATE_SCORE_INVALID');
  }
  assertString(item.certificateNumber, 'CERTIFICATE_NUMBER_INVALID', 96);
  if (!CERTIFICATE_NUMBER_PATTERN.test(item.certificateNumber)) {
    throw new Error('CERTIFICATE_NUMBER_INVALID');
  }
  assertString(item.issuedAt, 'CERTIFICATE_ISSUED_AT_INVALID', 40);
  if (!Number.isFinite(Date.parse(item.issuedAt))) throw new Error('CERTIFICATE_ISSUED_AT_INVALID');
  assertString(item.completedAt, 'CERTIFICATE_COMPLETED_AT_INVALID', 40);
  if (!Number.isFinite(Date.parse(item.completedAt))) {
    throw new Error('CERTIFICATE_COMPLETED_AT_INVALID');
  }
  assertString(item.verificationUrl, 'CERTIFICATE_VERIFICATION_URL_INVALID', 2_048);
  let verificationUrl: URL;
  try {
    verificationUrl = new URL(item.verificationUrl);
  } catch {
    throw new Error('CERTIFICATE_VERIFICATION_URL_INVALID');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(verificationUrl.hostname);
  if (
    (verificationUrl.protocol !== 'https:' && !(verificationUrl.protocol === 'http:' && loopback)) ||
    verificationUrl.username ||
    verificationUrl.password ||
    verificationUrl.search ||
    verificationUrl.hash ||
    !/^\/verify\/v1\.[A-Za-z0-9._-]+$/u.test(verificationUrl.pathname)
  ) {
    throw new Error('CERTIFICATE_VERIFICATION_URL_INVALID');
  }
}

export function assertCertificateExportMetadata(
  value: unknown,
): asserts value is CertificateExportMetadata {
  if (!value || typeof value !== 'object') throw new Error('CERTIFICATE_EXPORT_INVALID');
  const result = value as Record<string, unknown>;
  if (result.schemaVersion !== CERTIFICATE_CLIENT_SCHEMA_VERSION) {
    throw new Error('CERTIFICATE_EXPORT_VERSION_INVALID');
  }
  assertString(result.filename, 'CERTIFICATE_EXPORT_FILENAME_INVALID', 160);
  if (
    !result.filename.toLowerCase().endsWith('.zip') ||
    /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(result.filename) ||
    result.filename.startsWith('.')
  ) {
    throw new Error('CERTIFICATE_EXPORT_FILENAME_INVALID');
  }
  assertString(result.generatedAt, 'CERTIFICATE_EXPORT_DATE_INVALID', 40);
  if (!Number.isFinite(Date.parse(result.generatedAt))) {
    throw new Error('CERTIFICATE_EXPORT_DATE_INVALID');
  }
  assertInteger(result.requested, 'CERTIFICATE_EXPORT_COUNT_INVALID', 0, 500);
  assertInteger(result.total, 'CERTIFICATE_EXPORT_COUNT_INVALID', 0, 500);
  assertInteger(result.eligible, 'CERTIFICATE_EXPORT_COUNT_INVALID', 0, 500);
  assertString(result.reportFontUrl, 'CERTIFICATE_FONT_URL_INVALID', 256);
  if (!SAFE_ASSET_PATH_PATTERN.test(result.reportFontUrl)) {
    throw new Error('CERTIFICATE_ASSET_URL_INVALID');
  }
  if (!Array.isArray(result.items) || result.items.length > CERTIFICATE_EXPORT_MAX_ITEMS) {
    throw new Error('CERTIFICATE_EXPORT_SIZE_INVALID');
  }
  if (!Array.isArray(result.skipped) || result.skipped.length > CERTIFICATE_EXPORT_MAX_ITEMS) {
    throw new Error('CERTIFICATE_EXPORT_SIZE_INVALID');
  }
  if (
    result.items.length !== result.eligible ||
    result.total !== result.requested ||
    result.items.length + result.skipped.length !== result.requested
  ) {
    throw new Error('CERTIFICATE_EXPORT_COUNT_INVALID');
  }
  for (const item of result.items) assertCertificateRenderMetadata(item);
  for (const skipped of result.skipped) {
    if (!skipped || typeof skipped !== 'object') throw new Error('CERTIFICATE_EXPORT_SKIP_INVALID');
    const entry = skipped as Record<string, unknown>;
    assertString(entry.attestationId, 'CERTIFICATE_EXPORT_SKIP_INVALID', 36);
    assertString(entry.reason, 'CERTIFICATE_EXPORT_SKIP_INVALID', 96);
    if (
      !UUID_PATTERN.test(entry.attestationId) ||
      !/^[A-Za-z][A-Za-z0-9_]{1,95}(?::[0-9]{1,10})?$/u.test(entry.reason)
    ) {
      throw new Error('CERTIFICATE_EXPORT_SKIP_INVALID');
    }
  }
  if (!result.archivePolicy || typeof result.archivePolicy !== 'object') {
    throw new Error('CERTIFICATE_EXPORT_POLICY_INVALID');
  }
  const policy = result.archivePolicy as Record<string, unknown>;
  if (
    policy.maxItemsPerBufferedArchive !== CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS ||
    policy.maxItems !== CERTIFICATE_EXPORT_MAX_ITEMS ||
    policy.renderConcurrency !== CERTIFICATE_RENDER_CONCURRENCY
  ) {
    throw new Error('CERTIFICATE_EXPORT_POLICY_INVALID');
  }
}
