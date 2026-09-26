import Link from 'next/link';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr/MagnifyingGlass';
import { Button } from '@/components/ui/button';

/**
 * A wrong or stale admin link used to fall through to the public 404 page,
 * which dropped the operator out of the panel chrome entirely.
 */
export default function AdminNotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center px-6 py-16 text-center">
      <div className="space-y-4">
        <div className="grid place-items-center text-[var(--color-text-muted)]">
          <MagnifyingGlass aria-hidden="true" className="size-10" />
        </div>
        <h1 className="font-display text-h3 font-semibold">Раздел не найден</h1>
        <p className="max-w-md text-sm text-[var(--color-text-muted)]">
          Такой страницы в админ-панели нет. Возможно, ссылка устарела или запись была удалена.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Button asChild>
            <Link href="/admin" prefetch={false}>
              В обзор
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/employees" prefetch={false}>
              К сотрудникам
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
