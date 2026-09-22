'use client';

import { useEffect, useRef, useState } from 'react';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';
import { clientFetch } from '@/lib/client-request';

type Audience = 'itr' | 'worker';
type Documents = {
  courseSlug: string;
  split: boolean;
  audience: Audience;
  positionAudience: Audience;
  note: string;
};
type State =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; documents: Documents };

/**
 * What the protocol prints about this person in this course and nobody else:
 * «ИТР» or «Рабочий» where the course prints them on separate protocols, and
 * «Примечание». Both are saved as they change and reach the documents issued
 * afterwards; an issued document keeps what it was issued with.
 */
export function PersonDocumentFields({ userId, courseId }: { userId: string; courseId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const savedNote = useRef('');

  useEffect(() => {
    const controller = new AbortController();
    void clientFetch(
      `/api/admin/documents/person/${encodeURIComponent(userId)}?` +
        new URLSearchParams({ course: courseId }),
      { signal: controller.signal, cache: 'no-store' },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const answer = (await response.json()) as { documents: Documents };
        if (controller.signal.aborted) return;
        savedNote.current = answer.documents.note;
        setNote(answer.documents.note);
        setState({ kind: 'ready', documents: answer.documents });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'failed' });
      });
    return () => controller.abort();
  }, [userId, courseId]);

  async function put(url: string, body: unknown) {
    setStatus('Сохраняем…');
    const response = await clientFetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    setStatus(response?.ok ? 'Сохранено' : response?.status === 429 ? 'Слишком часто, повторите через минуту' : 'Не сохранилось, повторите');
    return Boolean(response?.ok);
  }

  if (state.kind === 'failed') return null;
  if (state.kind === 'loading') {
    return (
      <div
        aria-hidden="true"
        className="h-24 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-muted)] motion-reduce:animate-none"
      />
    );
  }
  const documents = state.documents;

  return (
    <div className="min-w-0 space-y-2">
      {documents.split ? (
        <SegmentedControl
          label="Категория слушателя"
          value={documents.audience}
          onChange={(audience) => {
            const previous = documents;
            setState({ kind: 'ready', documents: { ...documents, audience } });
            // The position's own answer is not an override: choosing it gives the choice back.
            void put('/api/admin/documents/audience', {
              userId,
              audience: audience === documents.positionAudience ? null : audience,
            }).then((saved) => {
              if (!saved) setState({ kind: 'ready', documents: previous });
            });
          }}
          options={[
            { value: 'itr', label: 'ИТР' },
            { value: 'worker', label: 'Рабочий' },
          ]}
        />
      ) : null}
      <Textarea
        aria-label="Примечание в протоколе"
        placeholder="Примечание"
        maxLength={500}
        rows={2}
        className="min-w-0 w-full text-base"
        value={note}
        onChange={(event) => {
          setStatus('');
          setNote(event.target.value);
        }}
        onBlur={() => {
          if (note.trim() === savedNote.current) return;
          void put('/api/admin/documents/notes', {
            userId,
            courseSlug: documents.courseSlug,
            notes: note,
          }).then((saved) => {
            if (saved) savedNote.current = note.trim();
          });
        }}
      />
      <p role="status" className="min-h-5 text-sm text-[var(--color-text-muted)]">
        {status}
      </p>
    </div>
  );
}
