'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { WarningCircle } from '@phosphor-icons/react';

export default function AdminError({ error: _error, reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="grid min-h-[60vh] place-items-center px-6 py-16 text-center">
      <div className="space-y-4">
        <div className="grid place-items-center text-[var(--color-danger)]">
          <WarningCircle className="size-10" />
        </div>
        <h1 className="font-display text-2xl font-semibold">Ошибка в админ-панели</h1>
        <p className="max-w-md text-sm text-[var(--color-text-muted)]">
          Не удалось загрузить раздел. Попробуйте повторить попытку или вернуться в обзор.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Button onClick={reset}>Попробовать снова</Button>
          <Button asChild variant="outline">
            <Link href="/admin" prefetch={false}>В обзор</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/" prefetch={false}>На главную</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
