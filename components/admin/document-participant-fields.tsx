'use client';
import { useState } from 'react';
import { clientFetch } from '@/lib/client-request';
import type { DocumentBatch, DocumentParticipant } from '@/lib/pdf/document-editor';
import type { DocumentFamily } from '@/lib/pdf/document-profile';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';

export function DocumentParticipantFields({ person, family, batch, onSaved }: { person: DocumentParticipant; family: DocumentFamily; batch: DocumentBatch; onSaved(fields: Pick<DocumentParticipant, 'trainingReason' | 'notes' | 'qualificationDecision' | 'formalExamReference' | 'formalExamDate' | 'formalExamResult' | 'formalExamProfileId' | 'formalExamProfileVersion'>, version: number): void }) {
  const [fields, setFields] = useState({ trainingReason: person.trainingReason ?? '', notes: person.notes ?? '', qualificationDecision: person.qualificationDecision ?? '', formalExamReference: person.formalExamReference ?? '', formalExamDate: person.formalExamDate ?? '', formalExamResult: person.formalExamResult ?? '' });
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const key = family === 'ptm' ? 'trainingReason' : family === 'qualification' ? 'qualificationDecision' : 'notes';
  const label = family === 'ptm' ? 'Причина обучения' : family === 'qualification' ? 'Решение квалификационной комиссии' : 'Примечание';
  async function save() {
    setBusy(true); setMessage('');
    try {
      const response = await clientFetch('/api/admin/documents/participant-fields', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: batch.id, userId: person.userId, version: batch.version, fields }) });
      const result = await response.json();
      if (!response.ok) { setMessage(result.error === 'DOCUMENT_FORMAL_EXAM_INVALID' ? 'Проверьте дату и результат отдельного экзамена.' : result.error === 'DOCUMENT_PROFILE_REQUIRED' ? 'Сначала сохраните выбранную категорию слушателей.' : response.status === 409 ? 'Протокол изменён. Обновите страницу.' : 'Не удалось сохранить.'); return; }
      onSaved({ ...fields, formalExamProfileId: result.formalExamProfileId ?? undefined, formalExamProfileVersion: result.formalExamProfileVersion ?? undefined }, result.version); setMessage('Сохранено для следующей выдачи.');
    } catch { setMessage('Не удалось сохранить.'); } finally { setBusy(false); }
  }
  return <div className="grid gap-2 rounded-xl border p-3">
    {family === 'industrial' ? <>
      <p className="text-sm font-medium">Подтверждение отдельного экзамена</p>
      <p className="text-xs text-[var(--color-text-muted)]">Учебный тест на сайте не заменяет установленный экзамен по промышленной безопасности. Для выдачи документа внесите реквизиты проверенного экзаменационного протокола.</p>
      <label className="grid gap-1 text-sm">Номер протокола и источник подтверждения<Textarea value={fields.formalExamReference} onChange={e => setFields(v => ({ ...v, formalExamReference: e.target.value }))} /></label>
      <label className="grid gap-1 text-sm">Дата отдельного экзамена<Input type="date" value={fields.formalExamDate} onChange={e => setFields(v => ({ ...v, formalExamDate: e.target.value }))} /></label>
      <label className="grid gap-1 text-sm">Результат отдельного экзамена<select className="min-h-10 rounded-lg border bg-[var(--color-surface)] px-3" value={fields.formalExamResult} onChange={e => setFields(v => ({ ...v, formalExamResult: e.target.value }))}><option value="">Не подтверждён</option><option value="passed">Сдан — подтверждено протоколом</option><option value="failed">Не сдан</option></select></label>
    </> : <label className="grid gap-1 text-sm">{label}<Textarea value={fields[key]} onChange={e => setFields(v => ({ ...v, [key]: e.target.value }))} /></label>}
    <Button type="button" disabled={busy || !batch.id} onClick={save}>Сохранить данные участника</Button>
    {!batch.id ? <p className="text-xs">Сначала сохраните дату и номер протокола.</p> : null}
    {message ? <p className="text-xs" role="status">{message}</p> : null}
  </div>;
}
