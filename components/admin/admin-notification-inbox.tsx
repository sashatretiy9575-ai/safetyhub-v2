'use client';

import Link from 'next/link';
import { ArrowClockwise, Bell, Check, CheckCircle, Warning, XCircle } from '@phosphor-icons/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AdminNotificationEvent,
  AdminNotificationPage,
} from '@/features/admin/notification-contract';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Every poll is a serverless invocation plus two Supabase round-trips, which
// measured around half a second on production. Four of those a minute ran
// against the operator's own navigations for a badge that is never urgent;
// admin actions still refresh the inbox immediately through the event below.
const POLL_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
export const ADMIN_NOTIFICATION_REFRESH_EVENT = 'safetyhub:admin-action-complete';

type PollState = 'idle' | 'loading' | 'ready' | 'offline' | 'failed' | 'forbidden';
type InboxContextValue = Readonly<{
  enabled: boolean;
  page: AdminNotificationPage | null;
  state: PollState;
  message: string;
  loadingMore: boolean;
  refresh: () => void;
  loadMore: () => Promise<void>;
  markRead: (eventIds: string[]) => Promise<boolean>;
  retryDelivery: (eventId: string) => Promise<boolean>;
}>;

const InboxContext = createContext<InboxContextValue | null>(null);

function canPoll() {
  return document.visibilityState === 'visible' && navigator.onLine !== false;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MACHINE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/u;
const PHONE_COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const PHONE_E164_PATTERN = /^\+[1-9][0-9]{1,14}$/u;
const DELIVERY_STATES = new Set(['pending', 'leased', 'retry', 'delivered', 'dead']);
const LOCALES = new Set(['ru', 'kk', 'en', 'zh']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isSingleLine(value: unknown, maximum = 240): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isAdminPath(value: unknown): value is string {
  return isSingleLine(value) && /^\/admin(?:\/|$)/u.test(value);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isDelivery(value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'attempts', 'lastErrorCategory'])) {
    return false;
  }
  return (
    typeof value.status === 'string' &&
    DELIVERY_STATES.has(value.status) &&
    isBoundedInteger(value.attempts, 0, 10) &&
    (value.lastErrorCategory === null ||
      (typeof value.lastErrorCategory === 'string' &&
        /^[A-Z0-9_]{1,64}$/u.test(value.lastErrorCategory)))
  );
}

function isEnvelope(value: Record<string, unknown>) {
  return (
    isUuid(value.id) &&
    isUuid(value.correlationId) &&
    isTimestamp(value.occurredAt) &&
    (value.readAt === null || isTimestamp(value.readAt)) &&
    isDelivery(value.delivery)
  );
}

function parseEvent(value: unknown): AdminNotificationEvent | null {
  if (!isRecord(value) || !isEnvelope(value) || !isRecord(value.payload)) return null;
  const payload = value.payload;

  if (value.type === 'account.approval_requested') {
    const genericV2Keys = ['schemaVersion', 'locale', 'requestedAt', 'adminPath'];
    const legacyGenericKeys = ['name', 'surname', 'locale', 'requestedAt', 'adminPath'];
    const applicationKeys = [
      'name',
      'surname',
      'job',
      'organization',
      'phoneCountryIso2',
      'phoneE164',
    ];
    const hasApplicationDetails = hasExactKeys(payload, applicationKeys);
    const hasGenericV2 = hasExactKeys(payload, genericV2Keys);
    const hasLegacyGeneric = hasExactKeys(payload, legacyGenericKeys);
    if (!(hasGenericV2 || hasLegacyGeneric || hasApplicationDetails)) {
      return null;
    }
    if (
      hasGenericV2 &&
      (payload.schemaVersion !== 2 ||
        typeof payload.locale !== 'string' ||
        !LOCALES.has(payload.locale) ||
        !isTimestamp(payload.requestedAt) ||
        !isAdminPath(payload.adminPath))
    ) {
      return null;
    }
    if (
      hasApplicationDetails &&
      (!isSingleLine(payload.name) ||
        !isSingleLine(payload.surname) ||
        !isSingleLine(payload.job, 160) ||
        !isSingleLine(payload.organization, 160) ||
        typeof payload.phoneCountryIso2 !== 'string' ||
        !PHONE_COUNTRY_PATTERN.test(payload.phoneCountryIso2) ||
        typeof payload.phoneE164 !== 'string' ||
        !PHONE_E164_PATTERN.test(payload.phoneE164))
    ) {
      return null;
    }
    if (
      hasLegacyGeneric &&
      (typeof payload.locale !== 'string' ||
        !LOCALES.has(payload.locale) ||
        !isTimestamp(payload.requestedAt) ||
        !isAdminPath(payload.adminPath))
    ) {
      return null;
    }
    const isExactLegacyBlankZh =
      hasLegacyGeneric && payload.name === '' && payload.surname === '' && payload.locale === 'zh';
    if (
      hasLegacyGeneric &&
      !isExactLegacyBlankZh &&
      (!isSingleLine(payload.name) || !isSingleLine(payload.surname))
    ) {
      return null;
    }
  } else if (value.type === 'course.completed') {
    if (
      !hasExactKeys(payload, [
        'attemptId',
        'userId',
        'name',
        'surname',
        'locale',
        'courseTitle',
        'result',
        'score',
        'total',
        'completedAt',
        'adminPath',
      ]) ||
      !isUuid(payload.attemptId) ||
      !isUuid(payload.userId) ||
      !isSingleLine(payload.name) ||
      !isSingleLine(payload.surname) ||
      typeof payload.locale !== 'string' ||
      !LOCALES.has(payload.locale) ||
      !isSingleLine(payload.courseTitle) ||
      (payload.result !== 'passed' && payload.result !== 'failed') ||
      !isBoundedInteger(payload.score, 0, 1_000) ||
      !isBoundedInteger(payload.total, 1, 1_000) ||
      Number(payload.score) > Number(payload.total) ||
      !isTimestamp(payload.completedAt) ||
      !isAdminPath(payload.adminPath)
    ) {
      return null;
    }
  } else if (value.type === 'system.alert') {
    if (
      !hasExactKeys(payload, ['machineCode', 'correlationId', 'adminPath']) ||
      typeof payload.machineCode !== 'string' ||
      !MACHINE_CODE_PATTERN.test(payload.machineCode) ||
      !isUuid(payload.correlationId) ||
      payload.correlationId !== value.correlationId ||
      !isAdminPath(payload.adminPath)
    ) {
      return null;
    }
  } else {
    return null;
  }

  if (
    !hasExactKeys(value, [
      'id',
      'correlationId',
      'occurredAt',
      'readAt',
      'delivery',
      'type',
      'payload',
    ])
  ) {
    return null;
  }
  return value as AdminNotificationEvent;
}

function parsePage(value: unknown): AdminNotificationPage | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['items', 'unread', 'serverNow', 'hasMore', 'nextCursor']) ||
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !isBoundedInteger(value.unread, 0, Number.MAX_SAFE_INTEGER) ||
    !isTimestamp(value.serverNow) ||
    typeof value.hasMore !== 'boolean'
  ) {
    return null;
  }
  const items = value.items.map(parseEvent);
  if (items.some((event) => event === null)) return null;
  if (
    value.nextCursor !== null &&
    (!isRecord(value.nextCursor) ||
      !hasExactKeys(value.nextCursor, ['occurredAt', 'id']) ||
      !isTimestamp(value.nextCursor.occurredAt) ||
      !isUuid(value.nextCursor.id))
  ) {
    return null;
  }
  return { ...value, items } as AdminNotificationPage;
}

export function requestAdminNotificationRefresh() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ADMIN_NOTIFICATION_REFRESH_EVENT));
  }
}

export function AdminNotificationInboxProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const [page, setPage] = useState<AdminNotificationPage | null>(null);
  const [state, setState] = useState<PollState>('idle');
  const [message, setMessage] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const etagRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const wakeRef = useRef<() => void>(() => undefined);

  const refresh = useCallback(() => wakeRef.current(), []);

  const mutate = useCallback(async (url: string, body: unknown) => {
    const result = await clientRequest(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (!result.ok) {
      setMessage(
        clientRequestMessage(result.error, 'Не удалось обновить уведомления. Повторите попытку.'),
      );
      return false;
    }
    setMessage('');
    requestAdminNotificationRefresh();
    return true;
  }, []);

  const markRead = useCallback(
    async (eventIds: string[]) => {
      if (eventIds.length === 0 || eventIds.length > 100) return false;
      return mutate('/api/admin/notifications/read', { eventIds });
    },
    [mutate],
  );

  const retryDelivery = useCallback(
    (eventId: string) => mutate(`/api/admin/notifications/${eventId}/retry`, {}),
    [mutate],
  );

  const loadMore = useCallback(async () => {
    const cursor = page?.nextCursor;
    if (!cursor || loadingMore || !canPoll()) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: '30',
        beforeOccurredAt: cursor.occurredAt,
        beforeId: cursor.id,
      });
      const result = await clientRequest(
        `/api/admin/notifications?${params.toString()}`,
        {},
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (!result.ok) {
        setMessage(
          clientRequestMessage(result.error, 'Не удалось загрузить предыдущие уведомления.'),
        );
        return;
      }
      const nextPage = parsePage(
        await readClientResponseJson<unknown>(result.response, REQUEST_TIMEOUT_MS),
      );
      if (!nextPage) {
        setMessage('Сервер вернул неполную страницу уведомлений.');
        return;
      }
      setPage((current) => {
        if (!current) return nextPage;
        const known = new Set(current.items.map((event) => event.id));
        return {
          ...nextPage,
          items: [...current.items, ...nextPage.items.filter((event) => !known.has(event.id))],
        };
      });
      setMessage('');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, page?.nextCursor]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveFailures = 0;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (!cancelled && canPoll()) timer = setTimeout(run, delay);
    };
    const run = async () => {
      clearTimer();
      if (cancelled || !canPoll()) {
        if (navigator.onLine === false) setState('offline');
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState((current) => (current === 'idle' ? 'loading' : current));
      const result = await clientRequest(
        '/api/admin/notifications?limit=30',
        {
          headers: etagRef.current ? { 'If-None-Match': etagRef.current } : undefined,
        },
        { signal: controller.signal, timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (cancelled || controller.signal.aborted) return;

      if (!result.ok && result.response?.status === 304) {
        consecutiveFailures = 0;
        setState('ready');
        setMessage('');
        schedule(POLL_INTERVAL_MS);
        return;
      }
      if (!result.ok) {
        if (result.response?.status === 401 || result.response?.status === 403) {
          setState('forbidden');
          return;
        }
        consecutiveFailures = Math.min(consecutiveFailures + 1, 4);
        setState(navigator.onLine === false ? 'offline' : 'failed');
        setMessage(clientRequestMessage(result.error, 'Уведомления временно не обновляются.'));
        schedule(Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** consecutiveFailures));
        return;
      }

      const payload = parsePage(
        await readClientResponseJson<unknown>(result.response, REQUEST_TIMEOUT_MS),
      );
      if (!payload) {
        consecutiveFailures = Math.min(consecutiveFailures + 1, 4);
        setState('failed');
        setMessage('Сервер вернул неполный список уведомлений.');
        schedule(Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * 2 ** consecutiveFailures));
        return;
      }

      const etag = result.response.headers.get('etag');
      if (etag) etagRef.current = etag;
      consecutiveFailures = 0;
      setPage(payload);
      setState('ready');
      setMessage('');
      schedule(POLL_INTERVAL_MS);
    };

    const wake = () => {
      clearTimer();
      if (canPoll()) void run();
      else {
        abortRef.current?.abort();
        if (navigator.onLine === false) setState('offline');
      }
    };
    wakeRef.current = wake;

    const onVisibilityChange = () => wake();
    const onOnline = () => wake();
    const onOffline = () => {
      clearTimer();
      abortRef.current?.abort();
      setState('offline');
    };
    window.addEventListener(ADMIN_NOTIFICATION_REFRESH_EVENT, wake);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    wake();

    return () => {
      cancelled = true;
      clearTimer();
      abortRef.current?.abort();
      wakeRef.current = () => undefined;
      window.removeEventListener(ADMIN_NOTIFICATION_REFRESH_EVENT, wake);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled]);

  const value = useMemo<InboxContextValue>(
    () => ({
      enabled,
      page,
      state,
      message,
      loadingMore,
      refresh,
      loadMore,
      markRead,
      retryDelivery,
    }),
    [enabled, page, state, message, loadingMore, refresh, loadMore, markRead, retryDelivery],
  );
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}

function useInbox() {
  const context = useContext(InboxContext);
  if (!context) throw new Error('ADMIN_NOTIFICATION_INBOX_PROVIDER_REQUIRED');
  return context;
}

function dateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'время недоступно';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Oral',
  }).format(date);
}

function eventPresentation(event: AdminNotificationEvent) {
  switch (event.type) {
    case 'account.approval_requested': {
      if ('schemaVersion' in event.payload) {
        return {
          icon: Bell,
          title: 'Новая заявка на обучение',
          description: `Новая заявка · ${event.payload.locale.toUpperCase()}`,
        };
      }
      const applicationSummary =
        'job' in event.payload
          ? ` · ${event.payload.job} · ${event.payload.organization} · ${event.payload.phoneE164}`
          : '';
      if ('locale' in event.payload && event.payload.name === '' && event.payload.surname === '') {
        return {
          icon: Bell,
          title: 'Новая заявка на обучение',
          description: `Новая заявка · ${event.payload.locale.toUpperCase()}`,
        };
      }
      return {
        icon: Bell,
        title: 'Новая заявка на обучение',
        description: `${event.payload.surname} ${event.payload.name}${applicationSummary}`,
      };
    }
    case 'course.completed':
      return {
        icon: event.payload.result === 'passed' ? CheckCircle : XCircle,
        title: event.payload.result === 'passed' ? 'Курс пройден' : 'Курс не пройден',
        description: `${event.payload.surname} ${event.payload.name} · ${event.payload.courseTitle} · ${event.payload.score}/${event.payload.total}`,
      };
    case 'system.alert':
      return {
        icon: Warning,
        title: 'Системное уведомление',
        description: event.payload.machineCode,
      };
  }
}

function eventAdminPath(event: AdminNotificationEvent) {
  return 'adminPath' in event.payload ? event.payload.adminPath : '/admin/approvals';
}

const deliveryLabels = {
  pending: 'Telegram: ожидает отправки',
  leased: 'Telegram: отправляется',
  retry: 'Telegram: будет повторён',
  delivered: 'Telegram: доставлено',
  dead: 'Telegram: требуется повтор',
} as const;

export function AdminNotificationInboxButton({
  placement,
  className,
}: {
  placement: 'desktop' | 'mobile';
  className?: string;
}) {
  const { enabled, page, state, message, loadingMore, refresh, loadMore, markRead, retryDelivery } =
    useInbox();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!enabled || state === 'forbidden') return null;
  const unreadIds =
    page?.items.filter((event) => event.readAt === null).map((event) => event.id) ?? [];

  const markVisibleRead = async () => {
    if (unreadIds.length === 0) return;
    setBusy('read');
    try {
      await markRead(unreadIds);
    } finally {
      setBusy(null);
    }
  };

  const retry = async (eventId: string) => {
    setBusy(eventId);
    try {
      await retryDelivery(eventId);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-label={page?.unread ? `Уведомления: непрочитанных ${page.unread}` : 'Уведомления'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) refresh();
        }}
        className="relative grid size-11 place-items-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
      >
        <Bell size={20} />
        {page?.unread ? (
          <span className="absolute -top-0.5 -right-0.5 grid min-h-5 min-w-5 place-items-center rounded-full bg-[var(--color-danger)] px-1 text-[10px] font-black text-[var(--color-danger-foreground)]">
            {page.unread > 99 ? '99+' : page.unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <section
          role="dialog"
          aria-label="Уведомления администратора"
          className={cn(
            'z-[80] w-[min(24rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-elevated)] shadow-[var(--shadow-pop)]',
            placement === 'desktop'
              ? 'absolute bottom-0 left-[calc(100%+0.75rem)]'
              : 'fixed top-[calc(var(--safe-area-top)+3.5rem)] right-2',
          )}
        >
          <header className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4">
            <div className="min-w-0">
              <h2 className="font-display font-bold">Уведомления</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                {page ? `Непрочитанных: ${page.unread}` : 'Загрузка списка'}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Обновить уведомления"
                onClick={refresh}
              >
                <ArrowClockwise />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Отметить видимые уведомления прочитанными"
                disabled={unreadIds.length === 0 || busy !== null}
                onClick={() => void markVisibleRead()}
              >
                <Check />
              </Button>
            </div>
          </header>

          <div className="max-h-[min(32rem,70dvh)] overflow-y-auto overscroll-contain">
            {page?.items.length ? (
              <ul className="divide-y divide-[var(--color-border)]">
                {page.items.map((event) => {
                  const presentation = eventPresentation(event);
                  const Icon = presentation.icon;
                  const retryable =
                    event.delivery.status === 'retry' || event.delivery.status === 'dead';
                  return (
                    <li
                      key={event.id}
                      className={cn(
                        'p-3',
                        event.readAt === null && 'bg-[var(--color-primary-soft)]/35',
                      )}
                    >
                      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2">
                        <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-primary)]">
                          <Icon size={17} />
                        </span>
                        <div className="min-w-0">
                          <Link
                            href={eventAdminPath(event)}
                            prefetch={false}
                            className="block rounded-sm focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus)]"
                            onClick={() => {
                              setOpen(false);
                              if (event.readAt === null) void markRead([event.id]);
                            }}
                          >
                            <span className="block text-sm font-bold">{presentation.title}</span>
                            <span className="mt-0.5 block text-xs leading-5 break-words text-[var(--color-text-muted)]">
                              {presentation.description}
                            </span>
                          </Link>
                          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--color-text-subtle)]">
                            <time dateTime={event.occurredAt}>{dateTime(event.occurredAt)}</time>
                            <span>{deliveryLabels[event.delivery.status]}</span>
                          </div>
                          {retryable ? (
                            <button
                              type="button"
                              className="mt-2 min-h-11 rounded-lg px-2 text-xs font-bold text-[var(--color-primary)] underline-offset-4 hover:underline disabled:opacity-50"
                              disabled={busy !== null}
                              onClick={() => void retry(event.id)}
                            >
                              Повторить отправку в Telegram
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : state === 'loading' || state === 'idle' ? (
              <p className="p-5 text-sm text-[var(--color-text-muted)]">Загружаем уведомления…</p>
            ) : (
              <p className="p-5 text-sm text-[var(--color-text-muted)]">Новых уведомлений нет.</p>
            )}
            {page?.hasMore ? (
              <div className="border-t border-[var(--color-border)] p-3 text-center">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Загружаем…' : 'Показать предыдущие'}
                </Button>
              </div>
            ) : null}
          </div>

          {state === 'offline' || state === 'failed' || message ? (
            <p
              role="status"
              aria-live="polite"
              className="border-t border-[var(--color-border)] px-4 py-3 text-xs text-[var(--color-text-muted)]"
            >
              {state === 'offline' ? 'Обновление продолжится после подключения к сети.' : message}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
