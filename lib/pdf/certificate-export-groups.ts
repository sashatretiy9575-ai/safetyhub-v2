import type { CertificateExportMetadata } from './certificate-client-contract.ts';
import { normalizePdfText } from './certificate.ts';

/**
 * One archive per company.
 *
 * The server hands the browser a single flat export: every certificate of the
 * selection plus one summary report. Operators file documents by company, so
 * the browser splits that payload here, before any PDF is rendered. Each
 * group is a complete export of its own — the counters are recomputed and the
 * report inside the archive lists only that company — and it goes through the
 * same contract check as the original.
 */

const ARCHIVE_STEM_MAX_CODE_POINTS = 100;

// Everything the archive-name contract refuses, plus control characters.
const FORBIDDEN_ARCHIVE_NAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}]/gu;

export type CertificateExportGroup = Readonly<{
  /** Normalized company key; empty when the certificates carry no company. */
  key: string;
  /** The company as first seen in the payload, for messages. */
  organization: string | null;
  metadata: CertificateExportMetadata;
}>;

/** Matches the register's own grouping of company bands. */
export function organizationArchiveKey(value: string | null | undefined): string {
  return normalizePdfText(value ?? '').toLocaleLowerCase('ru-RU');
}

/**
 * `<company>.zip`, or null when there is nothing usable in the name. Spaces
 * stay (the owner reads these names); the characters the contract forbids are
 * dropped.
 */
export function organizationArchiveFilename(
  organization: string | null | undefined,
): string | null {
  const stem = normalizePdfText(organization ?? '')
    .replace(FORBIDDEN_ARCHIVE_NAME_CHARACTERS, '')
    .replace(/^[. ]+/u, '')
    .replace(/[. ]+$/u, '')
    .trim();
  if (!stem) return null;
  const points = Array.from(stem);
  const bounded =
    points.length > ARCHIVE_STEM_MAX_CODE_POINTS
      ? points
          .slice(0, ARCHIVE_STEM_MAX_CODE_POINTS)
          .join('')
          .replace(/[. ]+$/u, '')
      : stem;
  return `${bounded}.zip`;
}

/** Case-insensitive de-duplication: `name.zip`, `name-2.zip`, `name-3.zip`. */
export function uniqueArchiveFilename(filename: string, used: Set<string>): string {
  const stem = filename.toLowerCase().endsWith('.zip') ? filename.slice(0, -4) : filename;
  let candidate = `${stem}.zip`;
  let attempt = 1;
  while (used.has(candidate.toLowerCase())) {
    attempt += 1;
    candidate = `${stem}-${attempt}.zip`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function groupCertificateExportByOrganization(
  metadata: CertificateExportMetadata,
): CertificateExportGroup[] {
  // A report-only export (nothing eligible) stays one archive under the
  // server's name, exactly as before.
  if (metadata.items.length === 0) return [{ key: '', organization: null, metadata }];

  const groups = new Map<
    string,
    { organization: string | null; items: CertificateExportMetadata['items'][number][] }
  >();
  for (const item of metadata.items) {
    const key = organizationArchiveKey(item.organization);
    const group = groups.get(key);
    if (group) group.items.push(item);
    else groups.set(key, { organization: key ? item.organization : null, items: [item] });
  }

  const used = new Set<string>();
  return [...groups.entries()].map(([key, group]) => {
    const base = organizationArchiveFilename(group.organization) ?? metadata.filename;
    return {
      key,
      organization: group.organization,
      metadata: {
        ...metadata,
        filename: uniqueArchiveFilename(base, used),
        requested: group.items.length,
        total: group.items.length,
        eligible: group.items.length,
        // Skips carry no company; they are reported once, by the caller.
        skipped: [],
        items: group.items,
      },
    };
  });
}
