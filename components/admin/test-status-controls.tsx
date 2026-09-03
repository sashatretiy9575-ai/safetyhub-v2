'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { NotePencil } from '@phosphor-icons/react/dist/csr/NotePencil';
import { Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { Button } from '@/components/ui/button';
import { clientRequest, clientRequestMessage } from '@/lib/client-request';
import { DestructiveDialog } from '@/components/admin/destructive-dialog';

export function TestStatusControls({
  testId,
  status,
  expectedVersion,
}: {
  testId: string;
  status: 'draft' | 'published';
  expectedVersion: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const change = async (next: 'draft' | 'published') => {
    setBusy(true);
    try {
      const result = await clientRequest(`/api/admin/courses/${testId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!result.ok) {
        window.alert(clientRequestMessage(result.error, 'Не удалось изменить статус курса.'));
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const removeCourse = async () => {
    setBusy(true);
    try {
      const result = await clientRequest(`/api/admin/courses/${testId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion }),
      });
      if (!result.ok) {
        window.alert(clientRequestMessage(result.error, 'Не удалось удалить курс.'));
        return;
      }
      setDeleteOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex shrink-0 items-center gap-1">
        {status === 'published' ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label="В черновик"
            title="Снять с публикации (в черновик)"
            onClick={() => setUnpublishOpen(true)}
            disabled={busy}
          >
            <Archive aria-hidden="true" />
            <span className="sr-only"><NotePencil /></span>
          </Button>
        ) : null}
        <Button
          size="icon"
          variant="ghost"
          aria-label="Удалить курс"
          title="Удалить курс"
          onClick={() => setDeleteOpen(true)}
          disabled={busy || expectedVersion === null}
        >
          <Trash />
        </Button>
      </div>
      <DestructiveDialog
        open={unpublishOpen}
        title="Снять курс с публикации?"
        description="Курс перейдёт в статус черновика и временно перестанет быть доступен учащимся на портале."
        busy={busy}
        onOpenChange={setUnpublishOpen}
        onConfirm={async () => {
          await change('draft');
          setUnpublishOpen(false);
        }}
      />
      <DestructiveDialog
        open={deleteOpen}
        title="Удалить курс?"
        description="Курс, материалы, вопросы, попытки и аттестации будут удалены. Уже выданные сертификаты сохранятся и продолжат проверяться."
        busy={busy}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void removeCourse()}
      />
    </>
  );
}
