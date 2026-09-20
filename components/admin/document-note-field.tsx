'use client';
import { useState } from 'react';
import { clientFetch } from '@/lib/client-request';
import type { DocumentBatch, DocumentParticipant } from '@/lib/pdf/document-editor';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * The last column of the «БиОТ» form. It is empty on every protocol the training
 * centre prints, so it lives behind a folded line rather than in the way of an
 * ordinary issuance — and it is still here for the rare exception somebody has
 * to write down. Saving it creates the protocol's own record if there is none
 * yet, so nothing has to be saved in a particular order first.
 */
export function DocumentNoteField({
  person,
  batch,
  ensureBatch,
  onSaved,
}: {
  person: DocumentParticipant;
  batch: DocumentBatch;
  ensureBatch(): Promise<DocumentBatch | null>;
  onSaved(notes: string, version: number): void;
}) {
  const [notes, setNotes] = useState(person.notes ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const stored = batch.id ? batch : await ensureBatch();
      if (!stored?.id) {
        setMessage('Не удалось сохранить.');
        return;
      }
      const response = await clientFetch('/api/admin/documents/participant-fields', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId: stored.id,
          userId: person.userId,
          version: stored.version,
          fields: {
            notes,
            trainingReason: person.trainingReason ?? '',
            qualificationDecision: person.qualificationDecision ?? '',
          },
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? 'Протокол изменён. Обновите страницу.'
            : 'Не удалось сохранить.',
        );
        return;
      }
      onSaved(notes, result.version);
      setMessage(notes.trim() ? 'Сохранено для следующей выдачи.' : 'Примечание очищено.');
    } catch {
      setMessage('Не удалось сохранить.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-sm text-[var(--color-text-muted)]">
        Колонка «Примечание» печатается пустой. Заполните её только если для этого слушателя нужна
        отдельная отметка.
      </p>
      <label className="grid min-w-0 gap-1.5 text-sm">
        <span className="text-[var(--color-text-muted)]">
          Примечание · {person.fullName || 'без ФИО'}
        </span>
        <Textarea
          rows={2}
          maxLength={500}
          className="w-full min-w-0 text-base"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-auto min-h-12 min-w-0 justify-self-start bg-[var(--color-surface-muted)] whitespace-normal"
        disabled={busy}
        onClick={() => void save()}
      >
        Сохранить примечание
      </Button>
      <p className="min-h-5 text-sm" role="status">
        {message}
      </p>
    </div>
  );
}
