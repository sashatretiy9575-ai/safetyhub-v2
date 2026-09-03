'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowsMerge, X } from '@phosphor-icons/react';
import type {
  OrganizationCleanupCluster,
  OrganizationMergePreview,
  OrganizationMergeResult,
} from '@/features/admin/organizations';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function OrganizationCleanupManager({
  clusters,
}: {
  clusters: OrganizationCleanupCluster[];
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [cluster, setCluster] = useState<OrganizationCleanupCluster | null>(null);
  const [targetId, setTargetId] = useState('');
  const [preview, setPreview] = useState<OrganizationMergePreview | null>(null);
  const [policy, setPolicy] = useState<'preserve' | 'reissue'>('preserve');
  const [confirmation, setConfirmation] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (cluster && dialog && !dialog.open) dialog.showModal();
    if (!cluster && dialog?.open) dialog.close();
  }, [cluster]);

  const sourceIds = (item: OrganizationCleanupCluster, target: string) =>
    [item.left.id, item.right.id].filter((id) => id !== target);

  const loadPreview = async (item: OrganizationCleanupCluster, target: string) => {
    setTargetId(target);
    setPreview(null);
    setError('');
    try {
      const result = await clientRequest('/api/admin/organizations/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceIds: sourceIds(item, target), targetId: target }),
      });
      const payload = await readClientResponseJson<OrganizationMergePreview | { error?: string }>(
        result.response,
      );
      if (!result.ok || !payload || !('profiles' in payload)) {
        setError(
          result.ok
            ? 'Предпросмотр вернул неполные данные.'
            : clientRequestMessage(result.error, 'Не удалось построить предпросмотр.'),
        );
        return;
      }
      setPreview(payload);
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось построить предпросмотр.'));
    }
  };

  const openCluster = (item: OrganizationCleanupCluster) => {
    setCluster(item);
    setPolicy('preserve');
    setConfirmation('');
    setIdempotencyKey(crypto.randomUUID());
    void loadPreview(item, item.left.id);
  };

  const close = () => {
    if (busy) return;
    setCluster(null);
    setPreview(null);
    setError('');
  };

  const requiredPhrase =
    policy === 'reissue' && (preview?.activeCertificates ?? 0) >= 20
      ? `ПЕРЕВЫПУСТИТЬ ${preview?.activeCertificates ?? 0}`
      : '';

  const submit = async () => {
    if (!cluster || !preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await clientRequest('/api/admin/organizations/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey,
          sourceIds: sourceIds(cluster, targetId),
          targetId,
          reissueCertificates: policy === 'reissue',
          reason: 'Объединение дубликатов организаций',
        }),
      });
      const payload = await readClientResponseJson<OrganizationMergeResult | { error?: string }>(
        result.response,
      );
      if (!result.ok || !payload || !('profilesUpdated' in payload)) {
        setError(
          result.ok
            ? 'Сервер вернул неполный результат.'
            : clientRequestMessage(result.error, 'Компании не объединены.'),
        );
        return;
      }
      setMessage(
        `Готово: «${payload.canonicalName}», обновлено профилей ${payload.profilesUpdated}. ` +
          (payload.certificatePolicy === 'reissued'
            ? `Затронуто действующих сертификатов: ${payload.activeCertificatesAffected}.`
            : 'Действующие сертификаты сохранены без изменений.'),
      );
      setCluster(null);
      setPreview(null);
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Компании не объединены.'));
    } finally {
      setBusy(false);
    }
  };

  if (clusters.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed p-8 text-center">
        <p className="font-semibold">Похожие названия не найдены</p>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Каталог компаний не требует ручной очистки.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {message ? (
        <p role="status" className="rounded-xl bg-[var(--color-primary-soft)] p-4 text-sm">
          {message}
        </p>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {clusters.map((item) => (
          <Card key={`${item.left.id}:${item.right.id}`}>
            <CardContent className="space-y-4 p-4 md:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <Badge variant="warning">Сходство {Math.round(item.similarity * 100)}%</Badge>
                <span className="text-xs text-[var(--color-text-muted)]">
                  Действующих сертификатов: {item.activeCertificates}
                </span>
              </div>
              <div className="grid gap-2 min-[480px]:grid-cols-[1fr_auto_1fr] min-[480px]:items-center">
                <div className="rounded-xl border p-3">
                  <p className="font-semibold break-words">{item.left.canonicalName}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {item.left.participants} участников
                  </p>
                </div>
                <ArrowsMerge className="mx-auto text-[var(--color-text-subtle)]" />
                <div className="rounded-xl border p-3">
                  <p className="font-semibold break-words">{item.right.canonicalName}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {item.right.participants} участников
                  </p>
                </div>
              </div>
              <Button size="sm" onClick={() => openCluster(item)}>
                Проверить и объединить
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <dialog
        ref={dialogRef}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => {
          if (cluster && !busy) setCluster(null);
        }}
        className="m-auto max-h-[92dvh] w-[min(44rem,calc(100vw-1rem))] overflow-y-auto rounded-2xl border bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-pop)] backdrop:bg-black/55"
      >
        {cluster ? (
          <form
            className="space-y-5 p-4 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <header className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl font-bold">Объединить компании</h2>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  Автоматического объединения не будет: выберите итог и политику документов.
                </p>
              </div>
              <Button type="button" size="icon" variant="ghost" onClick={close} aria-label="Закрыть">
                <X />
              </Button>
            </header>

            <fieldset className="space-y-2">
              <legend className="font-semibold">Каноническое название</legend>
              {[cluster.left, cluster.right].map((organization) => (
                <label key={organization.id} className="flex min-h-12 items-center gap-3 rounded-xl border p-3">
                  <input
                    type="radio"
                    name="canonical-organization"
                    value={organization.id}
                    checked={targetId === organization.id}
                    onChange={() => void loadPreview(cluster, organization.id)}
                    className="size-5 accent-[var(--color-primary)]"
                  />
                  <span className="font-semibold break-words">{organization.canonicalName}</span>
                </label>
              ))}
            </fieldset>

            {preview ? (
              <div className="grid gap-2 rounded-xl bg-[var(--color-surface-muted)] p-4 text-sm min-[480px]:grid-cols-3">
                <p><strong>{preview.profiles}</strong><br />профилей изменится</p>
                <p><strong>{preview.verifiedIdentities}</strong><br />проверенных данных</p>
                <p><strong>{preview.activeCertificates}</strong><br />действующих сертификатов</p>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-text-muted)]">Строим предпросмотр…</p>
            )}

            <fieldset className="space-y-2">
              <legend className="font-semibold">Что делать с документами</legend>
              <label className="block rounded-xl border p-3">
                <span className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="certificate-policy"
                    checked={policy === 'preserve'}
                    onChange={() => setPolicy('preserve')}
                    className="mt-0.5 size-5 accent-[var(--color-primary)]"
                  />
                  <span>
                    <strong className="block">Только профили и будущие документы</strong>
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Выданные PDF и их номера останутся неизменными.
                    </span>
                  </span>
                </span>
              </label>
              <label className="block rounded-xl border p-3">
                <span className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="certificate-policy"
                    checked={policy === 'reissue'}
                    onChange={() => setPolicy('reissue')}
                    className="mt-0.5 size-5 accent-[var(--color-primary)]"
                  />
                  <span>
                    <strong className="block">Перевыпустить действующие сертификаты</strong>
                    <span className="text-sm text-[var(--color-text-muted)]">
                      Старые документы будут отозваны, новые получат другие номера.
                    </span>
                  </span>
                </span>
              </label>
            </fieldset>


            {requiredPhrase ? (
              <div className="space-y-2 rounded-xl bg-[var(--color-danger-soft)] p-3">
                <Label htmlFor="organization-merge-confirmation">
                  Введите <strong>{requiredPhrase}</strong>
                </Label>
                <Input
                  id="organization-merge-confirmation"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  required
                  autoComplete="off"
                />
              </div>
            ) : null}

            {error ? <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={close} disabled={busy}>Отмена</Button>
              <Button
                type="submit"
                disabled={busy || !preview || Boolean(requiredPhrase && confirmation !== requiredPhrase)}
              >
                {busy ? 'Объединяем…' : 'Объединить'}
              </Button>
            </div>
          </form>
        ) : null}
      </dialog>
    </div>
  );
}
