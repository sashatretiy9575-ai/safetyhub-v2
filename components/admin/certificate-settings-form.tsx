'use client';

import { useEffect, useRef, useState } from 'react';
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
    container.replaceChildren();
    if (!bytes) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false });
      dispose = () => { void task.destroy(); };
      const pdf = await task.promise;
      for (let pageNumber = 1; pageNumber <= pdf.numPages && !cancelled; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) break;
        const canvas = document.createElement('canvas');
        const viewport = page.getViewport({ scale: 1.4 });
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        canvas.style.width = '100%'; canvas.style.height = 'auto';
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Страница ' + pageNumber);
        container.appendChild(canvas);
        await page.render({ canvas, viewport }).promise;
      }
      if (!cancelled) setError('');
    })().catch(() => { if (!cancelled) setError('Предпросмотр не загрузился. Повторите изменение поля.'); });
    return () => { cancelled = true; dispose?.(); container.replaceChildren(); };
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
  const [user, setUser] = useState(initialSelection.user ?? '');
  const [tab, setTab] = useState<'protocol' | 'certificate'>(initialSelection.tab === 'certificate' ? 'certificate' : 'protocol');
  const [mobile, setMobile] = useState<'fields' | 'preview'>('fields');
  const [zoomed, setZoomed] = useState(false);
  const [batch, setBatch] = useState(() => newDocumentBatch('', ''));
  const [savedBatch, setSavedBatch] = useState<DocumentBatch | null>(null);
  const [metadata, setMetadata] = useState<CertificateRenderMetadata | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [message, setMessage] = useState('');
  const [previewMessage, setPreviewMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
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

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setBytes(null); setMetadata(null); setMessage('');
    const params = new URLSearchParams({ organization, course });
    void clientFetch('/api/admin/documents?' + params, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error(); return await response.json() as EditorData; })
      .then(next => {
        if (controller.signal.aborted) return;
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
    if (selectedCertificate) void metadataFor(selectedCertificate, controller.signal)
      .then(value => { if (!controller.signal.aborted) setMetadata(value); })
      .catch(() => { if (!controller.signal.aborted) setPreviewMessage('Удостоверение недоступно. Проверьте выдачу и данные участника.'); });
    return () => controller.abort();
  }, [selectedCertificate]);

  const renderKey = JSON.stringify({ branding, people: data.participants, metadata, program, organization, tab, loading });
  useEffect(() => {
    const controller = new AbortController();
    setBytes(null); setRendering(true); setPreviewMessage('');
    const timer = setTimeout(() => {
      void (async () => {
        if (loading) return null;
        if (tab === 'certificate') {
          if (!selectedPerson) { setPreviewMessage('Выберите компанию, программу и участника.'); return null; }
          if (!selectedCertificate) { setPreviewMessage('Участнику ещё не выдано удостоверение. Откройте его карточку для проверки и выдачи.'); return null; }
          if (!metadata) return null;
          const { generateCertificateInBrowser } = await import('@/lib/pdf/certificate-renderer');
          return generateCertificateInBrowser({ ...metadata, branding }, controller.signal);
        }
        const { generateProtocolInBrowser } = await import('@/lib/pdf/protocol-renderer');
        return generateProtocolInBrowser({
          organization: organization || fields.documentDefaults.companyName, courseTitle: program, date: batch.date,
          items: [], participants: data.participants,
        }, branding, '/certificate-assets/font?locale=' + (data.participants.some(p => /[\u3400-\u9fff]/u.test(p.fullName)) ? 'zh&v=Sans2.005' : 'ru&v=1'), controller.signal);
      })().then(result => { if (!controller.signal.aborted) setBytes(result); })
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
    return <div className="space-y-1"><Label htmlFor={props.id}>{label}</Label>{multiline ? <Textarea {...props} rows={3} /> : <Input {...props} />}</div>;
  }
  function defaultsField(key: Exclude<keyof DocumentDefaults, 'commission'>, label: string) {
    return <div className="space-y-1"><Label htmlFor={'default-' + key}>{label}</Label>
      <Textarea id={'default-' + key} value={fields.documentDefaults[key]} rows={2} maxLength={key === 'protocolText' ? 1000 : key === 'programName' ? 240 : 200}
        onChange={e => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, [key]: e.target.value } }))} /></div>;
  }
  const selectClass = 'min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm';
  const canDownload = bytes && !busy && !loading && !rendering && !dirty && !batchDirty && organization && course;
  return <div className="space-y-5">
    <div className="flex flex-wrap gap-2" aria-label="Вид документа">
      <Button variant={tab === 'protocol' ? 'primary' : 'outline'} onClick={() => setTab('protocol')}>Протокол компании</Button>
      <Button variant={tab === 'certificate' ? 'primary' : 'outline'} onClick={() => setTab('certificate')}>Корочка клиента</Button>
    </div>
    <div className="grid gap-3 md:grid-cols-3">
      <div><Label htmlFor="doc-company">Компания</Label><select id="doc-company" className={selectClass} value={organization} disabled={busy || batchDirty && Boolean(savedBatch)} onChange={e => setOrganization(e.target.value)}>
        <option value="">Выберите компанию</option>{data.organizations.map(org => <option key={org}>{org}</option>)}</select></div>
      <div><Label htmlFor="doc-course">Программа</Label><select id="doc-course" className={selectClass} value={course} disabled={busy || batchDirty && Boolean(savedBatch)} onChange={e => setCourse(e.target.value)}>
        <option value="">Выберите программу</option>{data.courses.map(c => <option key={c.slug} value={c.slug}>{c.title}</option>)}</select></div>
      <div><Label htmlFor="doc-person">Клиент</Label><select id="doc-person" className={selectClass} value={user} disabled={loading || busy} onChange={e => setUser(e.target.value)}>
        <option value="">Выберите клиента</option>{data.participants.map(p => <option key={p.userId} value={p.userId}>{p.fullName || 'ФИО не указано'}</option>)}</select></div>
    </div>
    {organization && course && <p className="text-sm">Участников компании: {data.participants.length}. Корочек выдано: {data.participants.filter(p => p.certificateId).length}.</p>}
    <div className="flex gap-2 lg:hidden"><Button variant={mobile === 'fields' ? 'primary' : 'outline'} onClick={() => setMobile('fields')}>Поля</Button><Button variant={mobile === 'preview' ? 'primary' : 'outline'} onClick={() => setMobile('preview')}>Предпросмотр</Button></div>
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
          {fields.documentDefaults.commission.map((member, i) => <div key={i} className="space-y-2 rounded-lg border p-3">
            <Label htmlFor={'member-name-' + i}>Член комиссии {i + 1}</Label>
            <Input id={'member-name-' + i} value={member.name} maxLength={200} onChange={e => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, commission: current.documentDefaults.commission.map((m, n) => n === i ? { ...m, name: e.target.value } : m) } }))} />
            <Label htmlFor={'member-position-' + i}>Должность</Label><Input id={'member-position-' + i} value={member.position} maxLength={200} onChange={e => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, commission: current.documentDefaults.commission.map((m, n) => n === i ? { ...m, position: e.target.value } : m) } }))} />
            <Button variant="ghost" onClick={() => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, commission: current.documentDefaults.commission.filter((_, n) => n !== i) } }))}>Убрать члена комиссии</Button>
          </div>)}
          <Button variant="outline" disabled={fields.documentDefaults.commission.length >= 20} onClick={() => setFields(current => ({ ...current, documentDefaults: { ...current.documentDefaults, commission: [...current.documentDefaults.commission, { name: '', position: '' }] } }))}>Добавить члена комиссии</Button>
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
        {loading || rendering ? <p role="status">Подготавливаем документ…</p> : null}
        {previewMessage && <p role="status">{previewMessage}</p>}
        <Button variant="outline" aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>{zoomed ? 'Уместить по ширине' : 'Увеличить документ'}</Button>
        <div className="max-h-[80dvh] overflow-auto rounded-xl bg-neutral-200 p-2 sm:p-4"><div style={zoomed ? { width: 850 } : undefined}><PdfPreview bytes={bytes} /></div></div>
        {selectedPerson && <a className="inline-block min-h-11 text-sm underline" href={'/admin/employees?q=' + encodeURIComponent(selectedPerson.fullName)}>Данные и выдача участника</a>}
      </section>
    </div>
    {message && <p role="status" className="text-sm">{message}</p>}
    <div className="flex flex-wrap gap-2 border-t bg-[var(--color-surface)] py-3 lg:sticky lg:bottom-0">
      <Button disabled={busy || loading || !valid || !(dirty || batchDirty) || !batch.number.trim()} onClick={() => void save()}>Сохранить настройки</Button>
      <Button variant="outline" disabled={!canDownload} onClick={() => void exportCompany(true)}>Скачать PDF</Button>
      <Button variant="outline" disabled={busy || loading || dirty || batchDirty || !organization || !course} onClick={() => void exportCompany()}>Скачать комплект компании</Button>
      {exporting && <Button variant="ghost" onClick={() => exportAbort.current?.abort()}>Отменить</Button>}
    </div>
  </div>;
}
