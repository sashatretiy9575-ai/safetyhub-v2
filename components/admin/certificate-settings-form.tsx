'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  Check,
  Eye,
  FilePdf,
  FileText,
  FileZip,
  FloppyDisk,
  IdentificationCard,
  PencilSimple,
  Plus,
  Ruler,
  Stamp,
  TextAa,
  Trash,
  UsersThree,
  X,
} from '@phosphor-icons/react';
import {
  DocumentImageTiles,
  type DocumentImageSlot,
} from '@/components/admin/document-image-tiles';
import { DocumentPdfPreview } from '@/components/admin/document-pdf-preview';
import { DocumentSelect } from '@/components/admin/document-select';
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
  INSERT_SIZE_LIMITS,
  changeDocumentDate,
  insertSizeProblem,
  newDocumentBatch,
  numberFromDate,
  type DocumentBatch,
  type DocumentDefaults,
  type InsertSizeKey,
} from '@/lib/pdf/document-editor';
import { cn } from '@/lib/utils';
import type { readDocumentEditor } from '@/server/certificates/document-editor';
import { applyDocumentProfile, type DocumentProfile } from '@/lib/pdf/document-profile';
import { DocumentProfileFields } from '@/components/admin/document-profile-fields';
import { requiresDocumentEducation } from '@/lib/pdf/document-education';
import { DocumentParticipantFields } from '@/components/admin/document-participant-fields';

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
const SECTION_IDS = ['images', 'commission', 'texts', 'size'] as const;
type SectionId = (typeof SECTION_IDS)[number];
const SECTIONS_KEY = 'document-editor-sections';
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
  const profile =
    profiles.find((p) => p.id === batch.profileId) ??
    profiles.find((p) => p.courseSlug === batch.courseSlug && p.audience === 'all');
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

async function metadataFor(id: string, signal?: AbortSignal): Promise<CertificateRenderMetadata> {
  const response = await clientFetch(`/api/certificates/${id}/metadata`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('CERTIFICATE_UNAVAILABLE');
  const data: unknown = await response.json();
  assertCertificateRenderMetadata(data);
  return data;
}

/** Why a filled-in side of the insert is refused, with the limits the administrator can act on. */
const insertSizeMessage = (key: InsertSizeKey) =>
  `${key === 'insertWidthCm' ? 'Общая ширина' : 'Высота'} вкладыша: от ${INSERT_SIZE_LIMITS[key][0]} до ${INSERT_SIZE_LIMITS[key][1]} см`;

const protocolFontUrl = (people: EditorData['participants']) =>
  '/certificate-assets/font?locale=' +
  (people.some((person) => /[㐀-鿿]/u.test(person.fullName)) ? 'zh&v=Sans2.005' : 'ru&v=1');

/** The name of a field lives inside the field, above what is typed into it. */
function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn('grid min-w-0 gap-1.5', className)}>
      <span className="text-sm break-words text-[var(--color-text-muted)]">{label}</span>
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
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  alert?: boolean;
  open: boolean;
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
        {open ? children : null}
      </div>
    </section>
  );
}

export function CertificateSettingsForm({
  initialSettings,
  initialData,
  profiles: initialProfiles = [],
  initialSelection = {},
}: {
  initialSettings: CertificateSettingsView;
  initialData: EditorData;
  profiles?: readonly DocumentProfile[];
  initialSelection?: { organization?: string; course?: string; user?: string; tab?: string };
}) {
  const initialCourse =
    initialData.courses.find(
      (c) => c.slug === initialSelection.course || c.id === initialSelection.course,
    )?.slug ?? '';
  const [saved, setSaved] = useState(initialSettings);
  const [profiles, setProfiles] = useState(initialProfiles);
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
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [message, setMessage] = useState('');
  const [previewMessage, setPreviewMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const exportAbort = useRef<AbortController | null>(null);
  const swipeStart = useRef<number | null>(null);
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
  const branding = brandingOf(saved, fields, batch, profiles);
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
  const switchTab = (next: DocumentTab) => {
    if (next === tab) return;
    setBytes(null);
    setTab(next);
  };

  const loadedSelection = useRef(JSON.stringify([organization, course]));
  useEffect(() => {
    const selection = JSON.stringify([organization, course]);
    if (loadedSelection.current === selection) return;
    const controller = new AbortController();
    setLoading(true);
    setBytes(null);
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
  }, [organization, course]);

  useEffect(() => {
    const controller = new AbortController();
    setMetadata(null);
    setMetadataLoading(Boolean(selectedCertificate));
    if (selectedCertificate) {
      void metadataFor(selectedCertificate, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setMetadata(value);
        })
        .catch(() => {
          if (!controller.signal.aborted) setPreviewMessage('Удостоверение недоступно');
        })
        .finally(() => {
          if (!controller.signal.aborted) setMetadataLoading(false);
        });
    }
    return () => controller.abort();
  }, [selectedCertificate, previewRetry]);

  const renderKey = JSON.stringify({
    branding,
    people: data.participants,
    metadata,
    program,
    organization,
    tab,
    loading,
    user,
    batch,
    previewRetry,
  });
  useEffect(() => {
    const controller = new AbortController();
    setRendering(true);
    setPreviewMessage('');
    const timer = setTimeout(() => {
      void (async () => {
        if (loading) return null;
        if (tab === 'certificate') {
          if (!selectedPerson) {
            setPreviewMessage('Выберите компанию, программу и сотрудника');
            return null;
          }
          if (sizeProblem) {
            setPreviewMessage(insertSizeMessage(sizeProblem));
            return null;
          }
          if (
            selectedCertificate &&
            (!metadata || metadata.certificateId !== selectedCertificate)
          ) {
            return null;
          }
          const { generateCertificatePreview } = await import('@/lib/pdf/certificate-renderer');
          const draft = {
            schemaVersion: 1 as const,
            filename: 'Предпросмотр.pdf',
            locale: 'ru' as const,
            templateVersion: 1,
            templateUrl: '/certificate-assets/template',
            fontUrl: '/certificate-assets/font?locale=ru&v=1',
            fullName: selectedPerson.fullName,
            position: selectedPerson.position,
            organization,
            titleSnapshot: program,
            photoUrl: selectedPerson.photoUrl,
            score: selectedPerson.score ?? 0,
            total: selectedPerson.total ?? 0,
            passScore: 0,
            certificateNumber: 'ПРЕДПРОСМОТР',
            completedAt: batch.date,
            issuedAt: batch.date + 'T12:00:00+05:00',
            branding,
          };
          return generateCertificatePreview(metadata ?? draft, controller.signal);
        }
        const { generateProtocolInBrowser } = await import('@/lib/pdf/protocol-renderer');
        return generateProtocolInBrowser(
          {
            organization: organization || fields.documentDefaults.companyName,
            courseTitle: program,
            date: batch.date,
            items: [],
            participants: data.participants,
          },
          branding,
          protocolFontUrl(data.participants),
          controller.signal,
        );
      })()
        .then((result) => {
          if (!controller.signal.aborted && result) setBytes(result);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setPreviewMessage(
            error instanceof Error && error.message === 'DOCUMENT_TEXT_OVERFLOW'
              ? 'Текст не помещается: сократите тексты или состав комиссии'
              : 'PDF не сформирован',
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setRendering(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // The serialized key tracks the complete render input, including unsaved fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey]);

  /** Says which side of the insert is wrong and opens its field, wherever the administrator is. */
  function refuseSize(key: InsertSizeKey) {
    setMessage(insertSizeMessage(key));
    switchTab('certificate');
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
      if (
        requiresCurrentProtocol &&
        profiles.some((profile) => profile.courseSlug === course) &&
        !exportBranding.documentProfile
      ) {
        setMessage('Выберите категорию слушателей для протокола.');
        return;
      }
      if (requiresCurrentProtocol && exportBranding.documentProfile) {
        const profile = exportBranding.documentProfile;
        const people = single
          ? current.participants
          : current.participants.filter((person) => !person.certificateId);
        if (
          profile.family === 'biot' &&
          (!profile.orderNumber.trim() || !profile.orderDate || !profile.verificationKind.trim())
        ) {
          setMessage('Заполните номер и дату приказа, вид проверки знаний в реквизитах программы.');
          return;
        }
        const missing =
          profile.family === 'ptm'
            ? people.find((person) => !person.trainingReason.trim())
            : profile.family === 'qualification'
              ? people.find((person) => !person.qualificationDecision.trim())
              : null;
        if (missing) {
          setMessage(
            `${missing.fullName}: ${profile.family === 'ptm' ? 'укажите причину обучения' : 'внесите решение квалификационной комиссии'}.`,
          );
          return;
        }
        if (profile.family === 'industrial') {
          const unverified = people.find(
            (person) =>
              !person.formalExamReference.trim() ||
              !person.formalExamDate ||
              person.formalExamResult !== 'passed' ||
              person.formalExamProfileId !== profile.id ||
              person.formalExamProfileVersion !== profile.revision,
          );
          if (unverified) {
            setMessage(
              `${unverified.fullName}: внесите подтверждённые реквизиты отдельного экзамена по промбезу.`,
            );
            return;
          }
        }
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
        const result = await generateCertificateInBrowser(item, controller.signal);
        setBytes(result);
        download(result, item.filename);
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
        setBytes(protocol);
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
        const item = await metadataFor(person.certificateId, controller.signal);
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
    } catch {
      setMessage(controller.signal.aborted ? 'Отменено' : 'Не скачано, повторите');
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
  const ready =
    Boolean(bytes) && !previewMessage && !busy && !working && valid && organization && course;
  const commission = fields.documentDefaults.commission;
  const imageSlots: DocumentImageSlot[] = [
    { kind: 'stamp', label: 'Печать', present: saved.hasStamp },
    tab === 'certificate'
      ? { kind: 'chairman', label: 'Подпись', present: saved.hasChairmanSignature }
      : { kind: 'protocol', label: 'Подпись', present: saved.hasProtocolSignature },
  ];
  const missingImages = imageSlots.filter((slot) => !slot.present).map((slot) => slot.label);
  const size = fields.documentDefaults;

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
          variant="outline"
          className="h-auto min-h-12 min-w-0 px-3 whitespace-normal"
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
            variant="outline"
            className="h-auto min-h-12 min-w-0 px-3 whitespace-normal"
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
            variant="outline"
            className="h-auto min-h-12 min-w-0 px-3 whitespace-normal"
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
          label="Вид документа"
          className="xs:grid-flow-col xs:grid-cols-none max-w-full min-w-0 grid-flow-row grid-cols-1 sm:w-80 sm:flex-none"
          value={tab}
          onChange={switchTab}
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
          className="xs:grid-flow-col xs:grid-cols-none grid-flow-row grid-cols-1 lg:hidden"
          value={mobile}
          onChange={setMobile}
          options={[
            {
              value: 'fields',
              label: 'Изменить',
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
                setBytes(null);
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
              className="min-w-0 rounded-xl border border-[var(--color-border)] p-3 text-base break-words"
            >
              <p>Образование нужно для новой выдачи этой формы.</p>
              {data.participants.filter((person) => !person.education.trim()).length ? (
                <details className="mt-2">
                  <summary className="min-h-11 cursor-pointer py-2 font-medium">
                    Не заполнено:{' '}
                    {data.participants.filter((person) => !person.education.trim()).length}
                  </summary>
                  <ul className="space-y-2">
                    {data.participants
                      .filter((person) => !person.education.trim())
                      .map((person) => (
                        <li key={person.userId}>
                          <a
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-11 items-center underline"
                            href={'/admin/employees?q=' + encodeURIComponent(person.fullName)}
                          >
                            {person.fullName || 'Сотрудник без ФИО'} — заполнить данные
                          </a>
                        </li>
                      ))}
                  </ul>
                </details>
              ) : (
                <p className="mt-1 text-sm">У участников заполнено.</p>
              )}
            </section>
          ) : null}

          {profiles.some((p) => p.courseSlug === course) ? (
            <DocumentSelect
              label="Программа и категория слушателей"
              value={
                batch.profileId ??
                profiles.find((p) => p.courseSlug === course && p.audience === 'all')?.id ??
                ''
              }
              options={profiles
                .filter((p) => p.courseSlug === course)
                .map((p) => ({ value: p.id, label: p.label + (p.hours ? ` · ${p.hours} ч` : '') }))}
              disabled={busy || loading}
              onChange={(profileId) => {
                setBatch((current) => ({ ...current, profileId }));
                setBytes(null);
              }}
            />
          ) : null}

          {selectedPerson &&
          branding.documentProfile &&
          ['ptm', 'biot', 'qualification', 'industrial'].includes(
            branding.documentProfile.family,
          ) ? (
            <DocumentParticipantFields
              key={selectedPerson.userId + ':' + batch.id}
              person={selectedPerson}
              family={branding.documentProfile.family}
              batch={batch}
              onSaved={(fields, version) => {
                setBatch((v) => ({ ...v, version }));
                setSavedBatch((v) => (v ? { ...v, version } : v));
                setData((v) => ({
                  ...v,
                  participants: v.participants.map((p) =>
                    p.userId === selectedPerson.userId ? { ...p, ...fields } : p,
                  ),
                }));
                setBytes(null);
              }}
            />
          ) : null}
          <div className="xs:grid-cols-2 grid min-w-0 gap-3">
            <Field label="Дата">
              <Input
                type="date"
                aria-label="Дата"
                className={FIELD_INPUT}
                value={batch.date}
                onChange={(e) => {
                  if (e.target.value)
                    setBatch((current) => changeDocumentDate(current, e.target.value));
                }}
              />
            </Field>
            <div className="relative min-w-0">
              <Field label="Номер">
                <Input
                  aria-label="Номер"
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
                    aria-label="Вернуть сохранённые дату и номер"
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
                  title="Номер по дате"
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

          {branding.documentProfile ? (
            <DocumentProfileFields
              key={branding.documentProfile.id + ':' + branding.documentProfile.revision}
              profile={branding.documentProfile}
              onSaved={(profile) => {
                setProfiles((current) => current.map((p) => (p.id === profile.id ? profile : p)));
                setBytes(null);
              }}
            />
          ) : null}
          <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            <Section
              icon={<Stamp aria-hidden="true" />}
              title="Печать и подпись"
              hint={
                missingImages.length
                  ? 'Нет: ' + missingImages.join(', ').toLowerCase()
                  : 'Загружены'
              }
              open={sections.has('images')}
              onToggle={() => toggle('images')}
            >
              <DocumentImageTiles<CertificateSettingsView>
                slots={imageSlots}
                version={saved.version}
                disabled={busy}
                onSaved={setSaved}
              />
            </Section>

            <Section
              icon={<UsersThree aria-hidden="true" />}
              title="Организация и комиссия"
              hint={[fields.chairmanName, ...commission.map((member) => member.name)]
                .filter(Boolean)
                .join(', ')}
              open={sections.has('commission')}
              onToggle={() => toggle('commission')}
            >
              {textField('organizationName', 'Учебная организация')}
              {textField('bin', 'БИН')}
              <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {textField('chairmanName', 'Председатель')}
                {textField('chairmanPosition', 'Должность председателя')}
              </div>
              {tab === 'protocol' ? defaultsField('reviewerName', 'Проверяющий') : null}
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
            </Section>

            <Section
              icon={<TextAa aria-hidden="true" />}
              title={tab === 'certificate' ? 'Тексты удостоверения' : 'Текст протокола'}
              hint={
                tab === 'certificate'
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
                <div className="xs:grid-cols-2 grid min-w-0 gap-3">
                  {(['insertWidthCm', 'insertHeightCm'] as const).map((key) => {
                    const label = key === 'insertWidthCm' ? 'Общая ширина, см' : 'Высота, см';
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
                <p className="text-sm break-words text-[var(--color-text-muted)]">
                  Вкладыш в развёрнутом виде, обе половины вместе
                </p>
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
          {tab === 'certificate' && selectedCertificate ? (
            <p className="text-sm break-words text-[var(--color-text-muted)]">
              Выданный документ сохраняет прежние реквизиты. Изменения применяются при новой выдаче.
            </p>
          ) : null}
          {tab === 'certificate' ? (
            <SegmentedControl
              label="Сторона удостоверения"
              className="lg:hidden"
              value={half}
              onChange={setHalf}
              options={[
                { value: 'left', label: 'Левая' },
                { value: 'right', label: 'Правая' },
              ]}
            />
          ) : null}
          <div
            className="relative min-h-24 rounded-[var(--radius-group)] bg-[var(--color-surface-soft)] p-2 sm:p-3 lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto"
            onTouchStart={(event) => {
              swipeStart.current = event.touches[0]?.clientX ?? null;
            }}
            onTouchEnd={(event) => {
              const from = swipeStart.current;
              const to = event.changedTouches[0]?.clientX;
              swipeStart.current = null;
              if (tab !== 'certificate' || from === null || to === undefined) return;
              if (to - from < -48) setHalf('right');
              if (to - from > 48) setHalf('left');
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
                <DocumentPdfPreview bytes={bytes} />
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
                  onClick={() => setPreviewRetry((value) => value + 1)}
                >
                  <ArrowsClockwise aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </div>
          {tab === 'certificate' && selectedPerson ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm text-[var(--color-text-muted)]">
              {selectedCertificate ? null : <p role="status">Удостоверение ещё не выдано</p>}
              {selectedPerson.photoUrl ? null : <p role="status">Нет фотографии в профиле</p>}
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
