'use client';

import { useId, useMemo, useState } from 'react';
import { AdminLocaleTabs } from '@/components/admin/admin-locale-tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  ADMIN_CONTENT_LOCALES,
  ADMIN_LOCALE_LABELS,
  ADMIN_LOCALIZATION_STATUS_LABELS,
  type LegalLocalizationVersion,
} from '@/features/admin/localization-contract';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import type { AppLocale } from '@/lib/supabase/types';

type MutationResponse = {
  locale?: AppLocale;
  status?: 'draft' | 'complete' | 'published';
  bodyHash?: string;
  error?: string;
};

function previewStrings(value: unknown, result: string[] = []): string[] {
  if (result.length >= 100) return result;
  if (typeof value === 'string' && value.trim()) result.push(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => previewStrings(item, result));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => previewStrings(item, result));
  }
  return result;
}

function previewFont(locale: AppLocale) {
  return locale === 'zh'
    ? "'SafetyHub Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif"
    : undefined;
}

function LegalVersionEditor({
  initial,
  onChange,
}: {
  initial: LegalLocalizationVersion;
  onChange: (version: LegalLocalizationVersion) => void;
}) {
  const idPrefix = `legal-${useId().replaceAll(':', '')}`;
  const [version, setVersion] = useState(() => structuredClone(initial));
  const [activeLocale, setActiveLocale] = useState<AppLocale>('ru');
  const [bodyText, setBodyText] = useState(() =>
    JSON.stringify(version.localizations[0]?.body ?? {}, null, 2),
  );
  const [completeRequested, setCompleteRequested] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const activeIndex = version.localizations.findIndex((item) => item.locale === activeLocale);
  const active = version.localizations[activeIndex]!;
  const statuses = Object.fromEntries(
    ADMIN_CONTENT_LOCALES.map((locale) => [
      locale,
      version.localizations.find((item) => item.locale === locale)?.status ?? 'missing',
    ]),
  ) as Record<AppLocale, (typeof active)['status']>;
  const allReady = Object.values(statuses).every(
    (status) => status === 'complete' || status === 'published',
  );
  const parsedBody = useMemo(() => {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }, [bodyText]);

  const selectLocale = (locale: AppLocale) => {
    const next = version.localizations.find((item) => item.locale === locale)!;
    setActiveLocale(locale);
    setBodyText(JSON.stringify(next.body, null, 2));
    setCompleteRequested(next.status === 'complete' || next.status === 'published');
    setPreview(false);
    setMessage('');
    setError('');
  };

  const updateActive = (update: Partial<typeof active>) => {
    if (active.immutable) return;
    setVersion((current) => ({
      ...current,
      localizations: current.localizations.map((item) =>
        item.locale === activeLocale ? { ...item, ...update, status: 'draft' } : item,
      ),
    }));
    setCompleteRequested(false);
    setMessage('');
  };

  const save = async () => {
    if (!parsedBody || active.immutable) {
      setError(
        active.immutable ? 'Опубликованная копия неизменяема.' : 'Исправьте JSON документа.',
      );
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const request = await clientRequest('/api/admin/legal/localizations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentType: version.documentType,
          version: version.version,
          locale: activeLocale,
          title: active.title,
          body: parsedBody,
          complete: completeRequested,
        }),
      });
      const payload = await readClientResponseJson<MutationResponse>(request.response);
      if (!request.ok || !payload?.status || !payload.bodyHash) {
        setError(
          payload?.error
            ? 'Не удалось сохранить юридическую локализацию.'
            : clientRequestMessage(
                request.ok ? new Error('INVALID_RESPONSE') : request.error,
                'Не удалось сохранить юридическую локализацию.',
              ),
        );
        return;
      }
      const savedVersion: LegalLocalizationVersion = {
        ...version,
        localizations: version.localizations.map((item) =>
          item.locale === activeLocale
            ? {
                ...item,
                body: parsedBody,
                bodyHash: payload.bodyHash!,
                status: payload.status!,
              }
            : item,
        ),
      };
      setVersion(savedVersion);
      onChange(savedVersion);
      setMessage(
        payload.status === 'complete'
          ? 'Юридическая локализация готова к общей публикации.'
          : 'Черновик юридической локализации сохранён.',
      );
    } catch (saveError) {
      setError(clientRequestMessage(saveError, 'Не удалось сохранить юридическую локализацию.'));
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!window.confirm('Опубликовать четыре неизменяемые локализации этой версии?')) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const request = await clientRequest('/api/admin/legal/localizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentType: version.documentType, version: version.version }),
      });
      const payload = await readClientResponseJson<{ error?: string }>(request.response);
      if (!request.ok) {
        setError(
          payload?.error === 'LEGAL_LOCALIZATIONS_INCOMPLETE'
            ? 'Публикация заблокирована: не все четыре языка готовы.'
            : clientRequestMessage(request.error, 'Не удалось опубликовать юридические копии.'),
        );
        return;
      }
      const publishedVersion: LegalLocalizationVersion = {
        ...version,
        current: true,
        localizations: version.localizations.map((item) => ({
          ...item,
          status: 'published',
          immutable: true,
        })),
      };
      setVersion(publishedVersion);
      onChange(publishedVersion);
      setMessage('Четыре юридические локализации опубликованы одной операцией.');
    } catch (publishError) {
      setError(clientRequestMessage(publishError, 'Не удалось опубликовать юридические копии.'));
    } finally {
      setBusy(false);
    }
  };

  const previewBody = parsedBody ?? active.body;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>
              {version.documentType === 'privacy'
                ? 'Политика конфиденциальности'
                : 'Условия использования'}{' '}
              · {version.version}
            </CardTitle>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Редакция тела: {version.bodyRevision} · действует с{' '}
              {new Date(version.effectiveAt).toLocaleDateString('ru-RU')}
            </p>
          </div>
          {version.current ? <Badge variant="success">Текущая версия</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <AdminLocaleTabs
          idPrefix={idPrefix}
          activeLocale={activeLocale}
          statuses={statuses}
          onChange={selectLocale}
        />

        <section
          id={`${idPrefix}-panel-${activeLocale}`}
          role="tabpanel"
          aria-labelledby={`${idPrefix}-tab-${activeLocale}`}
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--color-surface-muted)] p-3">
            <p className="text-sm">
              Статус: <strong>{ADMIN_LOCALIZATION_STATUS_LABELS[active.status]}</strong>
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setPreview((value) => !value)}
            >
              {preview ? 'Вернуться к JSON' : 'Предпросмотр текста'}
            </Button>
          </div>

          {preview ? (
            <article
              lang={activeLocale === 'zh' ? 'zh-Hans' : activeLocale}
              style={{ fontFamily: previewFont(activeLocale) }}
              className="rounded-xl border border-[var(--color-border)] p-4 md:p-6"
            >
              <Badge variant="sapphire">Предпросмотр · {ADMIN_LOCALE_LABELS[activeLocale]}</Badge>
              <h3 className="mt-3 text-2xl font-black break-words">
                {active.title || 'Без заголовка'}
              </h3>
              <div className="mt-5 space-y-3">
                {previewStrings(previewBody).map((text, index) => (
                  <p key={`${index}-${text.slice(0, 24)}`} className="leading-7 break-words">
                    {text}
                  </p>
                ))}
              </div>
            </article>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-title-${activeLocale}`}>Название документа</Label>
                <Input
                  id={`${idPrefix}-title-${activeLocale}`}
                  value={active.title}
                  maxLength={200}
                  disabled={active.immutable}
                  onChange={(event) => updateActive({ title: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-body-${activeLocale}`}>
                  Структурированное тело документа (JSON)
                </Label>
                <Textarea
                  id={`${idPrefix}-body-${activeLocale}`}
                  value={bodyText}
                  rows={16}
                  spellCheck={false}
                  disabled={active.immutable}
                  className="font-mono text-xs"
                  onChange={(event) => {
                    const nextText = event.target.value;
                    setBodyText(nextText);
                    try {
                      const nextBody = JSON.parse(nextText) as unknown;
                      updateActive({
                        body:
                          nextBody && typeof nextBody === 'object' && !Array.isArray(nextBody)
                            ? (nextBody as Record<string, unknown>)
                            : active.body,
                        bodyHash: null,
                      });
                    } catch {
                      updateActive({ bodyHash: null });
                    }
                    setMessage('');
                  }}
                />
                {!parsedBody ? (
                  <p role="alert" className="text-sm text-[var(--color-danger)]">
                    Значение должно быть корректным JSON-объектом.
                  </p>
                ) : null}
              </div>
              {active.immutable ? (
                <p className="rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm">
                  Опубликованная локализация неизменяема. Для новой редакции создаётся новая версия
                  документа.
                </p>
              ) : (
                <>
                  <label className="flex min-h-11 items-center gap-3 rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm font-semibold">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={completeRequested}
                      onChange={(event) => setCompleteRequested(event.target.checked)}
                    />
                    Пометить локализацию готовой после сохранения
                  </label>
                  <Button type="button" disabled={busy || !parsedBody} onClick={() => void save()}>
                    {busy ? 'Сохраняем…' : 'Сохранить локализацию'}
                  </Button>
                </>
              )}
            </div>
          )}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4">
          <p className="text-sm text-[var(--color-text-muted)]">
            Публикация доступна только при готовности четырёх языков.
          </p>
          <Button
            type="button"
            disabled={
              busy || !allReady || Object.values(statuses).every((status) => status === 'published')
            }
            onClick={() => void publish()}
          >
            Опубликовать четыре языка
          </Button>
        </div>
        {message ? (
          <p role="status" className="text-sm text-[var(--color-text-muted)]">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function LegalLocalizationsEditor({ versions }: { versions: LegalLocalizationVersion[] }) {
  const [items, setItems] = useState(() => structuredClone(versions));
  const [documentType, setDocumentType] = useState<'privacy' | 'terms'>('terms');
  const [version, setVersion] = useState('');
  const [bodyRevision, setBodyRevision] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const stageVersion = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveDate)) {
      setError('Укажите дату вступления редакции в силу.');
      return;
    }
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const request = await clientRequest('/api/admin/legal/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentType,
          version,
          bodyRevision,
          effectiveAt: new Date(`${effectiveDate}T00:00:00+05:00`).toISOString(),
        }),
      });
      const payload = await readClientResponseJson<LegalLocalizationVersion & { error?: string }>(
        request.response,
      );
      if (!request.ok || !payload?.localizations || payload.localizations.length !== 4) {
        setError(
          payload?.error === 'LEGAL_VERSION_EXISTS'
            ? 'Версия с таким номером уже существует.'
            : clientRequestMessage(
                request.ok ? new Error('INVALID_RESPONSE') : request.error,
                'Не удалось создать новую редакцию.',
              ),
        );
        return;
      }
      setItems((current) => [payload, ...current]);
      setVersion('');
      setBodyRevision('');
      setEffectiveDate('');
      setMessage('Новая версия создана. Теперь заполните и проверьте четыре локализации.');
    } catch (stageError) {
      setError(clientRequestMessage(stageError, 'Не удалось создать новую редакцию.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6" data-admin-legal-localizations>
      <Card>
        <CardHeader>
          <CardTitle>Новая версия документа</CardTitle>
          <p className="text-sm text-[var(--color-text-muted)]">
            Создайте каноническую версию, затем заполните RU, KK, EN и ZH. Дата фиксируется на
            начало дня по времени Asia/Oral.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="legal-stage-document-type">Документ</Label>
              <select
                id="legal-stage-document-type"
                className="min-h-11 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
                value={documentType}
                onChange={(event) =>
                  setDocumentType(event.target.value === 'privacy' ? 'privacy' : 'terms')
                }
              >
                <option value="terms">Условия использования</option>
                <option value="privacy">Политика конфиденциальности</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="legal-stage-version">Номер версии</Label>
              <Input
                id="legal-stage-version"
                value={version}
                maxLength={32}
                placeholder="2026-09-01"
                onChange={(event) => setVersion(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="legal-stage-revision">Описание редакции</Label>
              <Input
                id="legal-stage-revision"
                value={bodyRevision}
                maxLength={160}
                placeholder="Обновление условий и контактов"
                onChange={(event) => setBodyRevision(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="legal-stage-effective-date">Дата вступления в силу</Label>
              <Input
                id="legal-stage-effective-date"
                type="date"
                value={effectiveDate}
                onChange={(event) => setEffectiveDate(event.target.value)}
              />
            </div>
          </div>
          <Button
            type="button"
            disabled={busy || !version.trim() || bodyRevision.trim().length < 3 || !effectiveDate}
            onClick={() => void stageVersion()}
          >
            {busy ? 'Создаём…' : 'Создать версию'}
          </Button>
          {message ? (
            <p role="status" className="text-sm text-[var(--color-text-muted)]">
              {message}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {items.map((version) => (
        <LegalVersionEditor
          key={`${version.documentType}:${version.version}`}
          initial={version}
          onChange={(next) =>
            setItems((current) =>
              current.map((item) => {
                const sameVersion =
                  item.documentType === next.documentType && item.version === next.version;
                if (sameVersion) return next;
                return next.current && item.documentType === next.documentType
                  ? { ...item, current: false }
                  : item;
              }),
            )
          }
        />
      ))}
    </div>
  );
}
