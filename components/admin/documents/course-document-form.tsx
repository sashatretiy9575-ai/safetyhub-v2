'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CaretDown, FilePdf, FloppyDisk } from '@phosphor-icons/react';
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
import {
  DOCUMENT_FAMILIES,
  type BookletTexts,
  type DocumentFamily,
} from '@/lib/pdf/document-profile';
import {
  ELECTRICAL_GROUPS,
  ELECTRICAL_ROLES,
  ELECTRICAL_ROLE_TEXT,
  ELECTRICAL_VOLTAGES,
  ELECTRICAL_VOLTAGE_TEXT,
  isJournalStart,
  type ElectricalGroup,
  type ElectricalRole,
  type ElectricalVoltage,
} from '@/lib/pdf/electrical';
import { openSamplePdf } from './open-sample';

export type DocumentPreviewTab = 'protocol' | 'certificate';

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
/** The kinds of check the qualification protocol of the energy rules names. */
const VERIFICATION_KINDS = ['первичная', 'очередная', 'внеочередная'] as const;
/** These forms print «ИТР» and «рабочий состав» on protocols of their own. */
const SPLIT_FAMILIES: ReadonlySet<DocumentFamily> = new Set(['biot', 'ptm', 'industrial']);
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
 * The documents of one course. The form of the protocol is the choice; the
 * rest is what that form states, and stays folded under «Дополнительно» for
 * the rare course that differs. «Образец» opens what the course would print.
 */
export function CourseDocumentForm({
  setup: initialSetup,
  common,
}: {
  setup: CourseDocumentSetup;
  common: CommonDocumentSettings;
}) {
  const [setup, setSetup] = useState(initialSetup);
  const [draft, setDraft] = useState(() => courseDocumentDraft(initialSetup));
  const [busy, setBusy] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [status, setStatus] = useState('');
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const saved = useMemo(() => courseDocumentDraft(setup), [setup]);
  const dirty =
    JSON.stringify(courseDocumentPayload(draft)) !== JSON.stringify(courseDocumentPayload(saved));
  useUnsavedChangesGuard(dirty, { title: 'Уйти без сохранения?' });
  const problem = draftProblem(draft);
  const defaults = documentFamilyDefaults(draft.family);
  const electrical = draft.family === 'electrical';
  const biot = draft.family === 'biot';
  const audiences = draftAudiences(draft);

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
  const setJournalStart = (value: number | null) => {
    if (value !== null && !isJournalStart(value)) {
      setStatus('Номер журнала — целое число от 1 до 999 999 999');
      return;
    }
    const { group, voltage, role } = draft.electrical;
    update({
      electrical:
        value !== null && isJournalStart(value)
          ? { group, voltage, role, journalStart: value }
          : { group, voltage, role },
    });
  };

  async function sample(tab: DocumentPreviewTab) {
    const audience: DocumentAudienceKey = draft.split ? 'itr' : 'all';
    const today = documentDate();
    const profile = draftProfile(setup, draft, audience);
    const branding = previewBranding(common, profile, {
      date: today,
      // An electrical course numbers its sheets from its journal.
      number:
        electrical && draft.electrical.journalStart
          ? String(draft.electrical.journalStart)
          : numberFromDate(today),
    });
    const job = samplePreviewJob(tab, branding, profile.programName, SAMPLE[audience]);
    if (job.kind === 'message') {
      setStatus(job.text);
      return;
    }
    if (job.kind === 'wait') return;
    setSampling(true);
    try {
      await openSamplePdf(
        job,
        tab === 'protocol' ? 'Образец протокола.pdf' : 'Образец корочки.pdf',
      );
    } catch (error) {
      setStatus(
        error instanceof Error && error.message === 'DOCUMENT_TEXT_OVERFLOW'
          ? 'Текст не помещается: сократите тексты'
          : 'Образец не сформирован, повторите',
      );
    } finally {
      setSampling(false);
    }
  }

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
      className="document-editor mx-auto max-w-2xl min-w-0 space-y-4"
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
          <p
            role="status"
            className="hidden min-w-0 truncate text-sm text-[var(--color-text-muted)] sm:block"
          >
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
        <p
          role="status"
          className="min-h-5 truncate pt-1 text-sm text-[var(--color-text-muted)] sm:hidden"
        >
          {status}
        </p>
      </div>

      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <DocumentSelect
          label="Вид протокола"
          value={draft.family}
          options={DOCUMENT_FAMILIES.map((family) => ({
            value: family,
            label: DOCUMENT_FAMILY_LABELS[family],
          }))}
          onChange={(family) =>
            update({
              family: family as DocumentFamily,
              split: SPLIT_FAMILIES.has(family as DocumentFamily),
            })
          }
        />
        {biot ? (
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
        {electrical ? (
          <div className="grid min-w-0 gap-3">
            <SegmentedControl
              label="Группа по электробезопасности"
              value={draft.electrical.group}
              onChange={(group) =>
                update({ electrical: { ...draft.electrical, group: group as ElectricalGroup } })
              }
              options={ELECTRICAL_GROUPS.map((group) => ({ value: group, label: group }))}
            />
            <SegmentedControl
              label="Напряжение электроустановок"
              value={draft.electrical.voltage}
              onChange={(voltage) =>
                update({
                  electrical: { ...draft.electrical, voltage: voltage as ElectricalVoltage },
                })
              }
              options={ELECTRICAL_VOLTAGES.map((voltage) => ({
                value: voltage,
                label: ELECTRICAL_VOLTAGE_TEXT[voltage].label,
              }))}
            />
          </div>
        ) : null}

        <div className="xs:grid-cols-2 grid min-w-0 gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={sampling}
            onClick={() => void sample('protocol')}
          >
            <FilePdf aria-hidden="true" />
            Образец протокола
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={sampling}
            onClick={() => void sample('certificate')}
          >
            <FilePdf aria-hidden="true" />
            {electrical ? 'Образец удостоверения' : 'Образец корочки'}
          </Button>
        </div>

        <details className="group min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            Дополнительно
            <CaretDown
              aria-hidden="true"
              className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <div className="min-w-0 space-y-3 border-t border-[var(--color-border)] p-3">
            {electrical ? (
              <WordFrame>
                <FrameWord>журнал с №</FrameWord>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={999_999_999}
                  aria-label="Номер журнала, с которого идут протоколы"
                  placeholder={numberFromDate(documentDate())}
                  className={FRAME_INPUT}
                  value={draft.electrical.journalStart ?? ''}
                  onChange={(event) => setJournalStart(numberOrNull(event.target.value))}
                />
              </WordFrame>
            ) : null}
            {electrical ? (
              <DocumentSelect
                label="В качестве"
                value={draft.electrical.role}
                options={ELECTRICAL_ROLES.map((role) => ({
                  value: role,
                  label: ELECTRICAL_ROLE_TEXT[role].label,
                }))}
                onChange={(role) =>
                  update({ electrical: { ...draft.electrical, role: role as ElectricalRole } })
                }
              />
            ) : null}
            {electrical ? (
              <DocumentSelect
                label="Вид проверки знаний"
                value={draft.verificationKind.trim() || defaults.verificationKind}
                options={VERIFICATION_KINDS.map((kind) => ({ value: kind, label: kind }))}
                onChange={(kind) => update({ verificationKind: kind })}
              />
            ) : null}
            {audiences.map((audience) => {
              const category = draft.categories[audience];
              const hoursDefault = defaults.hours[audience];
              const monthsDefault = defaults.validityMonths[audience];
              const word = AUDIENCE_LABELS[audience];
              return (
                <div key={audience} className="xs:grid-cols-2 grid min-w-0 gap-3">
                  {electrical ? null : (
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
                  )}
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
            {/* The qualification form of the energy rules carries its own wording. */}
            {electrical ? null : (
              <Textarea
                aria-label="Основание проверки"
                placeholder={defaults.protocolText}
                maxLength={1000}
                rows={3}
                className={FIELD_TEXTAREA}
                value={draft.protocolText}
                onChange={(event) => update({ protocolText: event.target.value })}
              />
            )}
            {electrical ? null : (
              <Textarea
                aria-label="Решение комиссии"
                placeholder={defaults.decisionText}
                maxLength={1000}
                rows={3}
                className={FIELD_TEXTAREA}
                value={draft.decisionText}
                onChange={(event) => update({ decisionText: event.target.value })}
              />
            )}
            {biot ? (
              <Input
                aria-label="Вид проверки знаний"
                placeholder={defaults.verificationKind || 'Вид проверки знаний'}
                maxLength={120}
                className={FIELD_INPUT}
                value={draft.verificationKind}
                onChange={(event) => update({ verificationKind: event.target.value })}
              />
            ) : null}
            {electrical ? null : (
              <SegmentedControl
                label="Корочка"
                value={bookletMode}
                onChange={(value) =>
                  update({ booklet: value === 'own' ? (draft.booklet ?? commonBooklet) : null })
                }
                options={[
                  { value: 'common', label: 'Общая корочка' },
                  { value: 'own', label: 'Своя корочка' },
                ]}
              />
            )}
            {draft.booklet && !electrical ? (
              <div className="grid min-w-0 gap-3">
                {BOOKLET_FIELDS.map(({ key, label }) => (
                  <Textarea
                    key={key}
                    aria-label={label}
                    placeholder={label}
                    maxLength={1000}
                    rows={4}
                    className={FIELD_TEXTAREA}
                    value={draft.booklet?.[key] ?? ''}
                    onChange={(event) =>
                      update({
                        booklet: { ...(draft.booklet ?? commonBooklet), [key]: event.target.value },
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>
        </details>
      </fieldset>
    </div>
  );
}
