'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsClockwise,
  Buildings,
  CaretDown,
  Check,
  Eye,
  FilePdf,
  FileText,
  FileZip,
  FloppyDisk,
  IdentificationCard,
  NotePencil,
  PencilSimple,
  Plus,
  Ruler,
  Stamp,
  TextAa,
  Trash,
  UsersThree,
  X,
} from '@phosphor-icons/react';
import { DocumentAssetRegistry } from '@/components/admin/document-asset-registry';
import {
  DocumentImageTiles,
  type DocumentImageSlot,
} from '@/components/admin/document-image-tiles';
import { DocumentNoteField } from '@/components/admin/document-note-field';
import { DocumentPdfPreview } from '@/components/admin/document-pdf-preview';
import { DocumentSelect } from '@/components/admin/document-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';
import { clientFetch } from '@/lib/client-request';
import {
  assertCertificateRenderMetadata,
  certificateImageUrl,
  type CertificateBranding,
  type CertificateRenderMetadata,
} from '@/lib/pdf/certificate-client-contract';
import {
  buildDocumentAssetRegistry,
  type DocumentAssetInfo,
} from '@/lib/pdf/document-asset-registry';
import {
  INSERT_SIZE_LIMITS,
  changeDocumentDate,
  insertSizeProblem,
  newDocumentBatch,
  numberFromDate,
  type DocumentBatch,
  type DocumentDefaults,
  type InsertSizeKey,
} from '@/lib/pdf/document-editor';
import {
  abortableDelay,
  buildPreviewJob,
  createBytesCache,
  createSessionCache,
  isDiscreteChange,
  jobKey,
  protocolFontUrl,
  retryAfterSeconds,
  type PreviewJob,
} from '@/lib/pdf/document-preview-job';
import { cn } from '@/lib/utils';
import type { readDocumentEditor } from '@/server/certificates/document-editor';
import { applyDocumentProfile, type DocumentProfile } from '@/lib/pdf/document-profile';
import { DocumentProfileFields } from '@/components/admin/document-profile-fields';
import { documentAudienceForPosition } from '@/lib/pdf/document-family-defaults';
import { requiresDocumentEducation } from '@/lib/pdf/document-education';

export type CertificateSettingsView = {
  organizationName: string;
  bin: string;
  chairmanName: string;
  chairmanPosition: string;
  memberName: string;
  memberPosition: string;
  secondMemberName: string;
  secondMemberPosition: string;
  protocolNumber: string;
  validityMonths: number;
  examTextKk: string;
  examTextRu: string;
  knowledgeTextKk: string;
  knowledgeTextRu: string;
  documentDefaults: DocumentDefaults;
  hasStamp: boolean;
  hasChairmanSignature: boolean;
  hasMemberSignature: boolean;
  hasProtocolSignature: boolean;
  version: number;
  updatedAt: string;
};
type EditorData = Awaited<ReturnType<typeof readDocumentEditor>>;
type DocumentTab = 'protocol' | 'certificate';
const SECTION_IDS = ['profile', 'note', 'images', 'commission', 'texts', 'size'] as const;
type SectionId = (typeof SECTION_IDS)[number];
const SECTIONS_KEY = 'document-editor-sections';
/** Long enough to fold a burst of picks into one generation, short enough to read as instant. */
const DISCRETE_RENDER_DELAY_MS = 150;
type SettingsFields = Pick<
  CertificateSettingsView,
  | 'organizationName'
  | 'bin'
  | 'chairmanName'
  | 'chairmanPosition'
  | 'validityMonths'
  | 'examTextKk'
  | 'examTextRu'
  | 'knowledgeTextKk'
  | 'knowledgeTextRu'
  | 'documentDefaults'
>;
type TextKey = keyof Omit<SettingsFields, 'documentDefaults' | 'validityMonths'>;
type DefaultsTextKey = Exclude<
  keyof DocumentDefaults,
  'commission' | 'insertWidthCm' | 'insertHeightCm'
>;

function fieldsOf(settings: CertificateSettingsView): SettingsFields {
  const {
    organizationName,
    bin,
    chairmanName,
    chairmanPosition,
    validityMonths,
    examTextKk,
    examTextRu,
    knowledgeTextKk,
    knowledgeTextRu,
    documentDefaults,
  } = settings;
  return {
    organizationName,
    bin,
    chairmanName,
    chairmanPosition,
    validityMonths,
    examTextKk,
    examTextRu,
    knowledgeTextKk,
    knowledgeTextRu,
    documentDefaults,
  };
}

/** What both documents are drawn with: saved settings, the open fields, this protocol's number. */
function brandingOf(
  saved: CertificateSettingsView,
  fields: SettingsFields,
  batch: DocumentBatch,
  profiles: readonly DocumentProfile[] = [],
  position?: string | null,
): CertificateBranding {
  const image = (kind: 'stamp' | 'chairman' | 'protocol', present: boolean) =>
    present ? certificateImageUrl(kind, saved.version) : null;
  const branding: CertificateBranding = {
    protocolLayoutVersion: 2,
    ...saved,
    ...fields,
    protocolNumber: batch.number,
    protocolDate: batch.date,
    stampUrl: image('stamp', saved.hasStamp),
    chairmanSignatureUrl: image('chairman', saved.hasChairmanSignature),
    memberSignatureUrl: null,
    protocolSignatureUrl: image('protocol', saved.hasProtocolSignature),
  };
  // A program split into «ИТР» and «рабочий состав» has no common profile. It
  // used to refuse everything until somebody picked one by hand; the position the
  // person holds already says which half they are in, and the database resolves it
  // the same way, so a preview and the issued document cannot disagree.
  const profile =
    profiles.find((p) => p.id === batch.profileId) ??
    profiles.find((p) => p.courseSlug === batch.courseSlug && p.audience === 'all') ??
    profiles.find(
      (p) =>
        p.courseSlug === batch.courseSlug && p.audience === documentAudienceForPosition(position),
    );
  return profile ? applyDocumentProfile(branding, profile) : branding;
}

function download(bytes: Uint8Array, filename: string, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** `certificate.pdf` allows 20 reads a minute; the 21st says how long to wait. */
class RetryLater extends Error {
  seconds: number;
  constructor(seconds: number) {
    super('RATE_LIMITED');
    this.seconds = seconds;
  }
}
const retryLaterMessage = (error: RetryLater) => `Повторите через ${error.seconds} с`;

async function metadataFor(id: string, signal?: AbortSignal): Promise<CertificateRenderMetadata> {
  const response = await clientFetch(`/api/certificates/${id}/metadata`, {
    signal,
    cache: 'no-store',
  });
  if (response.status === 429)
    throw new RetryLater(retryAfterSeconds(response.headers.get('Retry-After')));
  if (!response.ok) throw new Error('CERTIFICATE_UNAVAILABLE');
  const data: unknown = await response.json();
  assertCertificateRenderMetadata(data);
  return data;
}

/** A company kit reads one certificate per person and outruns the quota: it waits the window out. */
async function metadataForKit(id: string, signal: AbortSignal, onWait: (seconds: number) => void) {
  for (let waits = 0; ; waits++) {
    try {
      return await metadataFor(id, signal);
    } catch (error) {
      if (!(error instanceof RetryLater) || waits >= 3) throw error;
      onWait(error.seconds);
      await abortableDelay(error.seconds * 1000, signal);
    }
  }
}

/** Why a filled-in side of the insert is refused, with the limits the administrator can act on. */
const insertSizeMessage = (key: InsertSizeKey) =>
  `${key === 'insertWidthCm' ? 'Общая ширина' : 'Высота'} вкладыша: от ${INSERT_SIZE_LIMITS[key][0]} до ${INSERT_SIZE_LIMITS[key][1]} см`;

/** What `buildPreviewJob` says for a booklet with nobody chosen; it also stands for a program not chosen. */
const CHOOSE_DOCUMENT = 'Выберите компанию, программу и сотрудника';
/** «Номер протокола · по дате»: the number is the day and month of the date until somebody types their own. */
const NUMBER_FOLLOWS_DATE = ' · по дате';
/** «08.09.2026», on the calendar the documents themselves are dated by. */
const issueDay = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Oral',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** The name of a field lives inside the field, above what is typed into it. */
function Field({
  label,
  state,
  className,
  children,
}: {
  label: string;
  /** What the name gains and loses with the field's mode. Its room is kept, so the field never moves. */
  state?: { text: string; on: boolean };
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn('grid min-w-0 gap-1.5', className)}>
      <span className="text-sm break-words text-[var(--color-text-muted)]">
        {label}
        {state ? <span className={cn(!state.on && 'invisible')}>{state.text}</span> : null}
      </span>
      {children}
    </label>
  );
}
const FIELD_INPUT = 'min-h-12 min-w-0 w-full text-base';
/** A 240 px screen has room for the word or for the icon, not for both. */
const NARROW_HIDDEN = 'hidden min-[280px]:inline';
const FIELD_TEXTAREA = 'min-w-0 w-full text-base';

/** A rarely touched group of settings: one line until it is opened. */
function Section({
  icon,
  title,
  hint,
  alert,
  open,
  keepMounted,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  alert?: boolean;
  open: boolean;
  /** For content that holds a draft of its own: folding the line away must not discard it. */
  keepMounted?: boolean;
  onToggle(): void;
  children: React.ReactNode;
}) {
  const panel = useId();
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={onToggle}
        className="flex min-h-14 w-full min-w-0 items-center gap-3 py-2 text-left"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-on-primary-soft)] [&_svg]:size-4.5">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold break-words">{title}</span>
          {hint ? (
            <span
              className={cn(
                'block text-sm break-words',
                alert ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]',
              )}
            >
              {hint}
            </span>
          ) : null}
        </span>
        <CaretDown
          aria-hidden="true"
          size={16}
          className={cn('shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      <div id={panel} hidden={!open} className="space-y-3 pt-1 pb-4">
        {open || keepMounted ? children : null}
      </div>
    </section>
  );
}

export function CertificateSettingsForm({
  initialSettings,
  initialData,
  profiles: initialProfiles = [],
  assets: initialAssets = [],
  initialSelection = {},
}: {
  initialSettings: CertificateSettingsView;
  initialData: EditorData;
  profiles?: readonly DocumentProfile[];
  /** Whose the registered images named by the profiles are, and since when. */
  assets?: readonly DocumentAssetInfo[];
  initialSelection?: { organization?: string; course?: string; user?: string; tab?: string };
}) {
  const initialCourse =
    initialData.courses.find(
      (c) => c.slug === initialSelection.course || c.id === initialSelection.course,
    )?.slug ?? '';
  const [saved, setSaved] = useState(initialSettings);
  const [profiles, setProfiles] = useState(initialProfiles);
  const [assets, setAssets] = useState(initialAssets);
  const [fields, setFields] = useState(() => fieldsOf(initialSettings));
  const [data, setData] = useState(initialData);
  const [organization, setOrganization] = useState(initialSelection.organization ?? '');
  const [course, setCourse] = useState(initialCourse);
  const [user, setUser] = useState(
    initialSelection.user ?? initialData.participants[0]?.userId ?? '',
  );
  const [tab, setTab] = useState<DocumentTab>(
    initialSelection.tab === 'certificate' ? 'certificate' : 'protocol',
  );
  const [mobile, setMobile] = useState<'fields' | 'preview'>('fields');
  const [half, setHalf] = useState<'left' | 'right'>('left');
  const [sections, setSections] = useState<ReadonlySet<SectionId>>(new Set());
  const [changeContext, setChangeContext] = useState(
    !initialSelection.organization || !initialSelection.course,
  );
  const [batch, setBatch] = useState(
    () => initialData.batch ?? newDocumentBatch(initialSelection.organization ?? '', initialCourse),
  );
  const [savedBatch, setSavedBatch] = useState<DocumentBatch | null>(initialData.batch);
  const [metadata, setMetadata] = useState<CertificateRenderMetadata | null>(null);
  const [metadataProblem, setMetadataProblem] = useState('');
  // The PDF on the screen and the job it answers: a download is offered only while they match.
  const [shown, setShown] = useState<{
    key: string;
    job: PreviewJob;
    bytes: Uint8Array;
    photoFailed: boolean;
  } | null>(null);
  const [renderProblem, setRenderProblem] = useState<{ key: string; text: string } | null>(null);
  // `/api/*` is no-store: the open editor is the only cache of what it has already fetched or drawn.
  const [caches] = useState(() => ({
    bytes: createBytesCache(),
    photos: createSessionCache<Uint8Array>(24),
    metadata: createSessionCache<CertificateRenderMetadata>(64),
  }));
  const lastJob = useRef<PreviewJob | null>(null);
  const lastPhotoUrl = useRef<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const exportAbort = useRef<AbortController | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const sizeInputs = useRef<Partial<Record<InsertSizeKey, HTMLInputElement | null>>>({});
  const refusedSize = useRef<InsertSizeKey | null>(null);
  useEffect(() => () => exportAbort.current?.abort(), []);
  // Whatever was open stays open across a reload: the administrator is in the middle of it.
  // The marker tells a test that clicks are heard: one made before hydration is lost.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(SECTIONS_KEY) ?? '[]');
      if (Array.isArray(stored)) {
        setSections(new Set(stored.filter((id): id is SectionId => SECTION_IDS.includes(id))));
      }
    } catch {
      // A private window without storage simply starts collapsed.
    }
  }, []);

  const selectedPerson = data.participants.find((p) => p.userId === user);
  const program =
    data.courses.find((c) => c.slug === course)?.title ?? fields.documentDefaults.programName;
  const dirty = JSON.stringify(fields) !== JSON.stringify(fieldsOf(saved));
  const batchDirty =
    Boolean(organization && course) && JSON.stringify(batch) !== JSON.stringify(savedBatch);
  const selectedCertificate = selectedPerson?.certificateId;
  const valid =
    Number.isInteger(fields.validityMonths) &&
    fields.validityMonths >= 0 &&
    fields.validityMonths <= 120;
  const sizeMissing =
    !fields.documentDefaults.insertWidthCm || !fields.documentDefaults.insertHeightCm;
  // A size typed in millimetres or for one half only: named here, never sent to be refused.
  const sizeProblem = insertSizeProblem(fields.documentDefaults);
  const canRevertBatch = batchDirty && Boolean(savedBatch);
  const branding = brandingOf(saved, fields, batch, profiles, selectedPerson?.position);
  // A program with a profile is drawn from it: its commission, its texts, its term and
  // its registered images replace the settings' own, so those are not offered beside it.
  const governed = Boolean(branding.documentProfile);
  // The stamp and the signatures of the settings serve a program that has no profile,
  // and a stand that has no profiles at all; everything else is the registry's.
  const legacyMode = course ? !governed : profiles.length === 0;
  // The profile sets the term of its program. A term of the settings left out of range
  // stays in sight even then: it is what keeps «Сохранить» switched off.
  const legacyTerm = !governed || !valid;
  const openSections = (change: (open: Set<SectionId>) => void) =>
    setSections((current) => {
      const next = new Set(current);
      change(next);
      try {
        sessionStorage.setItem(SECTIONS_KEY, JSON.stringify([...next]));
      } catch {
        // Not remembered, still opened.
      }
      return next;
    });
  const toggle = (id: SectionId) =>
    openSections((open) => {
      if (!open.delete(id)) open.add(id);
    });
  const setDefaults = (patch: Partial<DocumentDefaults>) =>
    setFields((current) => ({
      ...current,
      documentDefaults: { ...current.documentDefaults, ...patch },
    }));
  const setMember = (index: number, patch: Partial<DocumentDefaults['commission'][number]>) =>
    setDefaults({
      commission: fields.documentDefaults.commission.map((member, n) =>
        n === index ? { ...member, ...patch } : member,
      ),
    });

  const loadedSelection = useRef(JSON.stringify([organization, course]));
  useEffect(() => {
    const selection = JSON.stringify([organization, course]);
    if (loadedSelection.current === selection) return;
    const controller = new AbortController();
    setLoading(true);
    setMetadata(null);
    setMessage('');
    const params = new URLSearchParams({ organization, course });
    void clientFetch('/api/admin/documents?' + params, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return (await response.json()) as EditorData;
      })
      .then((next) => {
        if (controller.signal.aborted) return;
        loadedSelection.current = selection;
        // People were read again: a photo or a certificate may have changed meanwhile.
        caches.photos.clear();
        caches.metadata.clear();
        caches.bytes.clear();
        setData(next);
        setBatch(next.batch ?? newDocumentBatch(organization, course));
        setSavedBatch(next.batch);
        setUser((current) =>
          next.participants.some((p) => p.userId === current)
            ? current
            : (next.participants[0]?.userId ?? ''),
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setData((current) => ({ ...current, participants: [] }));
        setMessage('Участники не загрузились, выберите компанию ещё раз');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [organization, course, caches]);

  useEffect(() => {
    const controller = new AbortController();
    setMetadata(null);
    setMetadataProblem('');
    setMetadataLoading(Boolean(selectedCertificate));
    if (selectedCertificate) {
      // The download is shared and not tied to this employee's signal: coming back
      // to somebody already looked at costs nothing of the 20 reads a minute.
      void caches.metadata
        .get(selectedCertificate, () => metadataFor(selectedCertificate), controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setMetadata(value);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setMetadataProblem(
            error instanceof RetryLater ? retryLaterMessage(error) : 'Удостоверение недоступно',
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setMetadataLoading(false);
        });
    }
    return () => controller.abort();
  }, [selectedCertificate, previewRetry, caches]);

  // The job is the generator's arguments and nothing else: an issued certificate is
  // its frozen metadata, so typing in the fields does not even ask for its PDF again.
  // Where programs have profiles, no program means no document: the sample that
  // would be drawn is made of the settings' own commission, which no profile uses.
  const job: PreviewJob =
    !course && profiles.length
      ? { kind: 'message', text: CHOOSE_DOCUMENT }
      : buildPreviewJob({
          tab,
          loading,
          person: selectedPerson,
          metadata,
          metadataMessage: metadataProblem,
          sizeMessage: sizeProblem ? insertSizeMessage(sizeProblem) : null,
          branding,
          program,
          organization,
          sampleOrganization: fields.documentDefaults.companyName,
          batch,
          participants: data.participants,
        });
  const key = jobKey(job);
  const fresh = shown?.key === key;
  const bytes = job.kind === 'message' ? null : (shown?.bytes ?? null);
  // The same document being retyped keeps its pages, dimmed; another document
  // only keeps the height of the box until its own pages are ready.
  const pending =
    fresh || job.kind === 'message'
      ? null
      : isDiscreteChange(shown?.job, job)
        ? 'replace'
        : 'refresh';
  const previewMessage =
    job.kind === 'message' ? job.text : renderProblem?.key === key ? renderProblem.text : '';
  useEffect(() => {
    const previous = lastJob.current;
    lastJob.current = job;
    setRenderProblem(null);
    if (job.kind === 'message' || job.kind === 'wait') {
      // A message takes the pages away for good: they are not drawn again behind the next document.
      if (job.kind === 'message') setShown(null);
      setRendering(false);
      return;
    }
    const cached = caches.bytes.get(key);
    if (cached) {
      // Back to a document already drawn: no spinner, no generator, no pause.
      setShown({ key, job, bytes: cached, photoFailed: false });
      setRendering(false);
      return;
    }
    const controller = new AbortController();
    setRendering(true);
    const timer = setTimeout(
      () => {
        void (async () => {
          let photoFailed = false;
          let result: Uint8Array;
          if (job.kind === 'certificate') {
            const { generateCertificatePreview, loadCertificatePhotoBytes } =
              await import('@/lib/pdf/certificate-renderer');
            result = await generateCertificatePreview(job.input, controller.signal, {
              loadPhoto: (url, signal) => {
                lastPhotoUrl.current = url;
                return caches.photos.get(url, () => loadCertificatePhotoBytes(url), signal);
              },
              onPhotoError: () => {
                photoFailed = true;
              },
            });
          } else {
            const { generateProtocolInBrowser } = await import('@/lib/pdf/protocol-renderer');
            result = await generateProtocolInBrowser(
              job.input,
              job.branding,
              job.fontUrl,
              controller.signal,
            );
          }
          if (controller.signal.aborted) return;
          // A preview without its photo is shown but not kept: the next look asks for the photo again.
          if (!photoFailed) caches.bytes.set(key, result);
          setShown({ key, job, bytes: result, photoFailed });
        })()
          .catch((error) => {
            if (controller.signal.aborted) return;
            setRenderProblem({
              key,
              text:
                error instanceof Error && error.message === 'DOCUMENT_TEXT_OVERFLOW'
                  ? 'Текст не помещается: сократите тексты или состав комиссии'
                  : 'PDF не сформирован',
            });
          })
          .finally(() => {
            if (!controller.signal.aborted) setRendering(false);
          });
      },
      // Typing waits for a pause. A choice waits only long enough to see whether
      // another follows: generation cannot be interrupted once it has started, so
      // drawing each of six quick employee picks at once queued six of them on the
      // main thread (measured: 3.5 s of work against 0.7 s, and the picker itself
      // stuttered). A document already drawn never reaches this timer.
      isDiscreteChange(previous, job) ? DISCRETE_RENDER_DELAY_MS : 300,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // The key is the complete render input; `job` and `caches` are read through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, previewRetry]);

  /** Says which side of the insert is wrong and opens its field, wherever the administrator is. */
  function refuseSize(key: InsertSizeKey) {
    setMessage(insertSizeMessage(key));
    setTab('certificate');
    setMobile('fields');
    openSections((open) => {
      open.add('size');
    });
    refusedSize.current = key;
  }
  // Once its section is on the screen and the fields are enabled again, the
  // refused side is brought under the hand. It waits out as many renders as that takes.
  useEffect(() => {
    const input = !busy && refusedSize.current && sizeInputs.current[refusedSize.current];
    if (!input) return;
    refusedSize.current = null;
    input.scrollIntoView({ block: 'center' });
    input.focus({ preventScroll: true });
  });

  /** Saves whatever is unsaved and returns what the server now holds, or null on failure. */
  async function persist(): Promise<{
    settings: CertificateSettingsView;
    batch: DocumentBatch | null;
  } | null> {
    let settings = saved;
    let nextBatch = savedBatch;
    if (sizeProblem) {
      refuseSize(sizeProblem);
      return null;
    }
    try {
      if (dirty) {
        const response = await clientFetch('/api/admin/settings/certificate', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...fields, expectedVersion: saved.version }),
        });
        const result = await response.json();
        if (response.status === 409 && result.settings) {
          setSaved(result.settings);
          setMessage('Настройки изменил другой администратор. Сохраните ещё раз');
          return null;
        }
        // The server names the field it refused; the insert size is the one a form can get wrong.
        const refused = String(result.field ?? '').replace('documentDefaults.', '');
        if (response.status === 400 && Object.hasOwn(INSERT_SIZE_LIMITS, refused)) {
          refuseSize(refused as InsertSizeKey);
          return null;
        }
        if (!response.ok) throw new Error(response.status === 429 ? 'RATE_LIMITED' : 'SETTINGS');
        settings = result.settings;
        setSaved(result.settings);
      }
      if (organization && course && batchDirty) {
        const { id: _id, ...payload } = batch;
        const response = await clientFetch('/api/admin/documents', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (response.status === 409) {
          const current = await clientFetch(
            '/api/admin/documents?' + new URLSearchParams({ organization, course }),
            { cache: 'no-store' },
          );
          if (!current.ok) throw new Error('BATCH');
          const latest: EditorData = await current.json();
          setBatch((value) => ({
            ...value,
            version: latest.batch?.version ?? 0,
            id: latest.batch?.id,
          }));
          setSavedBatch(latest.batch);
          setMessage('Протокол уже изменён. Сохраните ещё раз');
          return null;
        }
        if (!response.ok) throw new Error(response.status === 429 ? 'RATE_LIMITED' : 'BATCH');
        nextBatch = result.batch;
        setBatch(result.batch);
        setSavedBatch(result.batch);
      }
      return { settings, batch: nextBatch };
    } catch (error) {
      setMessage(
        error instanceof Error && error.message === 'RATE_LIMITED'
          ? 'Слишком часто, повторите через минуту'
          : 'Не сохранилось, повторите',
      );
      return null;
    }
  }

  async function save() {
    if (busy || loading || !valid) return;
    setBusy(true);
    setMessage('');
    try {
      if (await persist()) setMessage('Сохранено');
    } finally {
      setBusy(false);
    }
  }

  async function exportCompany(single = false) {
    if (busy || loading || !valid || !organization || !course || !batch.number.trim()) return;
    setBusy(true);
    setExporting(true);
    setMessage('');
    const controller = new AbortController();
    exportAbort.current = controller;
    try {
      // A download is the saved document: unsaved edits are saved first.
      const stored = await persist();
      if (!stored) return;
      // Re-read all participants and settings at export time, not the visible table page.
      const [peopleResponse, settingsResponse] = await Promise.all([
        clientFetch('/api/admin/documents?' + new URLSearchParams({ organization, course }), {
          signal: controller.signal,
          cache: 'no-store',
        }),
        clientFetch('/api/admin/settings/certificate', {
          signal: controller.signal,
          cache: 'no-store',
        }),
      ]);
      if (!peopleResponse.ok || !settingsResponse.ok) throw new Error();
      const current: EditorData = await peopleResponse.json();
      const currentSettings: CertificateSettingsView = (await settingsResponse.json()).settings;
      if (
        currentSettings.version !== stored.settings.version ||
        current.batch?.version !== stored.batch?.version
      ) {
        setMessage('Настройки изменились, обновите страницу');
        return;
      }
      const exportBranding = brandingOf(stored.settings, fields, stored.batch ?? batch, profiles);
      const requiresCurrentProtocol =
        (single && tab === 'protocol') ||
        (!single && current.participants.some((person) => !person.certificateId));
      // The wording of every per-listener cell comes from the form the programme
      // belongs to, so a kit no longer stops on a box nobody filled in.
      if (
        requiresCurrentProtocol &&
        profiles.some((profile) => profile.courseSlug === course) &&
        !exportBranding.documentProfile
      ) {
        setMessage('Для этой программы нет профиля документа — откройте реквизиты программы.');
        return;
      }
      const needsSize = single
        ? tab === 'certificate'
        : current.participants.some((p) => p.certificateId);
      if (needsSize && sizeMissing) {
        setMessage('Укажите размер вкладыша');
        setTab('certificate');
        setMobile('fields');
        openSections((open) => open.add('size'));
        return;
      }
      const { generateProtocolInBrowser, groupItemsForProtocols, protocolFilename } =
        await import('@/lib/pdf/protocol-renderer');
      const { generateCertificateInBrowser } = await import('@/lib/pdf/certificate-renderer');
      if (single && tab === 'certificate') {
        if (!selectedCertificate) throw new Error();
        const item = await metadataFor(selectedCertificate, controller.signal);
        download(await generateCertificateInBrowser(item, controller.signal), item.filename);
        return;
      }
      const pendingPeople = current.participants.filter((person) => !person.certificateId);
      const protocol =
        single || pendingPeople.length
          ? await generateProtocolInBrowser(
              {
                organization,
                courseTitle: program,
                items: [],
                participants: single ? current.participants : pendingPeople,
                date: exportBranding.protocolDate,
              },
              exportBranding,
              protocolFontUrl(current.participants),
              controller.signal,
            )
          : null;
      if (single && protocol) {
        setData(current);
        download(protocol, 'Протокол.pdf');
        return;
      }
      const { zipSync } = await import('fflate');
      const { safeFilenameSegment } = await import('@/lib/pdf/certificate');
      const archive: Record<string, Uint8Array> = protocol
        ? { 'Протокол-невыданные.pdf': protocol }
        : {};
      const issuedItems: CertificateRenderMetadata[] = [];
      let count = 0;
      for (const person of current.participants) {
        if (!person.certificateId) continue;
        if (controller.signal.aborted) throw new Error();
        const item = await metadataForKit(person.certificateId, controller.signal, (seconds) =>
          setMessage(`Корочек: ${count}, пауза ${seconds} с`),
        );
        issuedItems.push(item);
        archive['Корочки/' + item.filename] = await generateCertificateInBrowser(
          item,
          controller.signal,
        );
        setMessage('Корочек: ' + ++count);
      }
      for (const group of groupItemsForProtocols(issuedItems)) {
        const frozenBranding = group.items[0]!.branding;
        archive[protocolFilename(group, frozenBranding.protocolNumber)] =
          await generateProtocolInBrowser(
            group,
            frozenBranding,
            protocolFontUrl(current.participants),
            controller.signal,
          );
      }
      download(
        zipSync(archive),
        safeFilenameSegment(organization, 100) + '.zip',
        'application/zip',
      );
      setMessage(`Протокол на ${current.participants.length}, корочек ${count}`);
    } catch (error) {
      setMessage(
        controller.signal.aborted
          ? 'Отменено'
          : error instanceof RetryLater
            ? retryLaterMessage(error)
            : 'Не скачано, повторите',
      );
    } finally {
      setBusy(false);
      setExporting(false);
      exportAbort.current = null;
    }
  }

  function textField(key: TextKey, label: string, multiline = false) {
    const props = {
      value: fields[key],
      maxLength: multiline ? 1000 : key === 'bin' ? 32 : 200,
      'aria-label': label,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setFields((current) => ({ ...current, [key]: event.target.value })),
    };
    return (
      <Field label={label}>
        {multiline ? (
          <Textarea {...props} className={FIELD_TEXTAREA} rows={3} />
        ) : (
          <Input {...props} className={FIELD_INPUT} />
        )}
      </Field>
    );
  }
  function defaultsField(key: DefaultsTextKey, label: string, rows = 1) {
    const props = {
      value: fields.documentDefaults[key],
      maxLength: key === 'protocolText' ? 1000 : key === 'programName' ? 240 : 200,
      'aria-label': label,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDefaults({ [key]: event.target.value }),
    };
    return (
      <Field label={label}>
        {rows > 1 ? (
          <Textarea {...props} className={FIELD_TEXTAREA} rows={rows} />
        ) : (
          <Input {...props} className={FIELD_INPUT} />
        )}
      </Field>
    );
  }

  const working = loading || rendering || metadataLoading;
  // `fresh`: the pages on the screen are the document that would be downloaded, not the one before it.
  const ready = fresh && !previewMessage && !busy && !working && valid && organization && course;
  const commission = fields.documentDefaults.commission;
  const imageSlots: DocumentImageSlot[] = [
    { kind: 'stamp', label: 'Печать', present: saved.hasStamp },
    tab === 'certificate'
      ? { kind: 'chairman', label: 'Подпись', present: saved.hasChairmanSignature }
      : { kind: 'protocol', label: 'Подпись', present: saved.hasProtocolSignature },
  ];
  const missingImages = imageSlots.filter((slot) => !slot.present).map((slot) => slot.label);
  // One entry per signer and per stamp across every program, named by the open program's wording.
  const registry = legacyMode
    ? []
    : buildDocumentAssetRegistry(profiles, assets, branding.documentProfile?.id);
  const withoutPicture = registry.filter((entry) => !entry.assetId);
  const imagesHint = legacyMode
    ? missingImages.length
      ? 'Нет: ' + missingImages.join(', ').toLowerCase()
      : 'Загружены'
    : withoutPicture.length
      ? // A title opens with a person's name, so it keeps its capitals.
        'Нет: ' + withoutPicture.map((entry) => entry.title).join(', ')
      : registry.some((entry) => entry.behind.length)
        ? 'Не во всех программах'
        : 'Загружены';
  const size = fields.documentDefaults;
  const withoutEducation = data.participants.filter((person) => !person.education.trim());
  // What the pages are: a document already issued, which keeps the requisites it was
  // issued with whatever is typed here, or the next one, which the open fields describe.
  const issuance = !selectedPerson ? null : !selectedCertificate ? (
    <Badge>Новая выдача</Badge>
  ) : metadata?.certificateId === selectedCertificate ? (
    <Badge variant="primary" className="min-w-0 [overflow-wrap:anywhere]">
      Выдано {issueDay.format(new Date(metadata.issuedAt))} · № {metadata.certificateNumber}
    </Badge>
  ) : metadataProblem ? null : (
    <span
      aria-hidden="true"
      className="h-7 w-56 max-w-full animate-pulse rounded-full bg-[var(--color-surface-muted)] motion-reduce:animate-none"
    />
  );

  // One set of actions, shown where the hand is: under the thumb on a phone, in the top row on a desktop.
  const actions = (
    <>
      {message ? (
        <p
          role="status"
          className="min-w-0 basis-full px-2 text-sm [overflow-wrap:anywhere] lg:text-right"
        >
          {message}
        </p>
      ) : null}
      <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2 [&>button>span]:min-w-0 [&>button>span]:[overflow-wrap:anywhere]">
        <Button
          size="sm"
          className="h-auto min-h-12 min-w-0 whitespace-normal"
          aria-label="Сохранить настройки"
          disabled={busy || loading || !valid || !(dirty || batchDirty) || !batch.number.trim()}
          onClick={() => void save()}
        >
          <FloppyDisk aria-hidden="true" />
          <span>Сохранить</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-auto min-h-12 min-w-0 bg-[var(--color-surface-muted)] px-3 whitespace-normal"
          aria-label="Скачать PDF"
          title="Скачать PDF"
          disabled={!ready || (tab === 'certificate' && !selectedCertificate)}
          onClick={() => void exportCompany(true)}
        >
          <FilePdf aria-hidden="true" />
          <span>Скачать PDF</span>
        </Button>
        {exporting ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-auto min-h-12 min-w-0 bg-[var(--color-surface-muted)] px-3 whitespace-normal"
            aria-label="Отменить"
            title="Отменить"
            onClick={() => exportAbort.current?.abort()}
          >
            <X aria-hidden="true" />
            <span>Отменить</span>
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-auto min-h-12 min-w-0 bg-[var(--color-surface-muted)] px-3 whitespace-normal"
            aria-label="Скачать комплект компании"
            title="Скачать комплект компании"
            disabled={busy || loading || !valid || !organization || !course}
            onClick={() => void exportCompany()}
          >
            <FileZip aria-hidden="true" />
            <span>Комплект компании</span>
          </Button>
        )}
      </div>
    </>
  );

  return (
    <div
      className="document-editor min-w-0 space-y-4 [&_[role=radio]]:min-h-11 [&_[role=radio]_span]:overflow-visible [&_[role=radio]_span]:break-words [&_[role=radio]_span]:text-clip [&_[role=radio]_span]:whitespace-normal"
      data-hydrated={hydrated ? '' : undefined}
    >
      <div
        data-document-toolbar
        className="-mx-1 flex min-w-0 flex-col gap-2 bg-[var(--color-bg)]/92 px-1 py-2 sm:flex-row sm:flex-wrap sm:items-center"
      >
        <SegmentedControl
          label="Документ"
          className="max-w-full min-w-0 grid-flow-row grid-cols-1 min-[360px]:grid-flow-col min-[360px]:grid-cols-none sm:w-80 sm:flex-none"
          value={tab}
          onChange={setTab}
          options={[
            {
              value: 'certificate',
              label: 'Удостоверение',
              icon: <IdentificationCard aria-hidden="true" className={NARROW_HIDDEN} />,
            },
            {
              value: 'protocol',
              label: 'Протокол',
              icon: <FileText aria-hidden="true" className={NARROW_HIDDEN} />,
            },
          ]}
        />
        <SegmentedControl
          label="Режим"
          className="grid-flow-row grid-cols-1 min-[360px]:grid-flow-col min-[360px]:grid-cols-none lg:hidden"
          value={mobile}
          onChange={setMobile}
          options={[
            {
              // Not «Изменить»: that is the name of the pencil beside the company.
              value: 'fields',
              label: 'Поля',
              icon: <PencilSimple aria-hidden="true" />,
            },
            {
              value: 'preview',
              label: 'Предпросмотр',
              icon: <Eye aria-hidden="true" />,
            },
          ]}
        />
        <div className="hidden min-w-0 grow basis-[32rem] flex-wrap items-center justify-end gap-2 lg:flex">
          {actions}
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
        <fieldset
          disabled={busy}
          className={cn('min-w-0 space-y-4', mobile === 'preview' && 'hidden lg:block')}
        >
          {changeContext ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <DocumentSelect
                label="Компания"
                value={organization}
                options={data.organizations.map((value) => ({ value, label: value }))}
                disabled={busy || canRevertBatch}
                onChange={setOrganization}
              />
              <DocumentSelect
                label="Программа"
                value={course}
                options={data.courses.map((c) => ({ value: c.slug, label: c.title }))}
                disabled={busy || canRevertBatch}
                onChange={setCourse}
              />
              {organization && course ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="justify-self-start"
                  onClick={() => setChangeContext(false)}
                >
                  <Check aria-hidden="true" />
                  Готово
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-semibold break-words">{organization}</p>
                <p className="break-words text-[var(--color-text-muted)]">{program}</p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Изменить"
                title="Изменить"
                onClick={() => setChangeContext(true)}
              >
                <PencilSimple aria-hidden="true" />
              </Button>
            </div>
          )}
          {tab === 'certificate' ||
          ['ptm', 'biot', 'qualification', 'industrial'].includes(
            branding.documentProfile?.family ?? '',
          ) ? (
            <DocumentSelect
              label="Сотрудник"
              value={user}
              options={data.participants.map((p) => ({
                value: p.userId,
                label: p.fullName || 'ФИО не указано',
              }))}
              disabled={busy || loading}
              onChange={(value) => {
                setMetadata(null);
                setUser(value);
              }}
            />
          ) : null}

          {organization &&
          course &&
          data.participants.length > 0 &&
          requiresDocumentEducation(branding.documentProfile?.family) ? (
            <section
              aria-label="Образование для новой выдачи"
              className="min-w-0 text-base break-words"
            >
              {withoutEducation.length ? (
                <details>
                  <summary className="min-h-11 cursor-pointer py-2 font-medium">
                    Образование не заполнено: {withoutEducation.length}
                  </summary>
                  <ul className="space-y-2">
                    {withoutEducation.map((person) => (
                      <li key={person.userId}>
                        <a
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-h-11 items-center underline"
                          href={'/admin/employees?q=' + encodeURIComponent(person.fullName)}
                        >
                          {person.fullName || 'Сотрудник без ФИО'}
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p className="flex min-h-11 items-center font-medium">Образование заполнено</p>
              )}
            </section>
          ) : null}

          {/* Bottom-aligned: a name that wraps in one column does not push its field below the other. */}
          <div className="xs:grid-cols-2 grid min-w-0 items-end gap-3">
            <Field label="Дата протокола">
              <Input
                type="date"
                aria-label="Дата протокола"
                className={FIELD_INPUT}
                value={batch.date}
                onChange={(e) => {
                  if (e.target.value)
                    setBatch((current) => changeDocumentDate(current, e.target.value));
                }}
              />
            </Field>
            <div className="relative min-w-0">
              <Field
                label="Номер протокола"
                state={{ text: NUMBER_FOLLOWS_DATE, on: batch.automatic }}
              >
                <Input
                  aria-label={'Номер протокола' + (batch.automatic ? NUMBER_FOLLOWS_DATE : '')}
                  maxLength={64}
                  className={cn(FIELD_INPUT, canRevertBatch ? 'pr-24' : 'pr-12')}
                  value={batch.number}
                  onChange={(e) =>
                    setBatch((current) => ({
                      ...current,
                      number: e.target.value,
                      automatic: false,
                    }))
                  }
                />
              </Field>
              <div className="absolute right-1 bottom-0 flex h-12 items-center">
                {/* Inside the field's own padding: appearing moves nothing. */}
                {canRevertBatch ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Вернуть сохранённые дату и номер протокола"
                    title="Вернуть сохранённые"
                    onClick={() => savedBatch && setBatch(savedBatch)}
                  >
                    <ArrowCounterClockwise aria-hidden="true" />
                  </Button>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Номер по дате"
                  // The number the press would write, before it is pressed.
                  title={'Номер по дате: ' + numberFromDate(batch.date)}
                  aria-pressed={batch.automatic}
                  className={cn(batch.automatic && 'text-[var(--color-primary)]')}
                  onClick={() =>
                    setBatch((current) => ({
                      ...current,
                      automatic: true,
                      number: numberFromDate(current.date),
                    }))
                  }
                >
                  <ArrowsClockwise aria-hidden="true" />
                </Button>
              </div>
            </div>
          </div>

          <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {branding.documentProfile ? (
              <Section
                icon={<UsersThree aria-hidden="true" />}
                title="Реквизиты программы и комиссия"
                hint={branding.documentProfile.commission.map((person) => person.name).join(', ')}
                open={sections.has('profile')}
                keepMounted
                onToggle={() => toggle('profile')}
              >
                {/* The category follows the position of the person the document is
                    for; it is here rather than in the way because changing it is the
                    exception, not the step. */}
                {profiles.filter((p) => p.courseSlug === course).length > 1 ? (
                  <DocumentSelect
                    label="Категория слушателей"
                    value={branding.documentProfile.id}
                    options={profiles
                      .filter((p) => p.courseSlug === course)
                      .map((p) => ({
                        value: p.id,
                        label: p.label + (p.hours ? ` · ${p.hours} ч` : ''),
                      }))}
                    disabled={busy || loading}
                    onChange={(profileId) => setBatch((current) => ({ ...current, profileId }))}
                  />
                ) : null}
                {/* Keyed by the program alone: a replaced signature moves the revision on, and
                    what is being typed into these fields has to outlive that. */}
                <DocumentProfileFields
                  key={branding.documentProfile.id}
                  profile={branding.documentProfile}
                  onSaved={(profile) =>
                    setProfiles((current) =>
                      current.map((p) => (p.id === profile.id ? profile : p)),
                    )
                  }
                />
              </Section>
            ) : null}

            {selectedPerson ? (
              <Section
                icon={<NotePencil aria-hidden="true" />}
                title="Примечание в протоколе"
                hint={selectedPerson.notes?.trim() || 'Пусто — так и печатается'}
                open={sections.has('note')}
                keepMounted
                onToggle={() => toggle('note')}
              >
                <DocumentNoteField
                  key={selectedPerson.userId + ':' + batch.id}
                  person={selectedPerson}
                  batch={batch}
                  ensureBatch={async () => (await persist())?.batch ?? null}
                  onSaved={(notes, version) => {
                    setBatch((value) => ({ ...value, version }));
                    setSavedBatch((value) => (value ? { ...value, version } : value));
                    setData((value) => ({
                      ...value,
                      participants: value.participants.map((entry) =>
                        entry.userId === selectedPerson.userId ? { ...entry, notes } : entry,
                      ),
                    }));
                  }}
                />
              </Section>
            ) : null}

            <Section
              icon={<Stamp aria-hidden="true" />}
              title="Подписи и печать"
              hint={imagesHint}
              open={sections.has('images')}
              onToggle={() => toggle('images')}
            >
              {legacyMode ? (
                <DocumentImageTiles<CertificateSettingsView>
                  slots={imageSlots}
                  version={saved.version}
                  disabled={busy}
                  onSaved={setSaved}
                />
              ) : (
                <DocumentAssetRegistry
                  entries={registry}
                  disabled={busy}
                  onReplaced={({ asset, profiles: next }) => {
                    setProfiles(next);
                    setAssets((current) =>
                      current.some((known) => known.id === asset.id)
                        ? current
                        : [...current, asset],
                    );
                    // The kept PDFs carry the image that was replaced: the next look draws anew.
                    caches.bytes.clear();
                  }}
                />
              )}
            </Section>

            <Section
              icon={governed ? <Buildings aria-hidden="true" /> : <UsersThree aria-hidden="true" />}
              title={governed ? 'Организация' : 'Организация и комиссия'}
              hint={
                governed
                  ? fields.organizationName
                  : [fields.chairmanName, ...commission.map((member) => member.name)]
                      .filter(Boolean)
                      .join(', ')
              }
              open={sections.has('commission')}
              onToggle={() => toggle('commission')}
            >
              {textField('organizationName', 'Учебная организация')}
              {textField('bin', 'БИН')}
              {governed ? null : (
                <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  {textField('chairmanName', 'Председатель')}
                  {textField('chairmanPosition', 'Должность председателя')}
                </div>
              )}
              {tab === 'protocol' ? defaultsField('reviewerName', 'Проверяющий') : null}
              {governed ? null : (
                <>
                  {commission.map((member, i) => (
                    <div key={i} className="flex min-w-0 items-start gap-1">
                      <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                        <Field label={`Член комиссии ${i + 1}`}>
                          <Input
                            aria-label={`Член комиссии ${i + 1}`}
                            className={FIELD_INPUT}
                            value={member.name}
                            maxLength={200}
                            onChange={(e) => setMember(i, { name: e.target.value })}
                          />
                        </Field>
                        <Field label="Должность">
                          <Input
                            aria-label={`Должность члена комиссии ${i + 1}`}
                            className={FIELD_INPUT}
                            value={member.position}
                            maxLength={200}
                            onChange={(e) => setMember(i, { position: e.target.value })}
                          />
                        </Field>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="mt-1.5 hover:text-[var(--color-danger)]"
                        aria-label={`Удалить члена комиссии ${i + 1}`}
                        title="Удалить"
                        onClick={() =>
                          setDefaults({ commission: commission.filter((_, n) => n !== i) })
                        }
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={commission.length >= 20}
                    aria-label="Добавить участника комиссии"
                    onClick={() =>
                      setDefaults({ commission: [...commission, { name: '', position: '' }] })
                    }
                  >
                    <Plus aria-hidden="true" />
                    Добавить
                  </Button>
                </>
              )}
            </Section>

            {/* The profile owns the protocol's text: with it, this tab has no text left to edit here. */}
            {tab === 'protocol' && governed ? null : (
              <Section
                icon={<TextAa aria-hidden="true" />}
                title={tab === 'certificate' ? 'Тексты удостоверения' : 'Текст протокола'}
                hint={
                  tab === 'certificate' && legacyTerm
                    ? fields.validityMonths
                      ? `Срок действия ${fields.validityMonths} мес.`
                      : 'Без срока действия'
                    : undefined
                }
                alert={!valid}
                open={sections.has('texts')}
                onToggle={() => toggle('texts')}
              >
                {tab === 'certificate' ? (
                  <>
                    {textField('examTextKk', 'Левая сторона, казахский', true)}
                    {textField('examTextRu', 'Левая сторона, русский', true)}
                    {textField('knowledgeTextKk', 'Правая сторона, казахский', true)}
                    {textField('knowledgeTextRu', 'Правая сторона, русский', true)}
                    {legacyTerm ? (
                      <Field label="Срок действия, месяцев (0 — без срока)">
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={120}
                          invalid={!valid}
                          aria-label="Срок действия, месяцев"
                          className={FIELD_INPUT}
                          value={fields.validityMonths}
                          onChange={(e) =>
                            setFields((current) => ({
                              ...current,
                              validityMonths: Number(e.target.value),
                            }))
                          }
                        />
                      </Field>
                    ) : null}
                  </>
                ) : (
                  defaultsField('protocolText', 'Текст протокола', 3)
                )}
                <p className="text-sm break-words text-[var(--color-text-muted)]">
                  {'{program} — программа, {protocol} — номер протокола'}
                </p>
                {defaultsField('companyName', 'Компания образца', 2)}
                {defaultsField('programName', 'Программа образца')}
              </Section>
            )}

            {tab === 'certificate' ? (
              <Section
                icon={<Ruler aria-hidden="true" />}
                title="Размер вкладыша"
                hint={
                  sizeProblem
                    ? insertSizeMessage(sizeProblem)
                    : sizeMissing
                      ? 'Не задан'
                      : `${size.insertWidthCm} × ${size.insertHeightCm} см`
                }
                alert={sizeMissing || Boolean(sizeProblem)}
                open={sections.has('size')}
                onToggle={() => toggle('size')}
              >
                <div className="xs:grid-cols-2 grid min-w-0 items-end gap-3">
                  {(['insertWidthCm', 'insertHeightCm'] as const).map((key) => {
                    // The whole open spread, both halves together: the name says which width is meant.
                    const label =
                      key === 'insertWidthCm' ? 'Общая ширина разворота, см' : 'Высота, см';
                    return (
                      <Field key={key} label={label}>
                        <Input
                          ref={(element) => {
                            sizeInputs.current[key] = element;
                          }}
                          type="number"
                          inputMode="decimal"
                          step="0.1"
                          min={INSERT_SIZE_LIMITS[key][0]}
                          max={INSERT_SIZE_LIMITS[key][1]}
                          aria-label={label}
                          invalid={sizeProblem === key}
                          className={FIELD_INPUT}
                          value={size[key] ?? ''}
                          onChange={(e) =>
                            setDefaults({
                              [key]: e.target.value === '' ? null : Number(e.target.value),
                            })
                          }
                        />
                      </Field>
                    );
                  })}
                </div>
              </Section>
            ) : null}
          </div>
        </fieldset>

        <section
          data-document-preview
          aria-label="Предпросмотр документа"
          className={cn(
            'min-w-0 space-y-2 lg:sticky lg:top-16',
            mobile === 'fields' && 'hidden lg:block',
          )}
        >
          {tab === 'certificate' ? (
            // As tall as the chip at its longest, on two lines of a phone, whoever is
            // chosen: the pages under it stay where they are when the chip arrives.
            <div role="status" className="flex min-h-12 min-w-0 items-center">
              {issuance}
            </div>
          ) : null}
          {tab === 'certificate' ? (
            // Side by side at every width, like the halves themselves: a long name wraps inside its half.
            <SegmentedControl
              label="Половина разворота"
              className="lg:hidden"
              value={half}
              onChange={setHalf}
              options={[
                { value: 'left', label: 'Левая половина' },
                { value: 'right', label: 'Правая половина' },
              ]}
            />
          ) : null}
          <div
            className="relative min-h-24 rounded-[var(--radius-group)] bg-[var(--color-surface-soft)] p-2 sm:p-3 lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto"
            onTouchStart={(event) => {
              const touch = event.touches[0];
              swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
            }}
            onTouchEnd={(event) => {
              const from = swipeStart.current;
              const to = event.changedTouches[0];
              swipeStart.current = null;
              if (tab !== 'certificate' || !from || !to) return;
              const dx = to.clientX - from.x;
              const dy = to.clientY - from.y;
              // Scrolling the page with a thumb drifts sideways; a swipe is mostly horizontal.
              if (Math.abs(dx) > 48 && Math.abs(dx) > 2 * Math.abs(dy))
                setHalf(dx < 0 ? 'right' : 'left');
            }}
          >
            <div className="overflow-hidden">
              <div
                className={
                  tab === 'certificate'
                    ? cn('document-insert', half === 'right' && 'document-insert-right')
                    : undefined
                }
              >
                <DocumentPdfPreview bytes={bytes} pending={pending} />
              </div>
            </div>
            {working ? (
              <span
                role="status"
                aria-label="Обновляем документ"
                className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-full bg-[var(--color-surface)] shadow-[var(--shadow-soft)]"
              >
                <span className="size-4 animate-spin rounded-full border-2 border-[var(--color-primary)] border-r-transparent motion-reduce:animate-none" />
              </span>
            ) : null}
            {previewMessage ? (
              <div className="flex flex-wrap items-center gap-2 p-2 text-sm">
                <p role="status" className="min-w-0 flex-1">
                  {previewMessage}
                </p>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Повторить предпросмотр"
                  title="Повторить"
                  onClick={() => {
                    // «Повторить» means «ask the server again», not «show me the same failure».
                    caches.bytes.delete(key);
                    if (lastPhotoUrl.current) caches.photos.delete(lastPhotoUrl.current);
                    if (selectedCertificate) caches.metadata.delete(selectedCertificate);
                    setPreviewRetry((value) => value + 1);
                  }}
                >
                  <ArrowsClockwise aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </div>
          {tab === 'certificate' && selectedPerson ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm text-[var(--color-text-muted)]">
              {selectedPerson.photoUrl ? null : <p role="status">Нет фотографии в профиле</p>}
              {fresh && shown?.photoFailed ? <p role="status">Фото не загрузилось</p> : null}
              <a
                className="ml-auto inline-flex min-h-11 items-center gap-1.5 font-semibold text-[var(--color-text)] hover:underline"
                href={'/admin/employees?q=' + encodeURIComponent(selectedPerson.fullName)}
              >
                Карточка сотрудника
                <ArrowSquareOut aria-hidden="true" size={16} />
              </a>
            </div>
          ) : null}
        </section>
      </div>

      <div className="lg:hidden">
        <div className="glass-strong flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--radius-group)] p-2 shadow-[var(--shadow-pop)]">
          {actions}
        </div>
      </div>
    </div>
  );
}
