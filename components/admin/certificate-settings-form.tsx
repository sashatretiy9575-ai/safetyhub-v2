'use client';


import { useEffect, useRef, useState } from 'react';
import { Plus, Trash, CaretDown } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { clientFetch } from '@/lib/client-request';
import type { CertificateBranding, CertificateRenderMetadata } from '@/lib/pdf/certificate-client-contract';
import { assertCertificateRenderMetadata } from '@/lib/pdf/certificate-client-contract';
import { changeDocumentDate, newDocumentBatch, numberFromDate, type DocumentBatch, type DocumentDefaults } from '@/lib/pdf/document-editor';
import type { readDocumentEditor } from '@/server/certificates/document-editor';

export type CertificateSettingsView = {
  organizationName: string; bin: string; chairmanName: string; chairmanPosition: string;
  memberName: string; memberPosition: string; secondMemberName: string; secondMemberPosition: string;
  protocolNumber: string; validityMonths: number; examTextKk: string; examTextRu: string;
  knowledgeTextKk: string; knowledgeTextRu: string;
  documentDefaults: DocumentDefaults;
  hasStamp: boolean; hasChairmanSignature: boolean; hasMemberSignature: boolean; version: number; updatedAt: string;
};
type EditorData = Awaited<ReturnType<typeof readDocumentEditor>>;
type SettingsFields = Pick<CertificateSettingsView, 'organizationName' | 'bin' | 'chairmanName' | 'chairmanPosition' | 'validityMonths' | 'examTextKk' | 'examTextRu' | 'knowledgeTextKk' | 'knowledgeTextRu' | 'documentDefaults'>;
function fieldsOf(settings: CertificateSettingsView): SettingsFields {
  const { organizationName, bin, chairmanName, chairmanPosition, validityMonths, examTextKk, examTextRu, knowledgeTextKk, knowledgeTextRu, documentDefaults } = settings;
  return { organizationName, bin, chairmanName, chairmanPosition, validityMonths, examTextKk, examTextRu, knowledgeTextKk, knowledgeTextRu, documentDefaults };
}
function download(bytes: Uint8Array, filename: string, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
async function metadataFor(id: string, signal?: AbortSignal): Promise<CertificateRenderMetadata> {
  const response = await clientFetch(`/api/certificates/${id}/metadata`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('CERTIFICATE_UNAVAILABLE');
  const data: unknown = await response.json(); assertCertificateRenderMetadata(data); return data;
}

function PdfPreview({ bytes }: { bytes: Uint8Array | null }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    if (!bytes) { container.replaceChildren(); return; }
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false });
      dispose = () => { void task.destroy(); };
      const pdf = await task.promise;
      const fragment = document.createDocumentFragment();
      for (let pageNumber = 1; pageNumber <= pdf.numPages && !cancelled; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) break;
        const canvas = document.createElement('canvas');
        const viewport = page.getViewport({ scale: 1.4 });
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        canvas.style.width = '100%'; canvas.style.height = 'auto';
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Страница ' + pageNumber);
        fragment.appendChild(canvas);
        await page.render({ canvas, viewport }).promise;
      }
      if (!cancelled) { container.replaceChildren(fragment); setError(''); }
    })().catch(() => { if (!cancelled) setError('Предпросмотр не загрузился. Повторите изменение поля.'); });
    return () => { cancelled = true; dispose?.(); };
  }, [bytes]);
  return <><div ref={host} className="space-y-4" />{error && <p role="alert">{error}</p>}</>;
}

export function CertificateSettingsForm({ initialSettings, initialData, initialSelection = {} }: {
  initialSettings: CertificateSettingsView; initialData: EditorData;
  initialSelection?: { organization?: string; course?: string; user?: string; tab?: string };
}) {
  const [saved, setSaved] = useState(initialSettings);
  const [fields, setFields] = useState(() => fieldsOf(initialSettings));
  const [data, setData] = useState(initialData);
  const [organization, setOrganization] = useState(initialSelection.organization ?? '');
  const [course, setCourse] = useState(() => initialData.courses.find(c => c.slug === initialSelection.course || c.id === initialSelection.course)?.slug ?? '');
  const [user, setUser] = useState(initialSelection.user ?? initialData.participants[0]?.userId ?? '');
  const [tab, setTab] = useState<'protocol' | 'certificate'>(initialSelection.tab === 'certificate' ? 'certificate' : 'protocol');
  const [mobile, setMobile] = useState<'fields' | 'preview'>('fields');
  const [half, setHalf] = useState<'left' | 'right'>('left');
  const [changeContext, setChangeContext] = useState(!initialSelection.organization || !initialSelection.course);
  const [batch, setBatch] = useState(() => initialData.batch ?? newDocumentBatch(initialSelection.organization ?? '', initialData.courses.find(c => c.slug === initialSelection.course || c.id === initialSelection.course)?.slug ?? ''));
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
  useEffect(() => () => exportAbort.current?.abort(), []);
  const selectedPerson = data.participants.find(p => p.userId === user);
  const program = data.courses.find(c => c.slug === course)?.title ?? fields.documentDefaults.programName;
  const dirty = JSON.stringify(fields) !== JSON.stringify(fieldsOf(saved));
  const batchDirty = Boolean(organization && course) && JSON.stringify(batch) !== JSON.stringify(savedBatch);
  const selectedCertificate = selectedPerson?.certificateId;
  const valid = Number.isInteger(fields.validityMonths) && fields.validityMonths >= 0 && fields.validityMonths <= 120;
  const branding: CertificateBranding = {
    ...saved, ...fields, protocolNumber: batch.number, protocolDate: batch.date,
    stampUrl: null, chairmanSignatureUrl: null, memberSignatureUrl: null,
  };

  const loadedSelection = useRef(JSON.stringify([organization, course]));
  useEffect(() => {
    const selection = JSON.stringify([organization, course]);
    if (loadedSelection.current === selection) return;
    const controller = new AbortController();
    setLoading(true); setBytes(null); setMetadata(null); setMessage('');
    const params = new URLSearchParams({ organization, course });
    void clientFetch('/api/admin/documents?' + params, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error(); return await response.json() as EditorData; })
      .then(next => {
        if (controller.signal.aborted) return;
        loadedSelection.current = selection;
        setData(next);
        const nextBatch = next.batch ?? newDocumentBatch(organization, course);
        setBatch(nextBatch); setSavedBatch(next.batch);
        setUser(current => next.participants.some(p => p.userId === current) ? current : next.participants[0]?.userId ?? '');
      }).catch(() => { if (!controller.signal.aborted) { setData(current => ({ ...current, participants: [] })); setMessage('Не удалось загрузить участников. Измените выбор, чтобы повторить.'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [organization, course]);

  useEffect(() => {
    const controller = new AbortController();
    setMetadata(null);
    setMetadataLoading(Boolean(selectedCertificate));
    if (selectedCertificate) void metadataFor(selectedCertificate, controller.signal)
      .then(value => { if (!controller.signal.aborted) setMetadata(value); })
      .catch(() => { if (!controller.signal.aborted) setPreviewMessage('Удостоверение недоступно. Проверьте выдачу и данные участника.'); })
      .finally(() => { if (!controller.signal.aborted) setMetadataLoading(false); });
    return () => controller.abort();
  }, [selectedCertificate, previewRetry]);

  const renderKey = JSON.stringify({ branding, people: data.participants, metadata, program, organization, tab, loading, user, batch, previewRetry });
  useEffect(() => {
    const controller = new AbortController();
    setRendering(true); setPreviewMessage('');
    const timer = setTimeout(() => {
      void (async () => {
        if (loading) return null;
        if (tab === 'certificate') {
          if (!selectedPerson) { setPreviewMessage('Выберите компанию, программу и участника.'); return null; }
          if (selectedCertificate && (!metadata || metadata.certificateId !== selectedCertificate)) return null;
          const { generateCertificatePreview } = await import('@/lib/pdf/certificate-renderer');
          const draft = {
            schemaVersion: 1 as const, filename: 'Предпросмотр.pdf', locale: 'ru' as const, templateVersion: 1,
            templateUrl: '/certificate-assets/template', fontUrl: '/certificate-assets/font?locale=ru&v=1',
            fullName: selectedPerson.fullName, position: selectedPerson.position, organization,
            titleSnapshot: program, photoUrl: selectedPerson.photoUrl, score: selectedPerson.score ?? 0,
            total: selectedPerson.total ?? 0, passScore: 0, certificateNumber: 'ПРЕДПРОСМОТР',
            completedAt: batch.date, issuedAt: batch.date + 'T12:00:00+05:00', branding,
          };
          return generateCertificatePreview({ ...(metadata ?? draft), branding }, controller.signal);
        }
        const { generateProtocolInBrowser } = await import('@/lib/pdf/protocol-renderer');
        return generateProtocolInBrowser({
          organization: organization || fields.documentDefaults.companyName, courseTitle: program, date: batch.date,
          items: [], participants: data.participants,
        }, branding, '/certificate-assets/font?locale=' + (data.participants.some(p => /[\u3400-\u9fff]/u.test(p.fullName)) ? 'zh&v=Sans2.005' : 'ru&v=1'), controller.signal);
      })().then(result => { if (!controller.signal.aborted && result) setBytes(result); })
        .catch(error => { if (!controller.signal.aborted) setPreviewMessage(error instanceof Error && error.message === 'DOCUMENT_TEXT_OVERFLOW' ? 'Текст не помещается на двух сторонах корочки. Сократите тексты бланка или состав комиссии.' : 'Не удалось сформировать PDF. Проверьте поля и повторите.'); })
        .finally(() => { if (!controller.signal.aborted) setRendering(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
    // The serialized key tracks the complete render input, including unsaved fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey]);

  async function save() {
    if (busy || loading || !valid) return;
    setBusy(true); setMessage('');
    try {
      if (dirty) {
        const response = await clientFetch('/api/admin/settings/certificate', {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...fields, expectedVersion: saved.version }),
        });
        const result = await response.json();
        if (response.status === 409 && result.settings) {
          setSaved(result.settings);
          setMessage('Настройки изменил другой администратор. Ваш ввод сохранён. Повторное сохранение применит его поверх актуальных настроек.');
          return;
        }
        if (!response.ok) throw new Error('SETTINGS');
        setSaved(result.settings);
      }
      if (organization && course && batchDirty) {
        const { id: _id, ...payload } = batch;
        const response = await clientFetch('/api/admin/documents', {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (response.status === 409) {
          const current = await clientFetch('/api/admin/documents?' + new URLSearchParams({ organization, course }), { cache: 'no-store' });
          if (!current.ok) throw new Error('BATCH');
          const latest: EditorData = await current.json();
          setBatch(value => ({ ...value, version: latest.batch?.version ?? 0, id: latest.batch?.id }));
          setSavedBatch(latest.batch);
          setMessage('Протокол уже изменён. Ваш номер и дата сохранены в редакторе; повторите сохранение для их применения.'); return;
        }
        if (!response.ok) throw new Error('BATCH');
        setBatch(result.batch); setSavedBatch(result.batch);
      }
      setMessage('Настройки и реквизиты протокола сохранены.');
    } catch { setMessage('Не удалось сохранить все изменения. Введённые значения остались в редакторе; повторите сохранение.'); }
    finally { setBusy(false); }
  }

  async function exportCompany(single = false) {
    if (busy || dirty || batchDirty || !organization || !course) return;
    setBusy(true); setExporting(true); setMessage('');
    const controller = new AbortController(); exportAbort.current = controller;
    try {
      // Re-read all participants and settings at export time, not the visible table page.
      const [peopleResponse, settingsResponse] = await Promise.all([
        clientFetch('/api/admin/documents?' + new URLSearchParams({ organization, course }), { signal: controller.signal, cache: 'no-store' }),
        clientFetch('/api/admin/settings/certificate', { signal: controller.signal, cache: 'no-store' }),
      ]);
      if (!peopleResponse.ok || !settingsResponse.ok) throw new Error();
      const current: EditorData = await peopleResponse.json();
      const currentSettings: CertificateSettingsView = (await settingsResponse.json()).settings;
      if (currentSettings.version !== saved.version || current.batch?.version !== savedBatch?.version) {
        setMessage('Настройки изменились. Обновите страницу перед скачиванием документа.'); return;
      }
      const { generateProtocolInBrowser } = await import('@/lib/pdf/protocol-renderer');
      const { generateCertificateInBrowser } = await import('@/lib/pdf/certificate-renderer');
      const { zipSync } = await import('fflate');
      const { safeFilenameSegment } = await import('@/lib/pdf/certificate');
      const archive: Record<string, Uint8Array> = {};
      if ((single && tab === 'certificate' || !single && current.participants.some(p => p.certificateId)) && (!fields.documentDefaults.insertWidthCm || !fields.documentDefaults.insertHeightCm)) {
        setMessage('Укажите и сохраните ширину и высоту раскрытого вкладыша в сантиметрах.'); setMobile('fields'); return;
      }
      if (single && tab === 'certificate') {
        if (!selectedCertificate) throw new Error();
        const item = await metadataFor(selectedCertificate, controller.signal);
        const result = await generateCertificateInBrowser({ ...item, branding }, controller.signal);
        setBytes(result); download(result, item.filename); return;
      }
      const group: Parameters<typeof generateProtocolInBrowser>[0] = { organization, courseTitle: program, items: [], participants: current.participants, date: batch.date };
      const fontUrl = '/certificate-assets/font?locale=' + (current.participants.some(p => /[\u3400-\u9fff]/u.test(p.fullName)) ? 'zh&v=Sans2.005' : 'ru&v=1');
      archive['Протокол.pdf'] = await generateProtocolInBrowser(group, branding, fontUrl, controller.signal);
      if (single) {
        setData(current); setBytes(archive['Протокол.pdf']);
        download(archive['Протокол.pdf'], 'Протокол.pdf'); return;
      }
      let count = 0;
      for (const person of current.participants) {
        if (!person.certificateId) continue;
        if (controller.signal.aborted) throw new Error();
        const item = await metadataFor(person.certificateId, controller.signal);
        archive['Корочки/' + item.filename] = await generateCertificateInBrowser({ ...item, branding }, controller.signal);
        setMessage('Сформировано корочек: ' + (++count));
      }
      download(zipSync(archive), safeFilenameSegment(organization, 100) + '.zip', 'application/zip');
      setMessage(`Комплект: протокол на ${current.participants.length} участников, корочек — ${count}.`);
    } catch { setMessage(controller.signal.aborted ? 'Формирование отменено.' : 'Комплект не скачан: одна из проверок или генерация завершилась ошибкой. Повторите попытку.'); }
    finally { setBusy(false); setExporting(false); exportAbort.current = null; }
  }

  function field(key: keyof Omit<SettingsFields, 'documentDefaults' | 'validityMonths'>, label: string, multiline = false) {
    const props = { id: 'doc-' + key, value: fields[key], maxLength: multiline ? 1000 : key === 'bin' ? 32 : 200,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields(current => ({ ...current, [key]: event.target.value })) };
    return <label className="relative block"><span className="absolute left-3 top-1.5 z-10 text-xs text-[var(--color-text-muted)]">{label}</span>{multiline ? <Textarea {...props} aria-label={label} placeholder={label} className="pt-6" rows={3} /> : <Input {...props} aria-label={label} placeholder={label} className="h-auto min-h-14 pt-6" />}</label>;
  }
  function defaultsField(key: Exclude<keyof DocumentDefaults, 'commission' | 'insertWidthCm' | 'insertHeightCm'>, label: string) {
    return <div className="relative"><Label className="absolute left-3 top-1.5 text-xs" htmlFor={'default-' + key}>{label}</Label>
      <Textarea className="pt-6" placeholder={label} id={'default-' + key} value={fields.documentDefaults[key]} rows={2} maxLength={key === 'protocolText' ? 1000 : key === 'programName' ? 240 : 200}
        onChange={e => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, [key]: e.target.value } }))} /></div>;
  }
  const canDownload = bytes && !previewMessage && !busy && !loading && !rendering && !dirty && !batchDirty && organization && course;
  return <div className="document-editor min-w-0 space-y-4">
    <div className="sticky top-14 z-20 space-y-2 bg-[var(--color-surface)] py-2">
      <div className="grid grid-cols-2 gap-2" aria-label="Вид документа">
        <Button variant={tab === 'certificate' ? 'primary' : 'outline'} onClick={() => { setBytes(null); setTab('certificate'); }}>Корочка</Button>
        <Button variant={tab === 'protocol' ? 'primary' : 'outline'} onClick={() => { setBytes(null); setTab('protocol'); }}>Протокол</Button>
      </div>
      <div className="document-mode-switch grid grid-cols-2 gap-2 lg:hidden [&_button]:text-xs"><Button variant={mobile === 'fields' ? 'primary' : 'outline'} onClick={() => setMobile('fields')}>Поля</Button><Button variant={mobile === 'preview' ? 'primary' : 'outline'} onClick={() => setMobile('preview')}>Предпросмотр</Button></div>
    </div>
    <div className="min-w-0 space-y-2">
      {!changeContext && <div className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1 text-sm"><p className="break-words font-semibold">{organization}</p><p className="break-words text-[var(--color-text-muted)]">{program}</p></div><Button size="sm" variant="ghost" onClick={() => setChangeContext(true)}>Изменить</Button></div>}
      {changeContext && <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <DocumentSelect label="Компания" value={organization} options={data.organizations.map(value => ({value, label: value}))} disabled={busy || batchDirty && Boolean(savedBatch)} onChange={setOrganization} />
        <DocumentSelect label="Программа" value={course} options={data.courses.map(c => ({value: c.slug, label: c.title}))} disabled={busy || batchDirty && Boolean(savedBatch)} onChange={setCourse} />
        {organization && course && <Button size="sm" variant="ghost" onClick={() => setChangeContext(false)}>Готово</Button>}
      </div>}
      {tab === 'certificate' && <DocumentSelect label="Сотрудник" value={user} options={data.participants.map(p => ({value: p.userId, label: p.fullName || 'ФИО не указано'}))} disabled={busy || loading} onChange={value => { setBytes(null); setMetadata(null); setUser(value); }} />}
    </div>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
      <fieldset disabled={busy} className={`min-w-0 space-y-5 ${mobile === 'preview' ? 'hidden lg:block' : ''}`}>
        <section className="space-y-3"><h2 className="font-bold">Дата и номер протокола</h2>
          <Label htmlFor="doc-date">Дата</Label><Input id="doc-date" type="date" value={batch.date} onChange={e => { if (e.target.value) setBatch(current => changeDocumentDate(current, e.target.value)); }} />
          <Label htmlFor="doc-number">Номер</Label><Input id="doc-number" maxLength={64} value={batch.number} onChange={e => setBatch(current => ({ ...current, number: e.target.value, automatic: false }))} />
          <Button variant="outline" onClick={() => setBatch(current => ({ ...current, automatic: true, number: numberFromDate(current.date) }))}>Номер по дате</Button>
          {batchDirty && savedBatch && <Button variant="ghost" onClick={() => setBatch(savedBatch)}>Отменить изменения даты и номера</Button>}
        </section>
        <section className="space-y-3"><h2 className="font-bold">Организация и комиссия</h2>
          {field('organizationName', 'Учебная организация')}{field('bin', 'БИН')}
          {field('chairmanName', 'Председатель')}{field('chairmanPosition', 'Должность председателя')}
          {defaultsField('reviewerName', 'Проверяющий')}
          {fields.documentDefaults.commission.map((member, i) => <div key={i} className="space-y-2 py-3">
            <Label className="sr-only" htmlFor={'member-name-' + i}>Член комиссии {i + 1}</Label>
            <label className="relative block"><span className="absolute left-3 top-1.5 z-10 text-xs">Член комиссии {i + 1}</span><Input className="h-auto min-h-14 pt-6" placeholder="ФИО участника комиссии" id={'member-name-' + i} value={member.name} maxLength={200} onChange={e => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, commission: current.documentDefaults.commission.map((m, n) => n === i ? { ...m, name: e.target.value } : m) } }))} /></label>
            <Label className="sr-only" htmlFor={'member-position-' + i}>Должность</Label><label className="relative block"><span className="absolute left-3 top-1.5 z-10 text-xs">Должность в комиссии</span><Input className="h-auto min-h-14 pt-6" placeholder="Должность в комиссии" id={'member-position-' + i} value={member.position} maxLength={200} onChange={e => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, commission: current.documentDefaults.commission.map((m, n) => n === i ? { ...m, position: e.target.value } : m) } }))} /></label>
            <Button variant="outline" onClick={() => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, commission: current.documentDefaults.commission.filter((_, n) => n !== i) } }))}><Trash aria-hidden="true" />Удалить участника</Button>
          </div>)}
          <Button variant="outline" disabled={fields.documentDefaults.commission.length >= 20} onClick={() => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, commission: [...current.documentDefaults.commission, { name: '', position: '' }] } }))}><Plus aria-hidden="true" />Добавить участника комиссии</Button>
        </section>
        <section className="space-y-3"><h2 className="font-bold">Размер раскрытого вкладыша</h2>
          <p className="text-sm text-[var(--color-text-muted)]">Обе половины вместе, в сантиметрах. Для печати укажите фактический размер; масштаб принтера — 100%.</p>
          {(['insertWidthCm', 'insertHeightCm'] as const).map(key => <label key={key} className="relative block"><span className="absolute left-3 top-1.5 z-10 text-xs">{key === 'insertWidthCm' ? 'Общая ширина, см' : 'Высота, см'}</span><Input className="h-auto min-h-14 pt-6" type="number" step="0.1" min={key === 'insertWidthCm' ? 8 : 4} max={key === 'insertWidthCm' ? 60 : 30} aria-label={key === 'insertWidthCm' ? 'Общая ширина, см' : 'Высота, см'} placeholder="Не задана" value={fields.documentDefaults[key] ?? ''} onChange={e => setFields(current => ({...current, documentDefaults: {...current.documentDefaults, [key]: e.target.value === '' ? null : Number(e.target.value)}}))} /></label>)}
        </section>
        <details className="space-y-3"><summary className="min-h-11 cursor-pointer font-bold">Тексты и значения образца</summary>
          {defaultsField('companyName', 'Компания образца')}{defaultsField('programName', 'Программа образца')}
          {defaultsField('protocolText', 'Текст протокола')}
          <p className="text-sm">{'{protocol} — номер, {program} — программа'}</p>
          {field('examTextKk', 'Первая сторона — казахский', true)}{field('examTextRu', 'Первая сторона — русский', true)}
          {field('knowledgeTextKk', 'Вторая сторона — казахский', true)}{field('knowledgeTextRu', 'Вторая сторона — русский', true)}
          <Label htmlFor="doc-validity">Срок действия, месяцев (0 — без ограничения)</Label>
          <Input id="doc-validity" type="number" min={0} max={120} value={fields.validityMonths} onChange={e => setFields(current => ({ ...current, validityMonths: Number(e.target.value) }))} />
        </details>
      </fieldset>
      <section aria-label="Предпросмотр документа" className={`min-w-0 space-y-3 lg:sticky lg:top-4 ${mobile === 'fields' ? 'hidden lg:block' : ''}`}>
        <h2 className="font-bold">{tab === 'protocol' ? 'Протокол компании' : 'Индивидуальная корочка'}</h2>
        {(dirty || batchDirty) && <p className="text-sm">Предпросмотр изменений. Сохраните перед скачиванием.</p>}
        {!organization || !course ? <p className="text-sm">Образец: выберите компанию и программу для рабочего документа.</p> : null}
        {loading || rendering || metadataLoading ? <p role="status" className="flex items-center gap-2 text-sm"><span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />Обновляем документ…</p> : null}
        {tab === 'certificate' && selectedPerson && !selectedCertificate && <p className="text-sm">Предварительный просмотр. Удостоверение ещё не выдано; официальное скачивание недоступно.</p>}
        {tab === 'certificate' && selectedPerson && !selectedPerson.photoUrl && <p role="status" className="text-sm">В профиле нет фотографии. Добавьте её перед печатью корочки.</p>}
        {previewMessage && <div className="space-y-2"><p role="status">{previewMessage}</p><Button variant="outline" onClick={() => setPreviewRetry(value => value + 1)}>Повторить предпросмотр</Button></div>}
        {tab === 'certificate' && <div className="grid grid-cols-2 gap-2 lg:hidden"><Button size="sm" variant={half === 'left' ? 'primary' : 'outline'} onClick={() => setHalf('left')}>Левая</Button><Button size="sm" variant={half === 'right' ? 'primary' : 'outline'} onClick={() => setHalf('right')}>Правая</Button></div>}
        <div className="overflow-hidden bg-neutral-200 p-1"><div className={tab === 'certificate' ? 'document-insert ' + (half === 'right' ? 'document-insert-right' : '') : ''}><PdfPreview bytes={bytes} /></div></div>
        {selectedPerson && <a className="inline-block min-h-11 text-sm underline" href={'/admin/employees?q=' + encodeURIComponent(selectedPerson.fullName)}>Данные и выдача участника</a>}
      </section>
    </div>
    {message && <p role="status" className="text-sm">{message}</p>}
    <div className="grid gap-2 bg-[var(--color-surface)] py-3 sm:flex sm:flex-wrap">
      <Button disabled={busy || loading || !valid || !(dirty || batchDirty) || !batch.number.trim()} onClick={() => void save()}>Сохранить настройки</Button>
      <Button variant="outline" disabled={!canDownload || tab === 'certificate' && !selectedCertificate} onClick={() => void exportCompany(true)}>Скачать PDF</Button>
      <Button variant="outline" disabled={busy || loading || dirty || batchDirty || !organization || !course} onClick={() => void exportCompany()}>Скачать комплект компании</Button>
      {exporting && <Button variant="ghost" onClick={() => exportAbort.current?.abort()}>Отменить</Button>}
    </div>
  </div>;
}

function DocumentSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: {value: string; label: string}[]; disabled?: boolean; onChange(value: string): void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  return <details ref={ref} className="relative min-w-0">
    <summary aria-label={label} aria-disabled={disabled} onClick={e => { if (disabled) e.preventDefault(); }} className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg bg-[var(--color-bg)] px-3 py-2 ring-1 ring-[var(--color-border)]">
      <span className="min-w-0 flex-1 break-words text-sm"><span className="block text-xs text-[var(--color-text-muted)]">{label}</span>{options.find(o => o.value === value)?.label || 'Выберите'}</span><CaretDown aria-hidden="true" className="shrink-0" size={18} />
    </summary>
    <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg bg-[var(--color-surface)] p-1 shadow-lg">
      {options.map(option => <button type="button" key={option.value} disabled={disabled} aria-pressed={option.value === value} className="block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-[var(--color-bg)]" onClick={() => { onChange(option.value); if (ref.current) ref.current.open = false; }}>{option.label}</button>)}
      {!options.length && <p className="p-3 text-sm">Нет доступных вариантов</p>}
    </div>
  </details>;
}
