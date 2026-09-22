'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FloppyDisk } from '@phosphor-icons/react';
import { DocumentSelect } from '@/components/admin/document-select';
import { useUnsavedChangesGuard } from '@/components/admin/use-unsaved-changes-guard';
import { FRAME_INPUT, FrameWord, WordFrame } from '@/components/admin/word-frame';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Textarea } from '@/components/ui/textarea';
import { clientFetch } from '@/lib/client-request';
import {
  AUDIENCE_LABELS,
  DOCUMENT_FAMILY_LABELS,
  courseDocumentDraft,
  courseDocumentPayload,
  courseDocumentVersions,
  draftAudiences,
  draftProfile,
  previewBranding,
  type CommonDocumentSettings,
  type CourseDocumentDraft,
  type CourseDocumentSetup,
  type DocumentAudienceKey,
} from '@/lib/pdf/document-course';
import { documentDate, numberFromDate } from '@/lib/pdf/document-editor';
import { documentFamilyDefaults } from '@/lib/pdf/document-family-defaults';
import {
  retryAfterSeconds,
  samplePreviewJob,
  type SamplePerson,
} from '@/lib/pdf/document-preview-job';
import { DOCUMENT_FAMILIES, type BookletTexts } from '@/lib/pdf/document-profile';
import { DocumentPreviewPane } from './document-preview-pane';
import type { DocumentPreviewTab } from './use-document-preview';

const SAMPLE: Readonly<Record<DocumentAudienceKey, SamplePerson>> = {
  all: { fullName: 'Иванов Иван', position: 'Инженер', education: 'Высшее' },
  itr: { fullName: 'Иванов Иван', position: 'Инженер', education: 'Высшее' },
  worker: { fullName: 'Петров Пётр', position: 'Слесарь', education: 'Среднее специальное' },
};
const BOOKLET_FIELDS: readonly { key: keyof BookletTexts; label: string }[] = [
  { key: 'examTextKk', label: 'Левая сторона, казахский' },
  { key: 'knowledgeTextKk', label: 'Правая сторона, казахский' },
  { key: 'examTextRu', label: 'Левая сторона, русский' },
  { key: 'knowledgeTextRu', label: 'Правая сторона, русский' },
];
const FIELD_INPUT = 'min-h-12 min-w-0 w-full text-base';
const FIELD_TEXTAREA = 'min-w-0 w-full text-base';

/** An empty box is «as the form says»; anything else is checked before saving. */
function numberOrNull(value: string) {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

/** Why the draft cannot be sent, or null. */
function draftProblem(draft: CourseDocumentDraft) {
  if (!draft.programName.trim()) return 'Укажите название программы';
  for (const audience of draftAudiences(draft)) {
    const category = draft.categories[audience];
    const hours = category?.hours;
    const months = category?.validityMonths;
    if (hours != null && (!Number.isInteger(hours) || hours < 1 || hours > 5000))
      return 'Часы: от 1 до 5000';
    if (months != null && (!Number.isInteger(months) || months < 0 || months > 120))
      return 'Срок: от 0 до 120 месяцев';
  }
  return null;
}

type Answer = {
  setup?: CourseDocumentSetup;
  error?: string;
  retryAfter?: number;
};

/**
 * The documents of one course: the form of its protocol, one category or
 * «ИТР» and «рабочие», the hours and the term, the wording, the booklet. One
 * «Сохранить» for all of it; the preview is the document the course would
 * print today.
 */
export function CourseDocumentForm({
  setup: initialSetup,
  common,
  initialTab = 'protocol',
}: {
  setup: CourseDocumentSetup;
  common: CommonDocumentSettings;
  initialTab?: DocumentPreviewTab;
}) {
  const [setup, setSetup] = useState(initialSetup);
  const [draft, setDraft] = useState(() => courseDocumentDraft(initialSetup));
  const [tab, setTab] = useState<DocumentPreviewTab>(initialTab);
  const [focused, setFocused] = useState<DocumentAudienceKey>('itr');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const saved = useMemo(() => courseDocumentDraft(setup), [setup]);
  const dirty =
    JSON.stringify(courseDocumentPayload(draft)) !== JSON.stringify(courseDocumentPayload(saved));
  useUnsavedChangesGuard(dirty, { title: 'Уйти без сохранения?' });
  const problem = draftProblem(draft);
  const defaults = documentFamilyDefaults(draft.family);
  const audiences = draftAudiences(draft);
  const shownAudience: DocumentAudienceKey = draft.split
    ? focused === 'worker'
      ? 'worker'
      : 'itr'
    : 'all';

  const today = documentDate();
  const profile = draftProfile(setup, draft, shownAudience);
  const branding = previewBranding(common, profile, { date: today, number: numberFromDate(today) });
  const job = samplePreviewJob(tab, branding, profile.programName, SAMPLE[shownAudience]);

  const update = (patch: Partial<CourseDocumentDraft>) => {
    setStatus('');
    setDraft((current) => ({ ...current, ...patch }));
  };
  const updateCategory = (
    audience: DocumentAudienceKey,
    patch: Partial<{ hours: number | null; validityMonths: number | null }>,
  ) => {
    setStatus('');
    setDraft((current) => {
      const category = current.categories[audience] ?? { hours: null, validityMonths: null };
      return {
        ...current,
        categories: { ...current.categories, [audience]: { ...category, ...patch } },
      };
    });
  };

  async function save() {
    if (problem) {
      setStatus(problem);
      return;
    }
    setBusy(true);
    setStatus('Сохраняем…');
    try {
      const response = await clientFetch(
        `/api/admin/documents/courses/${encodeURIComponent(setup.courseId)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            course: courseDocumentPayload(draft),
            expected: courseDocumentVersions(setup),
          }),
        },
      );
      const answer = (await response.json().catch(() => null)) as Answer | null;
      if (response.ok && answer?.setup) {
        setSetup(answer.setup);
        setDraft(courseDocumentDraft(answer.setup));
        setStatus('Сохранено');
        return;
      }
      if (response.status === 409) {
        setStatus('Сохранено в другом окне — обновите страницу');
        return;
      }
      if (response.status === 429) {
        const seconds = retryAfterSeconds(
          answer?.retryAfter ? String(answer.retryAfter) : response.headers.get('Retry-After'),
        );
        setStatus(`Повторите через ${seconds} с`);
        return;
      }
      setStatus(response.status === 400 ? 'Проверьте поля' : 'Не сохранилось, повторите');
    } catch {
      setStatus('Не сохранилось, повторите');
    } finally {
      setBusy(false);
    }
  }

  const bookletMode = draft.booklet ? 'own' : 'common';
  const commonBooklet: BookletTexts = {
    examTextKk: common.examTextKk,
    examTextRu: common.examTextRu,
    knowledgeTextKk: common.knowledgeTextKk,
    knowledgeTextRu: common.knowledgeTextRu,
  };

  return (
    <div
      className="document-editor min-w-0 space-y-4"
      data-hydrated={hydrated ? '' : undefined}
    >
      <div
        data-editor-action-bar
        className="sticky top-[calc(3.5rem+var(--safe-area-top))] z-[var(--z-sticky)] border-y border-[var(--color-border-strong)] bg-[var(--color-surface)]/96 px-3 py-2 shadow-[var(--shadow-card)] backdrop-blur-xl md:rounded-[var(--radius-lg)] md:border-x lg:top-4"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild size="icon" variant="ghost">
            <Link href="/admin/documents" aria-label="К документам">
              <ArrowLeft aria-hidden="true" />
            </Link>
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">
            {setup.title}
          </h1>
          <p role="status" className="hidden min-w-0 truncate text-sm text-[var(--color-text-muted)] sm:block">
            {status}
          </p>
          <Button
            size="sm"
            aria-label="Сохранить"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            <FloppyDisk aria-hidden="true" />
            <span className="hidden sm:inline">Сохранить</span>
          </Button>
        </div>
        <p role="status" className="min-h-5 truncate pt-1 text-sm text-[var(--color-text-muted)] sm:hidden">
          {status}
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.2fr)]">
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <DocumentSelect
            label="Форма протокола"
            value={draft.family}
            options={DOCUMENT_FAMILIES.map((family) => ({
              value: family,
              label: DOCUMENT_FAMILY_LABELS[family],
            }))}
            onChange={(family) => update({ family: family as CourseDocumentDraft['family'] })}
          />
          <SegmentedControl
            label="Категории слушателей"
            value={draft.split ? 'split' : 'one'}
            onChange={(value) => update({ split: value === 'split' })}
            options={[
              { value: 'one', label: 'Одна' },
              { value: 'split', label: 'ИТР и рабочие' },
            ]}
          />
          {audiences.map((audience) => {
            const category = draft.categories[audience];
            const hoursDefault = defaults.hours[audience];
            const monthsDefault = defaults.validityMonths[audience];
            const word = AUDIENCE_LABELS[audience];
            return (
              <div
                key={audience}
                className="xs:grid-cols-2 grid min-w-0 gap-3"
                onFocus={() => setFocused(audience)}
              >
                <WordFrame>
                  {word ? <FrameWord>{word}</FrameWord> : null}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={5000}
                    aria-label={word ? `Часы, ${word}` : 'Часы'}
                    placeholder={hoursDefault ? String(hoursDefault) : '—'}
                    className={FRAME_INPUT}
                    value={category?.hours ?? ''}
                    onChange={(event) =>
                      updateCategory(audience, { hours: numberOrNull(event.target.value) })
                    }
                  />
                  <FrameWord>ч</FrameWord>
                </WordFrame>
                <WordFrame>
                  {word ? <FrameWord>{word}</FrameWord> : null}
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={120}
                    aria-label={word ? `Срок действия, ${word}` : 'Срок действия'}
                    placeholder={String(monthsDefault)}
                    className={FRAME_INPUT}
                    value={category?.validityMonths ?? ''}
                    onChange={(event) =>
                      updateCategory(audience, {
                        validityMonths: numberOrNull(event.target.value),
                      })
                    }
                  />
                  <FrameWord>мес</FrameWord>
                </WordFrame>
              </div>
            );
          })}
          <Input
            aria-label="Название программы"
            placeholder="Название программы"
            maxLength={240}
            className={FIELD_INPUT}
            value={draft.programName}
            onChange={(event) => update({ programName: event.target.value })}
          />
          <Textarea
            aria-label="Основание проверки"
            placeholder={defaults.protocolText}
            maxLength={1000}
            rows={3}
            className={FIELD_TEXTAREA}
            value={draft.protocolText}
            onChange={(event) => update({ protocolText: event.target.value })}
          />
          <Textarea
            aria-label="Решение комиссии"
            placeholder={defaults.decisionText}
            maxLength={1000}
            rows={3}
            className={FIELD_TEXTAREA}
            value={draft.decisionText}
            onChange={(event) => update({ decisionText: event.target.value })}
          />
          {draft.family === 'biot' ? (
            <div className="xs:grid-cols-2 grid min-w-0 gap-3">
              <Input
                aria-label="Номер приказа"
                placeholder="Номер приказа"
                maxLength={100}
                className={FIELD_INPUT}
                value={draft.orderNumber}
                onChange={(event) => update({ orderNumber: event.target.value })}
              />
              <WordFrame>
                <FrameWord>приказ от</FrameWord>
                <input
                  type="date"
                  aria-label="Дата приказа"
                  className={FRAME_INPUT}
                  value={draft.orderDate}
                  onChange={(event) => update({ orderDate: event.target.value })}
                />
              </WordFrame>
            </div>
          ) : null}
          {draft.family === 'biot' ? (
            <Input
              aria-label="Вид проверки знаний"
              placeholder={defaults.verificationKind || 'Вид проверки знаний'}
              maxLength={120}
              className={FIELD_INPUT}
              value={draft.verificationKind}
              onChange={(event) => update({ verificationKind: event.target.value })}
            />
          ) : null}
          <SegmentedControl
            label="Корочка"
            value={bookletMode}
            onChange={(value) => {
              update({ booklet: value === 'own' ? (draft.booklet ?? commonBooklet) : null });
              setTab('certificate');
            }}
            options={[
              { value: 'common', label: 'Общая корочка' },
              { value: 'own', label: 'Своя корочка' },
            ]}
          />
          {draft.booklet ? (
            <div className="grid min-w-0 gap-3 xl:grid-cols-2">
              {BOOKLET_FIELDS.map(({ key, label }) => (
                <Textarea
                  key={key}
                  aria-label={label}
                  placeholder={label}
                  maxLength={1000}
                  rows={4}
                  className={FIELD_TEXTAREA}
                  value={draft.booklet?.[key] ?? ''}
                  onFocus={() => setTab('certificate')}
                  onChange={(event) =>
                    update({
                      booklet: { ...(draft.booklet ?? commonBooklet), [key]: event.target.value },
                    })
                  }
                />
              ))}
            </div>
          ) : null}
        </fieldset>

        <DocumentPreviewPane
          tab={tab}
          onTab={setTab}
          job={job}
          className="lg:sticky lg:top-24"
        />
      </div>
    </div>
  );
}
