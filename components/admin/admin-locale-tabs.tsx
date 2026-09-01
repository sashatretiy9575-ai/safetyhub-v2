'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AppLocale } from '@/lib/supabase/types';
import {
  ADMIN_CONTENT_LOCALES,
  ADMIN_LOCALE_LABELS,
  ADMIN_LOCALIZATION_STATUS_LABELS,
  type AdminLocalizationStatus,
} from '@/features/admin/localization-contract';

export function AdminLocaleTabs({
  activeLocale,
  statuses,
  onChange,
  label = 'Языки локализации',
  idPrefix = 'localization',
}: {
  activeLocale: AppLocale;
  statuses: Record<AppLocale, AdminLocalizationStatus>;
  onChange: (locale: AppLocale) => void;
  label?: string;
  idPrefix?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {ADMIN_CONTENT_LOCALES.map((locale) => {
        const status = statuses[locale];
        const localeIndex = ADMIN_CONTENT_LOCALES.indexOf(locale);
        return (
          <button
            key={locale}
            type="button"
            role="tab"
            aria-selected={locale === activeLocale}
            aria-controls={`${idPrefix}-panel-${locale}`}
            id={`${idPrefix}-tab-${locale}`}
            tabIndex={locale === activeLocale ? 0 : -1}
            className={cn(
              'flex min-h-14 min-w-0 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left',
              locale === activeLocale
                ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]'
                : 'bg-[var(--color-surface)] hover:bg-[var(--color-surface-muted)]',
            )}
            onClick={() => onChange(locale)}
            onKeyDown={(event) => {
              const targetIndex =
                event.key === 'ArrowRight'
                  ? (localeIndex + 1) % ADMIN_CONTENT_LOCALES.length
                  : event.key === 'ArrowLeft'
                    ? (localeIndex - 1 + ADMIN_CONTENT_LOCALES.length) %
                      ADMIN_CONTENT_LOCALES.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? ADMIN_CONTENT_LOCALES.length - 1
                        : null;
              if (targetIndex === null) return;
              event.preventDefault();
              const targetLocale = ADMIN_CONTENT_LOCALES[targetIndex]!;
              onChange(targetLocale);
              window.requestAnimationFrame(() =>
                document.getElementById(`${idPrefix}-tab-${targetLocale}`)?.focus(),
              );
            }}
          >
            <span className="min-w-0">
              <span className="block text-xs font-black text-[var(--color-text-muted)] uppercase">
                {locale}
              </span>
              <span className="block truncate text-sm font-bold">
                {ADMIN_LOCALE_LABELS[locale]}
              </span>
            </span>
            <Badge
              variant={
                status === 'published'
                  ? 'success'
                  : status === 'complete'
                    ? 'sapphire'
                    : status === 'draft'
                      ? 'warning'
                      : 'default'
              }
            >
              {ADMIN_LOCALIZATION_STATUS_LABELS[status]}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
