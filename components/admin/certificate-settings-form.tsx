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
  changeDocumentDate,
  newDocumentBatch,
  numberFromDate,
  type DocumentBatch,
  type DocumentDefaults,
} from '@/lib/pdf/document-editor';
import { cn } from '@/lib/utils';
import type { readDocumentEditor } from '@/server/certificates/document-editor';

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
): CertificateBranding {
  const image = (kind: 'stamp' | 'chairman' | 'protocol', present: boolean) =>
    present ? certificateImageUrl(kind, saved.version) : null;
  return {
    ...saved,
    ...fields,
    protocolNumber: batch.number,
    protocolDate: batch.date,
    stampUrl: image('stamp', saved.hasStamp),
    chairmanSignatureUrl: image('chairman', saved.hasChairmanSignature),
    memberSignatureUrl: null,
    protocolSignatureUrl: image('protocol', saved.hasProtocolSignature),
  };
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
    <label className={cn('relative block min-w-0', className)}>
      <span className="pointer-events-none absolute top-1.5 right-4 left-4 z-10 truncate text-xs text-[var(--color-text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
const FIELD_INPUT = 'h-14 pt-5';
/** A 240 px screen has room for the word or for the icon, not for both. */
const NARROW_HIDDEN = 'hidden min-[280px]:inline';
const FIELD_TEXTAREA = 'pt-6';

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
          <span className="block text-sm font-semibold break-words">{title}</span>
          {hint ? (
            <span
              className={cn(
                'block truncate text-xs',
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
  initialSelection = {},
}: {
  initialSettings: CertificateSettingsView;
  initialData: EditorData;
  initialSelection?: { organization?: string; course?: string; user?: string; tab?: string };
}) {
  const initialCourse =
    initialData.courses.find(
      (c) => c.slug === initialSelection.course || c.id === initialSelection.course,
    )?.slug ?? '';
  const [saved, setSaved] = useState(initialSettings);
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
  useEffect(() => () => exportAbort.current?.abort(), []);
  // Whatever was open stays open across a reload: the administrator is in the middle of it.
  useEffect(() => {
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
  const canRevertBatch = batchDirty && Boolean(savedBatch);
  const branding = brandingOf(saved, fields, batch);
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
          return generateCertificatePreview(
            { ...(metadata ?? draft), branding },
            controller.signal,
          );
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

  /** Saves whatever is unsaved and returns what the server now holds, or null on failure. */
  async function persist(): Promise<{
    settings: CertificateSettingsView;
    batch: DocumentBatch | null;
  } | null> {
    let settings = saved;
    let nextBatch = savedBatch;
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
      const exportBranding = brandingOf(stored.settings, fields, stored.batch ?? batch);
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
      const { generateProtocolInBrowser } = await import('@/lib/pdf/protocol-renderer');
      const { generateCertificateInBrowser } = await import('@/lib/pdf/certificate-renderer');
      if (single && tab === 'certificate') {
        if (!selectedCertificate) throw new Error();
        const item = await metadataFor(selectedCertificate, controller.signal);
        const result = await generateCertificateInBrowser(
          { ...item, branding: exportBranding },
          controller.signal,
        );
        setBytes(result);
        download(result, item.filename);
        return;
      }
      const protocol = await generateProtocolInBrowser(
        {
          organization,
          courseTitle: program,
          items: [],
          participants: current.participants,
          date: exportBranding.protocolDate,
        },
        exportBranding,
        protocolFontUrl(current.participants),
        controller.signal,
      );
      if (single) {
        setData(current);
        setBytes(protocol);
        download(protocol, 'Протокол.pdf');
        return;
      }
      const { zipSync } = await import('fflate');
      const { safeFilenameSegment } = await import('@/lib/pdf/certificate');
      const archive: Record<string, Uint8Array> = { 'Протокол.pdf': protocol };
      let count = 0;
      for (const person of current.participants) {
        if (!person.certificateId) continue;
        if (controller.signal.aborted) throw new Error();
        const item = await metadataFor(person.certificateId, controller.signal);
        archive['Корочки/' + item.filename] = await generateCertificateInBrowser(
          { ...item, branding: exportBranding },
          controller.signal,
        );
        setMessage('Корочек: ' + ++count);
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
      <p
        role="status"
        className={cn(
          'min-w-0 flex-1 basis-full px-2 text-sm sm:basis-0 lg:text-right',
          !message && 'hidden sm:block',
        )}
      >
        {message}
      </p>
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
        <Button
          size="sm"
          className="min-w-0 flex-1 sm:flex-none"
          aria-label="Сохранить настройки"
          disabled={busy || loading || !valid || !(dirty || batchDirty) || !batch.number.trim()}
          onClick={() => void save()}
        >
          <FloppyDisk aria-hidden="true" />
          <span className={NARROW_HIDDEN}>Сохранить</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="xs:w-auto xs:px-4 w-11 shrink-0 px-0"
          aria-label="Скачать PDF"
          title="Скачать PDF"
          disabled={!ready || (tab === 'certificate' && !selectedCertificate)}
          onClick={() => void exportCompany(true)}
        >
          <FilePdf aria-hidden="true" />
          <span className="xs:inline hidden">PDF</span>
        </Button>
        {exporting ? (
          <Button
            size="sm"
            variant="outline"
            className="xs:w-auto xs:px-4 w-11 shrink-0 px-0"
            aria-label="Отменить"
            title="Отменить"
            onClick={() => exportAbort.current?.abort()}
          >
            <X aria-hidden="true" />
            <span className="xs:inline hidden">Отменить</span>
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="xs:w-auto xs:px-4 w-11 shrink-0 px-0"
            aria-label="Скачать комплект компании"
            title="Скачать комплект компании"
            disabled={busy || loading || !valid || !organization || !course}
            onClick={() => void exportCompany()}
          >
            <FileZip aria-hidden="true" />
            <span className="xs:inline hidden">Комплект</span>
          </Button>
        )}
      </div>
    </>
  );

  return (
    <div className="document-editor min-w-0 space-y-4">
      <div className="sticky top-[calc(3.5rem+var(--safe-area-top))] z-[var(--z-sticky)] -mx-1 flex min-w-0 flex-col gap-2 bg-[var(--color-bg)]/92 px-1 py-2 backdrop-blur-xl min-[280px]:flex-row min-[280px]:items-center lg:top-0">
        <SegmentedControl
          label="Вид документа"
          className="min-[280px]:flex-1 sm:max-w-sm"
          value={tab}
          onChange={switchTab}
          options={[
            {
              value: 'certificate',
              label: 'Корочка',
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
          className="lg:hidden"
          value={mobile}
          onChange={setMobile}
          options={[
            {
              value: 'fields',
              label: 'Поля',
              icon: <PencilSimple aria-hidden="true" />,
              labelHidden: 'compact',
            },
            {
              value: 'preview',
              label: 'Предпросмотр',
              icon: <Eye aria-hidden="true" />,
              labelHidden: 'compact',
            },
          ]}
        />
        <div className="hidden min-w-0 flex-1 items-center justify-end gap-2 lg:flex">
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
          {tab === 'certificate' ? (
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
              <div className="absolute inset-y-0 right-1 flex items-center">
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
              title={tab === 'certificate' ? 'Тексты корочки' : 'Текст протокола'}
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
              <p className="text-xs text-[var(--color-text-muted)]">
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
                  sizeMissing ? 'Не задан' : `${size.insertWidthCm} × ${size.insertHeightCm} см`
                }
                alert={sizeMissing}
                open={sections.has('size')}
                onToggle={() => toggle('size')}
              >
                <div className="grid min-w-0 grid-cols-2 gap-3">
                  {(['insertWidthCm', 'insertHeightCm'] as const).map((key) => {
                    const label = key === 'insertWidthCm' ? 'Общая ширина, см' : 'Высота, см';
                    return (
                      <Field key={key} label={label}>
                        <Input
                          type="number"
                          inputMode="decimal"
                          step="0.1"
                          min={key === 'insertWidthCm' ? 8 : 4}
                          max={key === 'insertWidthCm' ? 60 : 30}
                          aria-label={label}
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
          aria-label="Предпросмотр документа"
          className={cn(
            'min-w-0 space-y-2 lg:sticky lg:top-16',
            mobile === 'fields' && 'hidden lg:block',
          )}
        >
          {tab === 'certificate' ? (
            <SegmentedControl
              label="Сторона корочки"
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

      <div className="sticky bottom-[calc(var(--mobile-tab-height)+var(--safe-area-bottom)+1rem)] z-[var(--z-sticky)] lg:hidden">
        <div className="glass-strong flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--radius-group)] p-2 shadow-[var(--shadow-pop)]">
          {actions}
        </div>
      </div>
    </div>
  );
}
