'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';

type Receipt = {
  expected: number;
  published: number;
  skipped: number;
  verified: number;
};

export function InitialArticleImportForm({ confirmation }: { confirmation: string }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setReceipt(null);
    try {
      const result = await clientRequest(
        '/api/admin/articles/initial-import',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmation: value }),
        },
        { timeoutMs: 120_000 },
      );
      const payload = await readClientResponseJson<Receipt & { error?: string }>(
        result.response,
        5_000,
      );
      if (result.ok && payload) {
        setReceipt(payload);
        setValue('');
        return;
      }
      const responseError = result.ok ? new Error('CLIENT_RESPONSE_INVALID') : result.error;
      setError(
        payload?.error === 'INITIAL_ARTICLE_HOSTED_CONFLICT'
          ? 'В размещённом каталоге есть несовместимые материалы. Импорт остановлен.'
          : payload?.error === 'INITIAL_ARTICLE_CONFIRMATION_MISMATCH'
            ? 'Строка подтверждения не совпадает.'
            : clientRequestMessage(responseError, 'Не удалось импортировать материалы.'),
      );
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось импортировать материалы.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="initial-article-import-confirmation">Строка подтверждения</Label>
        <Input
          id="initial-article-import-confirmation"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={160}
          required
        />
      </div>
      <Button type="submit" disabled={busy || value !== confirmation}>
        {busy ? 'Публикуем…' : 'Опубликовать утверждённый снимок'}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      {receipt ? (
        <p role="status" className="text-sm text-[var(--color-success)]">
          Проверено: {receipt.verified}/{receipt.expected}. Опубликовано: {receipt.published}.
          Пропущено без изменений: {receipt.skipped}.
        </p>
      ) : null}
    </form>
  );
}
