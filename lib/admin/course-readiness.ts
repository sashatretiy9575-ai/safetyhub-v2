/**
 * What each language version of a course still lacks, in words an administrator
 * can act on. The database publisher answers one code for every incomplete
 * state, and a locale used to read «Опубликовано» while its SEO, explanations
 * or even its own wording were missing. These functions are pure so the page,
 * the two editors, the publish route and the tests all reach the same verdict.
 */
import { APP_LOCALES, type AppLocale } from '../../i18n/config.ts';
import { TEST_EDITOR_TOTAL_QUESTIONS } from './course-test-editor.ts';

export type CoursePresentationState = 'staging' | 'validating' | 'ready' | 'rejected' | 'retired';

/**
 * Counts taken from the stored question sets on the server. Only these numbers
 * cross to the browser; the texts and identifiers behind them do not.
 */
export type CourseAssessmentGaps = {
  /** Questions stored for the locale, all sets together. */
  total: number;
  /** Question and answer texts that are blank. */
  emptyTexts: number;
  /** Questions explained in Russian whose translation has no explanation. */
  missingExplanations: number;
  /** Texts of a translation that are still Russian. */
  russianTexts: number;
};

/** The saved state of one locale; the editor item satisfies it as it is. */
export type CourseLocaleFacts = {
  locale: AppLocale;
  /** `published`: the revision learners see carries exactly this draft. */
  status: 'missing' | 'draft' | 'complete' | 'published';
  title: string;
  description: string;
  /** The SEO as stored, before any default is offered in a form. */
  seoStored: { title: string; description: string };
  presentation: { status: CoursePresentationState } | null;
  /** Set by the offline import of a translated question bank; Russian is the source. */
  assessmentImported: boolean;
  assessmentGaps: CourseAssessmentGaps | null;
  /** The open form differs from what the server holds. */
  unsaved?: boolean;
};

export type CourseLocaleStateId =
  'missing' | 'unsaved' | 'incomplete' | 'draft' | 'ready' | 'published' | 'publishedIncomplete';

/** `variant` is a badge variant, so a state can be handed to a badge as it is. */
export type CourseLocaleState = {
  id: CourseLocaleStateId;
  label: string;
  variant: 'default' | 'success' | 'sapphire' | 'warning' | 'danger';
};

export type CourseLocaleBlockers = Record<AppLocale, string[]>;

/**
 * The course form and the locale tabs are siblings under a server page. The form
 * publishes, so the tabs announce on `window` which of them hold unsaved work.
 */
export const COURSE_UNSAVED_LOCALES_EVENT = 'safetyhub:course-locales-unsaved';

const LOCALE_WORDS: Record<AppLocale, { inVersion: string; version: string }> = {
  ru: { inVersion: 'В русской версии', version: 'Русская версия' },
  kk: { inVersion: 'В казахской версии', version: 'Казахская версия' },
  en: { inVersion: 'В английской версии', version: 'Английская версия' },
  zh: { inVersion: 'В китайской версии', version: 'Китайская версия' },
};

const STATES: Record<CourseLocaleStateId, Omit<CourseLocaleState, 'id'>> = {
  missing: { label: 'Не заполнено', variant: 'default' },
  unsaved: { label: 'Не сохранено', variant: 'warning' },
  incomplete: { label: 'Не готово', variant: 'danger' },
  draft: { label: 'Черновик', variant: 'warning' },
  ready: { label: 'Готово к публикации', variant: 'sapphire' },
  published: { label: 'Опубликовано', variant: 'success' },
  publishedIncomplete: { label: 'Опубликовано не полностью', variant: 'danger' },
};

// A translated abbreviation or a quoted standard keeps a few Cyrillic letters;
// a text that was never translated is Cyrillic almost entirely.
const CYRILLIC_SHARE_LIMIT = 0.3;
// Kazakh is written in Cyrillic too, so its share says nothing. A long string
// that matches the Russian one character for character was copied, while a
// short one — «БИОТ», the number of a standard — may legitimately coincide.
const IDENTICAL_TEXT_MIN = 40;

const RU_PLURAL_RULES = new Intl.PluralRules('ru-RU');

function blank(value: string) {
  return value.trim().length === 0;
}

function cyrillicShare(text: string) {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return 0;
  return (text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0) / letters;
}

/**
 * Whether a translation's text was left in Russian. `russian` holds the Russian
 * strings the text could have been copied from; only Kazakh needs them.
 */
export function looksRussian(locale: AppLocale, text: string, russian: readonly string[]) {
  const value = text.trim();
  if (locale === 'ru' || !value) return false;
  if (locale === 'kk') {
    return (
      [...value].length >= IDENTICAL_TEXT_MIN && russian.some((source) => source.trim() === value)
    );
  }
  return cyrillicShare(value) > CYRILLIC_SHARE_LIMIT;
}

type StoredQuestion = {
  id: string;
  text: string;
  explanation: string;
  options: { id: string; text: string }[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

/** Flattens the stored sets; anything that is not a set of questions is skipped. */
function storedQuestions(stored: unknown): StoredQuestion[] | null {
  if (!Array.isArray(stored)) return null;
  return stored.flatMap((set) => {
    const questions = record(set)?.questions;
    if (!Array.isArray(questions)) return [];
    return questions.flatMap((item) => {
      const question = record(item);
      if (!question) return [];
      const options = Array.isArray(question.options) ? question.options : [];
      return [
        {
          id: text(question.id),
          text: text(question.text),
          explanation: text(question.explanation),
          options: options.flatMap((option) => {
            const entry = record(option);
            return entry ? [{ id: text(entry.id), text: text(entry.text) }] : [];
          }),
        },
      ];
    });
  });
}

/**
 * Counts what a locale's stored question sets lack. Explanations are a matter
 * of parity, not of presence: five courses were written without any, so a gap
 * exists only where the Russian question is explained and the translation is
 * not. `explainedIds` is null when the Russian bank could not be read, and the
 * parity check is then skipped rather than guessed.
 */
export function courseAssessmentGaps(
  locale: AppLocale,
  stored: unknown,
  russian: { stored: unknown; explainedIds: ReadonlySet<string> | null },
): CourseAssessmentGaps | null {
  const questions = storedQuestions(stored);
  if (!questions) return null;

  const russianById = new Map<string, string>();
  if (locale === 'kk') {
    for (const question of storedQuestions(russian.stored) ?? []) {
      russianById.set(question.id, question.text);
      for (const option of question.options) russianById.set(option.id, option.text);
    }
  }
  const left = (id: string, value: string) => {
    const source = russianById.get(id);
    return looksRussian(locale, value, source === undefined ? [] : [source]);
  };

  const gaps: CourseAssessmentGaps = {
    total: questions.length,
    emptyTexts: 0,
    missingExplanations: 0,
    russianTexts: 0,
  };
  for (const question of questions) {
    if (blank(question.text)) gaps.emptyTexts += 1;
    if (left(question.id, question.text)) gaps.russianTexts += 1;
    for (const option of question.options) {
      if (blank(option.text)) gaps.emptyTexts += 1;
      if (left(option.id, option.text)) gaps.russianTexts += 1;
    }
    // The Russian explanation texts stay inside the audited bank read, so a
    // Kazakh explanation has nothing to be compared with; the share rule of the
    // other two languages needs no counterpart.
    if (looksRussian(locale, question.explanation, [])) gaps.russianTexts += 1;
    if (
      locale !== 'ru' &&
      russian.explainedIds?.has(question.id) === true &&
      blank(question.explanation)
    ) {
      gaps.missingExplanations += 1;
    }
  }
  return gaps;
}

function explanationGap(missing: number, total: number) {
  if (missing >= total) return 'нет пояснений к вопросам';
  const noun = RU_PLURAL_RULES.select(missing) === 'one' ? 'вопросу' : 'вопросам';
  return `нет пояснений к ${missing} ${noun}`;
}

/**
 * The parts of a saved locale that are missing, one short line each. `russian`
 * is the Russian version a Kazakh one is compared with. An empty set of modules
 * and a missing cover are not gaps: the presentation is the material, and a
 * course without its own cover is shown with the bundled one. A locale that was
 * never saved has no parts to name; its state says «Не заполнено».
 *
 * `named` lines carry the language — «В казахской версии нет описания» — for a
 * list that mixes languages; `bare` lines — «Нет описания» — go under the tab of
 * the language itself.
 */
export function courseLocaleGaps(
  facts: CourseLocaleFacts,
  russian: CourseLocaleFacts | null,
  form: 'named' | 'bare' = 'named',
): string[] {
  if (facts.status === 'missing') return [];
  const parts: string[] = [];

  if (blank(facts.title)) parts.push('нет названия');
  if (blank(facts.description)) parts.push('нет описания');

  const presentation = facts.presentation?.status ?? null;
  if (presentation === null || presentation === 'retired') parts.push('нет презентации');
  else if (presentation === 'rejected') parts.push('презентация отклонена');
  else if (presentation !== 'ready') parts.push('презентация ещё проверяется');

  const assessment = facts.assessmentGaps;
  // A translation without its import still holds the Russian placeholder the
  // database created for it: there is nothing of its own to count yet.
  const imported = facts.locale === 'ru' || facts.assessmentImported;
  if (!assessment || assessment.total === 0 || !imported) {
    parts.push('нет вопросов и ответов');
  } else {
    if (assessment.total !== TEST_EDITOR_TOTAL_QUESTIONS) {
      parts.push(`вопросов ${assessment.total} из ${TEST_EDITOR_TOTAL_QUESTIONS}`);
    }
    if (assessment.emptyTexts > 0) {
      parts.push(`есть вопросы или ответы без текста: ${assessment.emptyTexts}`);
    }
    if (assessment.missingExplanations > 0) {
      parts.push(explanationGap(assessment.missingExplanations, assessment.total));
    }
  }

  if (blank(facts.seoStored.title)) parts.push('не заполнен SEO-заголовок');
  if (blank(facts.seoStored.description)) parts.push('не заполнено SEO-описание');

  const source = russian
    ? [russian.title, russian.description, russian.seoStored.title, russian.seoStored.description]
    : [];
  const left = (value: string) => looksRussian(facts.locale, value, source);
  const russianParts = [
    left(facts.title) ? 'название' : '',
    left(facts.description) ? 'описание' : '',
    left(facts.seoStored.title) || left(facts.seoStored.description) ? 'SEO' : '',
    imported && assessment && assessment.russianTexts > 0 ? 'вопросы' : '',
  ].filter(Boolean);
  if (russianParts.length > 0) parts.push(`остался русский текст: ${russianParts.join(', ')}`);

  const { inVersion } = LOCALE_WORDS[facts.locale];
  return parts.map((part) =>
    form === 'named'
      ? `${inVersion} ${part}`
      : `${part.charAt(0).toLocaleUpperCase('ru-RU')}${part.slice(1)}`,
  );
}

/** One state per locale. «Опубликовано» is reserved for a live version with nothing missing. */
export function courseLocaleState(
  facts: CourseLocaleFacts,
  gaps: readonly string[],
): CourseLocaleState {
  const id: CourseLocaleStateId = facts.unsaved
    ? 'unsaved'
    : facts.status === 'missing'
      ? 'missing'
      : facts.status === 'published'
        ? gaps.length > 0
          ? 'publishedIncomplete'
          : 'published'
        : gaps.length > 0
          ? 'incomplete'
          : facts.status === 'complete'
            ? 'ready'
            : 'draft';
  return { id, ...STATES[id] };
}

export function courseLocaleUnsavedNotice(locale: AppLocale) {
  return `${LOCALE_WORDS[locale].version}: есть несохранённые изменения`;
}

function localeMissingNotice(locale: AppLocale) {
  return `${LOCALE_WORDS[locale].version} не заполнена`;
}

/**
 * Everything that stops publication, per locale: the gaps, and the states that
 * are not gaps — unsaved changes, which make the saved gaps stale, a version
 * that was never saved, and one that was never marked ready.
 */
export function courseLocaleBlockers(all: readonly CourseLocaleFacts[]): CourseLocaleBlockers {
  const russian = all.find((facts) => facts.locale === 'ru') ?? null;
  const blockers: CourseLocaleBlockers = { ru: [], kk: [], en: [], zh: [] };
  for (const locale of APP_LOCALES) {
    const facts = all.find((entry) => entry.locale === locale);
    if (facts?.unsaved) {
      blockers[locale] = [courseLocaleUnsavedNotice(locale)];
    } else if (!facts || facts.status === 'missing') {
      blockers[locale] = [localeMissingNotice(locale)];
    } else {
      const lines = courseLocaleGaps(facts, russian);
      if (facts.status === 'draft') {
        lines.push(`${LOCALE_WORDS[locale].version} не отмечена готовой`);
      }
      blockers[locale] = lines;
    }
  }
  return blockers;
}

/** The same lines as one list, Russian first. */
export function coursePublicationBlockers(all: readonly CourseLocaleFacts[]): string[] {
  const blockers = courseLocaleBlockers(all);
  return APP_LOCALES.flatMap((locale) => blockers[locale]);
}
