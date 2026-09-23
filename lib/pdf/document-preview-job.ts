import type { CertificateBranding } from './certificate-client-contract.ts';
import type { CertificatePreviewData } from './certificate-renderer.ts';
import type { DocumentParticipant } from './document-editor.ts';
import type { ProtocolGroup } from './protocol-renderer.ts';

/**
 * One preview, described by the arguments of its generator and by nothing else.
 * Whatever is not here cannot change the PDF, so it cannot ask for a new one.
 */
export type PreviewJob =
  | Readonly<{ kind: 'certificate'; input: CertificatePreviewData }>
  | Readonly<{
      kind: 'protocol';
      input: ProtocolGroup;
      branding: CertificateBranding;
      fontUrl: string;
    }>
  | Readonly<{ kind: 'message'; text: string }>
  | Readonly<{ kind: 'wait' }>;

/** A Chinese name needs the CJK face; every other protocol is set in the Cyrillic one. */
export function protocolFontUrl(people: readonly Pick<DocumentParticipant, 'fullName'>[]) {
  return (
    '/certificate-assets/font?locale=' +
    (people.some((person) => /[㐀-鿿]/u.test(person.fullName)) ? 'zh&v=Sans2.005' : 'ru&v=1')
  );
}

/** Who the sample documents are about: nobody real, one line of the protocol. */
export type SamplePerson = Readonly<{ fullName: string; position: string; education: string }>;
export const SAMPLE_ORGANIZATION = 'ТОО «Пример»';

/**
 * The document a course would print today for the sample person: the booklet
 * or the protocol, drawn from settings that are not saved yet. The date is
 * the protocol's; the sample passed with the full score.
 */
export function samplePreviewJob(
  tab: 'protocol' | 'certificate',
  branding: CertificateBranding,
  program: string,
  person: SamplePerson,
): PreviewJob {
  const date = branding.protocolDate ?? '';
  if (tab === 'certificate') {
    return {
      kind: 'certificate',
      input: {
        schemaVersion: 1,
        filename: 'Предпросмотр.pdf',
        locale: 'ru',
        templateVersion: 1,
        templateUrl: '/certificate-assets/template',
        fontUrl: '/certificate-assets/font?locale=ru&v=1',
        fullName: person.fullName,
        position: person.position,
        organization: SAMPLE_ORGANIZATION,
        titleSnapshot: program,
        photoUrl: null,
        score: 10,
        total: 10,
        passScore: 8,
        certificateNumber: 'ПРЕДПРОСМОТР',
        completedAt: date,
        issuedAt: date + 'T12:00:00+05:00',
        branding,
      },
    };
  }
  return {
    kind: 'protocol',
    input: {
      organization: SAMPLE_ORGANIZATION,
      courseTitle: program,
      date,
      items: [],
      participants: [
        {
          userId: 'sample',
          fullName: person.fullName,
          position: person.position,
          education: person.education,
          status: 'passed',
          score: 10,
          total: 10,
          certificateId: null,
        },
      ],
    },
    branding,
    fontUrl: protocolFontUrl([person]),
  };
}

/** Seconds a 429 asks to wait, for «Повторите через N с»; a missing header is a full window. */
export function retryAfterSeconds(
  header: string | null | undefined,
  fallback = 60,
  now = Date.now(),
): number {
  const value = header?.trim() ?? '';
  const seconds = /^\d+$/u.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), 3600) : fallback;
}
