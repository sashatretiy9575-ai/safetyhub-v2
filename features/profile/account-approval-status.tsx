'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ContactLink } from '@/components/shared/contact-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';

type ApprovalState = 'profile_incomplete' | 'pending' | 'approved' | 'rejected';

function formatRemaining(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

function ReviewContacts({ contacts }: { contacts: SiteContactSettings }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <ContactLink
        kind="phone"
        contacts={contacts}
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm font-semibold transition hover:border-[var(--color-primary)] focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)]"
      >
        Позвонить: {contacts.phoneDisplay}
      </ContactLink>
      <ContactLink
        kind="whatsapp"
        contacts={contacts}
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-md)] border border-[#128c4a]/45 px-3 text-sm font-semibold text-[#128c4a] transition hover:bg-[#128c4a]/10 focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)] dark:text-[#39dc7a]"
      >
        Написать в WhatsApp
      </ContactLink>
    </div>
  );
}

export function AccountApprovalStatus({
  state,
  dueAt,
  rejectionReason,
  contacts,
}: {
  state: ApprovalState;
  dueAt: string | null;
  rejectionReason: string | null;
  contacts: SiteContactSettings;
}) {
  const dueTimestamp = useMemo(() => {
    if (!dueAt) return null;
    const parsed = Date.parse(dueAt);
    return Number.isFinite(parsed) ? parsed : null;
  }, [dueAt]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state !== 'pending' || dueTimestamp === null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [dueTimestamp, state]);

  if (state === 'approved') return null;

  if (state === 'profile_incomplete') {
    return (
      <Card className="border-[var(--color-warning)]">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div>
            <p className="text-xs font-bold tracking-wide text-[var(--color-warning)] uppercase">Доступ к обучению</p>
            <h2 className="font-display mt-1 text-xl font-bold">Сначала заполните профиль</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
              Добавьте свои данные, номер телефона и фотографию. После отправки заявку проверит администратор.
            </p>
          </div>
          <Button asChild size="sm"><Link href="/onboarding">Заполнить профиль</Link></Button>
        </CardContent>
      </Card>
    );
  }

  if (state === 'rejected') {
    return (
      <Card className="border-[var(--color-danger)]">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div>
            <p className="text-xs font-bold tracking-wide text-[var(--color-danger)] uppercase">Нужны уточнения</p>
            <h2 className="font-display mt-1 text-xl font-bold">Заявка пока не подтверждена</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
              Проверьте данные в профиле и отправьте их повторно. До подтверждения курсы и тесты недоступны.
            </p>
          </div>
          {rejectionReason ? (
            <p className="rounded-xl bg-[var(--color-danger)]/10 p-3 text-sm leading-6">
              <strong>Комментарий администратора:</strong> {rejectionReason}
            </p>
          ) : null}
          <ReviewContacts contacts={contacts} />
        </CardContent>
      </Card>
    );
  }

  const remaining = dueTimestamp === null ? null : dueTimestamp - now;
  const expired = remaining !== null && remaining <= 0;

  return (
    <Card className="border-[var(--color-primary)]">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div>
          <p className="text-xs font-bold tracking-wide text-[var(--color-primary)] uppercase">Заявка на проверке</p>
          <h2 className="font-display mt-1 text-xl font-bold">Администратор проверяет ваши данные</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
            До подтверждения нельзя открыть вопросы курса, презентацию или начать тест.
          </p>
        </div>
        {remaining === null ? (
          <p className="rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm">
            Мы сообщим в личном кабинете, когда заявка будет рассмотрена.
          </p>
        ) : expired ? (
          <p className="rounded-xl bg-[var(--color-accent-amber-soft)] p-3 text-sm leading-6">
            Срок проверки в 24 часа уже прошёл. Позвоните администратору или напишите в WhatsApp — он проверит статус вручную.
          </p>
        ) : (
          <div className="rounded-xl bg-[var(--color-primary-soft)] p-3">
            <p className="text-xs font-semibold text-[var(--color-text-muted)]">Осталось до контрольного срока</p>
            <p aria-live="polite" className="mt-1 font-mono text-2xl font-bold tracking-wide text-[var(--color-primary)]">
              {formatRemaining(remaining)}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Не нужно обновлять страницу: счётчик идёт сам.</p>
          </div>
        )}
        <ReviewContacts contacts={contacts} />
      </CardContent>
    </Card>
  );
}
