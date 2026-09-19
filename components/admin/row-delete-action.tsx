'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { DestructiveDialog } from '@/components/admin/destructive-dialog';
import { Button } from '@/components/ui/button';
import { clientRequest, clientRequestMessage } from '@/lib/client-request';
import { deleteArticleAction } from '@/server/actions/articles';

export type DeletableKind = 'course' | 'article';

/**
 * What the confirmation says is what the database does. `delete_course` takes
 * the revisions with their questions, the attempts, the attestations and the
 * access grants along with the course, retires its presentations for the
 * storage cleanup and keeps every issued certificate. `delete_article` takes
 * the draft, the translations and the revision history. The list and the
 * article editor ask with the same words.
 */
export function deleteDialogCopy(kind: DeletableKind, title: string) {
  const name = title.trim();
  if (kind === 'course') {
    return {
      title: name ? `Удалить курс «${name}»?` : 'Удалить курс?',
      description:
        'Курс исчезнет с сайта на всех языках. Удалятся презентации, вопросы, попытки, аттестации и выданные доступы. Выданные сертификаты сохранятся.',
    };
  }
  return {
    title: name ? `Удалить материал «${name}»?` : 'Удалить материал?',
    description:
      'Материал исчезнет с сайта на всех языках, ссылка перестанет открываться. Черновик, переводы и история редакций удалятся.',
  };
}

/** Both answer with the text for the dialog, or with `null` once the row is gone. */
async function deleteCourse(id: string, expectedVersion: number): Promise<string | null> {
  const result = await clientRequest(`/api/admin/courses/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion }),
  });
  if (result.ok) return null;
  // The draft moved on since the list was drawn: the version no longer matches.
  if (result.error.status === 409) return 'Курс изменён. Обновите страницу.';
  return clientRequestMessage(result.error, 'Не удалось удалить курс.');
}

async function deleteArticle(id: string, expectedVersion: number): Promise<string | null> {
  try {
    await deleteArticleAction({ articleId: id, expectedVersion });
    return null;
  } catch {
    // A server action hides the reason of its failure in production.
    return 'Не удалось удалить материал. Обновите страницу и повторите.';
  }
}

/**
 * The bin at the end of a list row. A failure stays inside the open dialog;
 * a deletion closes it and refreshes the list in place, filters and all.
 */
export function RowDeleteAction({
  kind,
  id,
  title,
  expectedVersion,
}: {
  kind: DeletableKind;
  id: string;
  title: string;
  /** The draft version the deletion is checked against; without it there is nothing to send. */
  expectedVersion: number | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const copy = deleteDialogCopy(kind, title);

  const remove = async () => {
    if (expectedVersion === null) return;
    setBusy(true);
    setError('');
    try {
      const failure =
        kind === 'course'
          ? await deleteCourse(id, expectedVersion)
          : await deleteArticle(id, expectedVersion);
      if (failure) {
        setError(failure);
        return;
      }
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="dangerGhost"
        aria-label={`Удалить: ${title}`}
        title="Удалить"
        disabled={busy || expectedVersion === null}
        onClick={() => setOpen(true)}
      >
        <Trash aria-hidden />
      </Button>
      <DestructiveDialog
        open={open}
        title={copy.title}
        description={copy.description}
        busy={busy}
        error={error}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError('');
        }}
        onConfirm={() => void remove()}
      />
    </>
  );
}
