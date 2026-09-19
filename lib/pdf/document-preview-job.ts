import type {
  CertificateBranding,
  CertificateRenderMetadata,
} from './certificate-client-contract.ts';
import type { CertificatePreviewData } from './certificate-renderer.ts';
import type { DocumentParticipant } from './document-editor.ts';
import type { ProtocolGroup } from './protocol-renderer.ts';

/** What the document editor has on the screen when it asks which PDF to draw. */
export type PreviewState = Readonly<{
  tab: 'certificate' | 'protocol';
  /** The participants of the chosen company and program are still on their way. */
  loading: boolean;
  /** The employee chosen for the booklet; the protocol never looks at it. */
  person: DocumentParticipant | null | undefined;
  /** The frozen snapshot of that employee's issued certificate, once it has arrived. */
  metadata: CertificateRenderMetadata | null;
  /** Why the snapshot did not arrive, worded by the caller: nothing is drawn without it. */
  metadataMessage?: string | null;
  /** Which side of the typed insert size cannot be printed, worded by the caller. */
  sizeMessage?: string | null;
  branding: CertificateBranding;
  program: string;
  organization: string;
  /** «Компания образца»: heads the protocol until a company is chosen. */
  sampleOrganization: string;
  batch: Readonly<{ date: string }>;
  participants: readonly DocumentParticipant[];
}>;

/**
 * One preview, described by the arguments of its generator and by nothing else.
 * Whatever is not here cannot change the PDF, so it cannot ask for a new one: an
 * issued certificate is its frozen metadata, and no field of the form is in it.
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

type RenderJob = Extract<PreviewJob, { kind: 'certificate' | 'protocol' }>;

/** A Chinese name needs the CJK face; every other protocol is set in the Cyrillic one. */
export function protocolFontUrl(people: readonly Pick<DocumentParticipant, 'fullName'>[]) {
  return (
    '/certificate-assets/font?locale=' +
    (people.some((person) => /[㐀-鿿]/u.test(person.fullName)) ? 'zh&v=Sans2.005' : 'ru&v=1')
  );
}

export function buildPreviewJob(state: PreviewState): PreviewJob {
  if (state.loading) return { kind: 'wait' };
  if (state.tab === 'certificate') {
    const person = state.person;
    if (!person) return { kind: 'message', text: 'Выберите компанию, программу и сотрудника' };
    if (state.sizeMessage) return { kind: 'message', text: state.sizeMessage };
    const issued = person.certificateId;
    if (issued && state.metadata?.certificateId !== issued) {
      return state.metadataMessage
        ? { kind: 'message', text: state.metadataMessage }
        : { kind: 'wait' };
    }
    // An issued document keeps the requisites it was issued with: the open fields
    // are for the next issuance and must not even ask for this PDF again.
    if (issued && state.metadata) return { kind: 'certificate', input: state.metadata };
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
        organization: state.organization,
        titleSnapshot: state.program,
        photoUrl: person.photoUrl,
        score: person.score ?? 0,
        total: person.total ?? 0,
        passScore: 0,
        certificateNumber: 'ПРЕДПРОСМОТР',
        completedAt: state.batch.date,
        issuedAt: state.batch.date + 'T12:00:00+05:00',
        branding: state.branding,
      },
    };
  }
  return {
    kind: 'protocol',
    input: {
      organization: state.organization || state.sampleOrganization,
      courseTitle: state.program,
      date: state.batch.date,
      items: [],
      participants: state.participants,
    },
    branding: state.branding,
    fontUrl: protocolFontUrl(state.participants),
  };
}

/** Two jobs with one key are one PDF: the key is the generator's arguments, all of them. */
export function jobKey(job: PreviewJob): string {
  return JSON.stringify(job);
}

// What a keyboard cannot change: who the document is about and which pictures it
// carries. Everything else in a job is text, a number or a date somebody is typing.
const BRANDING_IDENTITY = [
  'stampUrl',
  'chairmanSignatureUrl',
  'memberSignatureUrl',
  'protocolSignatureUrl',
  'commissionSignatureUrls',
  'documentProfile',
  'protocolLayoutVersion',
] as const;
const PERSON_IDENTITY = [
  'certificateId',
  'certificateNumber',
  'fullName',
  'position',
  'photoUrl',
  'score',
  'total',
  'fontUrl',
] as const;

const isRenderJob = (job: PreviewJob): job is RenderJob =>
  job.kind === 'certificate' || job.kind === 'protocol';

function identity(job: RenderJob): string {
  const branding = job.kind === 'certificate' ? job.input.branding : job.branding;
  const input: Partial<Record<(typeof PERSON_IDENTITY)[number], unknown>> =
    job.kind === 'certificate' ? job.input : {};
  return JSON.stringify([
    job.kind,
    BRANDING_IDENTITY.map((field) => branding[field] ?? null),
    job.kind === 'certificate'
      ? PERSON_IDENTITY.map((field) => input[field] ?? null)
      : [job.fontUrl, job.input.participants ?? null],
  ]);
}

/**
 * A choice is drawn at once, typing waits for a pause. A tab, an employee, a
 * company, a program or a profile changes who or what the document is; the same
 * job asked for again is «Повторить»; a job that follows a message or a wait is
 * the answer to it. Only a text that differs is somebody still typing.
 */
export function isDiscreteChange(previous: PreviewJob | null | undefined, next: PreviewJob) {
  if (!previous || !isRenderJob(previous) || !isRenderJob(next)) return true;
  return jobKey(previous) === jobKey(next) || identity(previous) !== identity(next);
}

function abortError() {
  return new DOMException('Document preview was cancelled', 'AbortError');
}

/** The caller stops waiting when its signal fires; the shared work goes on for the others. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** The last few PDFs by job key: going back to a document already drawn costs nothing. */
export function createBytesCache(limit = 4) {
  const entries = new Map<string, Uint8Array>();
  return {
    get(key: string): Uint8Array | undefined {
      const bytes = entries.get(key);
      if (bytes) {
        entries.delete(key);
        entries.set(key, bytes);
      }
      return bytes;
    },
    set(key: string, bytes: Uint8Array) {
      entries.delete(key);
      entries.set(key, bytes);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    delete(key: string) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * What an editor session downloads once: a participant's photo, an issued
 * certificate's metadata. `/api/*` is `no-store`, so the memory of the open page
 * is the only cache there is. A failure is never remembered: the next request
 * asks again. `load` must not be tied to one caller's signal, because the
 * promise is shared; `signal` only ends this caller's wait.
 */
export function createSessionCache<T>(limit: number) {
  const entries = new Map<string, Promise<T>>();
  return {
    get(key: string, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortError());
      let pending = entries.get(key);
      if (pending) entries.delete(key);
      else {
        const started = (async () => load())();
        void started.catch(() => {
          if (entries.get(key) === started) entries.delete(key);
        });
        pending = started;
      }
      entries.set(key, pending);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
      return signal ? abortable(pending, signal) : pending;
    },
    delete(key: string) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
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

/** Waits out a quota window, unless the administrator presses «Отменить» first. */
export function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
