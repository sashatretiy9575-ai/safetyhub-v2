import 'server-only';
import fs from 'fs';
import path from 'path';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { ContentSourceError, fallbackAfterContentFailure } from '@/lib/content/fallback-policy';
import {
  CONTENT_CACHE_REVALIDATE_SECONDS,
  CONTENT_CACHE_TAG,
  TOPICS_CACHE_TAG,
} from '@/lib/content/cache-policy';
import { createPublicClient } from '@/lib/supabase/public';
import { isContentSlug } from '@/lib/content/slug';
import { coerceContentMetadata, type ContentMetadata } from '@/lib/content/content-metadata';
import { contentSeoSchema, defaultContentSeo, type ContentSeo } from '@/lib/validation/content-seo';
import { DEFAULT_LOCALE, type AppLocale } from '@/i18n/config';
import { QUIZ_POLICY } from '@/lib/constants';
import type { Json } from '@/lib/supabase/types';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

export interface CoursePresentation {
  id: string;
  url: string;
  thumbnailUrl: string;
  pageCount: number;
  sha256: string;
}

export interface Course extends ContentMetadata {
  id: string;
  slug: string;
  title: string;
  description: string;
  icon: string;
  displayOrder: number;
  durationMinutes: number;
  questionCount: number;
  passScore: number;
  attemptsPerDay: number;
  attemptResetTimezone: string;
  presentation: CoursePresentation | null;
  updatedAt?: string;
  seo: ContentSeo;
}

/** @deprecated Public URLs retain the historical “topic” name for compatibility. */
export type Topic = Course;

function topicSeo(value: unknown, title: string, description: string): ContentSeo {
  const parsed = contentSeoSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultContentSeo(title, description);
}

export function estimateTopicReadTime(topic: { durationMinutes?: number }) {
  return Math.max(1, topic.durationMinutes ?? 15);
}

const courseSnapshotsDir = path.join(process.cwd(), 'content', 'snapshots', 'courses');
let lastKnownTopics: Topic[] | null = null;
const lastKnownTopicsBySlug = new Map<string, Topic | null>();

function metadataFields(value: Record<string, unknown>) {
  return coerceContentMetadata({
    jurisdiction: value.jurisdiction ?? '',
    effectiveDate: value.effectiveDate ?? value.effective_date ?? '',
    sources: value.sources ?? [],
  });
}

function rememberTopic(slug: string, topic: Topic | null) {
  lastKnownTopicsBySlug.delete(slug);
  lastKnownTopicsBySlug.set(slug, topic);
  if (lastKnownTopicsBySlug.size > 128) {
    const oldest = lastKnownTopicsBySlug.keys().next().value;
    if (typeof oldest === 'string') lastKnownTopicsBySlug.delete(oldest);
  }
}

type PresentationRecord = {
  id?: unknown;
  pageCount?: unknown;
  page_count?: unknown;
  sha256?: unknown;
  status?: unknown;
};

function protectedPresentationUrl(
  slug: string,
  asset: 'presentation' | 'thumbnail',
  locale: AppLocale = DEFAULT_LOCALE,
) {
  return `/course-presentations/${encodeURIComponent(slug)}/${asset}?locale=${locale}`;
}

function presentationFromRecord(
  value: PresentationRecord | null | undefined,
  slug: string,
  locale: AppLocale = DEFAULT_LOCALE,
) {
  if (!value || typeof value.id !== 'string' || !isContentSlug(slug)) return null;
  if (value.status !== undefined && value.status !== 'ready') return null;
  const pageCount = Number(value.pageCount ?? value.page_count);
  if (!Number.isInteger(pageCount) || pageCount <= 0) return null;

  // A course page may safely expose only a same-origin authorization endpoint.
  // Its immutable Storage object path never reaches the rendered catalogue.
  return {
    id: value.id,
    url: protectedPresentationUrl(slug, 'presentation', locale),
    thumbnailUrl: protectedPresentationUrl(slug, 'thumbnail', locale),
    pageCount,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
  } satisfies CoursePresentation;
}

function topicFromLocalRecord(raw: Record<string, unknown>): Topic | null {
  if (
    typeof raw.slug !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.description !== 'string'
  ) {
    return null;
  }
  const policy =
    raw.policy && typeof raw.policy === 'object' ? (raw.policy as Record<string, unknown>) : raw;
  const presentationRecord =
    raw.presentation && typeof raw.presentation === 'object'
      ? (raw.presentation as PresentationRecord)
      : null;
  const localPresentation = presentationFromRecord(presentationRecord, raw.slug);
  return {
    id: typeof raw.id === 'string' ? raw.id : raw.slug,
    slug: raw.slug,
    title: raw.title,
    description: raw.description,
    icon: typeof raw.icon === 'string' ? raw.icon : 'shield-check',
    displayOrder: Number(raw.displayOrder ?? raw.display_order ?? 0),
    durationMinutes: Number(policy.durationMinutes ?? policy.duration_minutes ?? 15),
    questionCount: Number(policy.questionCount ?? policy.question_count ?? 10),
    passScore: Number(policy.passScore ?? policy.pass_score ?? 7),
    attemptsPerDay: Number(policy.attemptsPerCalendarDay ?? policy.attempts_per_calendar_day ?? 8),
    attemptResetTimezone: String(
      policy.attemptResetTimezone ??
        policy.resetTimezone ??
        policy.attempt_reset_timezone ??
        'Asia/Oral',
    ),
    presentation: localPresentation,
    updatedAt:
      typeof raw.updatedAt === 'string'
        ? raw.updatedAt
        : typeof raw.publishedAt === 'string'
          ? raw.publishedAt
          : undefined,
    seo: topicSeo(raw.seo, raw.title, raw.description),
    ...metadataFields(raw),
  };
}

function localCourseFiles() {
  if (!fs.existsSync(courseSnapshotsDir)) return [];
  return fs
    .readdirSync(courseSnapshotsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(courseSnapshotsDir, entry.name, 'course.json'))
    .filter((file) => fs.existsSync(file));
}

function getLocalTopics(): Topic[] {
  const files = localCourseFiles();

  return files
    .map((file) => topicFromLocalRecord(JSON.parse(fs.readFileSync(file, 'utf-8'))))
    .filter((topic): topic is Topic => Boolean(topic))
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

function getLocalTopicBySlug(slug: string): Topic | null {
  return getLocalTopics().find((topic) => topic.slug === slug) ?? null;
}

type PublicCourseRecord = {
  test_id: string;
  slug: string;
  title: string;
  description: string;
  icon: string;
  display_order: number;
  duration_minutes: number;
  pass_score: number;
  question_count: number;
  attempts_per_calendar_day: number;
  attempt_reset_timezone: string;
  seo: unknown;
  published_at: string;
  jurisdiction: string;
  effective_date: string;
  sources: unknown;
  presentation: PresentationRecord | PresentationRecord[] | null;
};

function topicFromDatabase(record: PublicCourseRecord): Topic {
  const joinedPresentation = Array.isArray(record.presentation)
    ? record.presentation[0]
    : record.presentation;
  return {
    id: record.test_id,
    slug: record.slug,
    title: record.title,
    description: record.description,
    icon: record.icon,
    displayOrder: record.display_order,
    durationMinutes: record.duration_minutes,
    questionCount: record.question_count,
    passScore: record.pass_score,
    attemptsPerDay: record.attempts_per_calendar_day,
    attemptResetTimezone: record.attempt_reset_timezone,
    presentation: presentationFromRecord(joinedPresentation, record.slug),
    updatedAt: record.published_at,
    seo: topicSeo(record.seo, record.title, record.description),
    ...metadataFields(record as unknown as Record<string, unknown>),
  };
}

const publicCourseSelection =
  'test_id,slug,title,description,icon,display_order,duration_minutes,pass_score,question_count,attempts_per_calendar_day,attempt_reset_timezone,seo,published_at,jurisdiction,effective_date,sources,presentation:course_presentations!test_revisions_presentation_id_fkey(id,page_count,sha256,status),test:tests!tests_current_revision_fk!inner(status)';

async function getTopicsFromSource(): Promise<Topic[]> {
  const localTopics = getLocalTopics();
  const supabase = createPublicClient();
  if (!supabase) {
    return fallbackAfterContentFailure({
      configured: false,
      fallback: () => localTopics,
      operation: 'list topics',
    });
  }

  try {
    const { data, error, status } = await supabase
      .from('test_revisions')
      .select(publicCourseSelection)
      .eq('test.status', 'published')
      .order('display_order', { ascending: true });

    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        // A repository snapshot may contain the next catalogue batch before
        // SQL activation. In a configured hosted deployment, never expose it
        // as a cold transport fallback; only reuse content observed remotely.
        fallback: () => lastKnownTopics ?? [],
        operation: 'list topics',
        status,
      });
    }

    const topics = (data ?? []).map((record) =>
      topicFromDatabase(record as unknown as PublicCourseRecord),
    );
    lastKnownTopics = topics;
    return topics;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () => lastKnownTopics ?? [],
      operation: 'list topics',
    });
  }
}

const getCachedTopics = unstable_cache(getTopicsFromSource, ['content-topics-v4'], {
  revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
  tags: [CONTENT_CACHE_TAG, TOPICS_CACHE_TAG],
});

const getLegacyTopics = cache(getCachedTopics);

async function getTopicBySlugFromSource(slug: string): Promise<Topic | null> {
  const localTopic = getLocalTopicBySlug(slug);
  const supabase = createPublicClient();
  if (!supabase) {
    return fallbackAfterContentFailure({
      configured: false,
      fallback: () => localTopic,
      operation: `read topic ${slug}`,
    });
  }

  try {
    const { data, error, status } = await supabase
      .from('test_revisions')
      .select(publicCourseSelection)
      .eq('slug', slug)
      .eq('test.status', 'published')
      .maybeSingle();

    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        fallback: () => (lastKnownTopicsBySlug.has(slug) ? lastKnownTopicsBySlug.get(slug)! : null),
        operation: `read topic ${slug}`,
        status,
      });
    }

    if (!data) {
      rememberTopic(slug, null);
      return null;
    }

    const topic = topicFromDatabase(data as unknown as PublicCourseRecord);
    rememberTopic(slug, topic);
    return topic;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () => (lastKnownTopicsBySlug.has(slug) ? lastKnownTopicsBySlug.get(slug)! : null),
      operation: `read topic ${slug}`,
    });
  }
}

const getCachedTopicBySlug = unstable_cache(getTopicBySlugFromSource, ['content-topic-v4'], {
  revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
  tags: [CONTENT_CACHE_TAG, TOPICS_CACHE_TAG],
});

const getLegacyTopicBySlug = cache((slug: string) =>
  isContentSlug(slug) ? getCachedTopicBySlug(slug) : Promise.resolve(null),
);

type LocalizedCourseListItem = {
  slug: string;
  locale: AppLocale;
  title: string;
  description: string;
  icon: string;
  displayOrder: number;
  durationMinutes: number;
  passScore: number;
  publishedAt: string;
};

type LocalizedCourseRecord = LocalizedCourseListItem & {
  id: string;
  revisionId: string;
  content: Json;
  seo: unknown;
  sources: unknown;
  jurisdiction: string;
  effectiveDate: string;
  attemptsPerCalendarDay: number;
  resetTimezone: string;
  presentation: PresentationRecord;
};

type LocalizedCourseRpcClient = {
  rpc(
    name: 'list_published_courses_locale' | 'get_published_course_locale',
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: Json;
    error: { code?: string; message?: string } | null;
    status: number;
  }>;
};

const lastKnownLocalizedTopics = new Map<AppLocale, Topic[]>();
const lastKnownLocalizedTopicsBySlug = new Map<string, Topic | null>();

function localizedTopicKey(locale: AppLocale, slug: string) {
  return `${locale}:${slug}`;
}

function localizedTopicFromList(value: LocalizedCourseListItem): Topic {
  return {
    id: value.slug,
    slug: value.slug,
    title: value.title,
    description: value.description,
    icon: value.icon,
    displayOrder: value.displayOrder,
    durationMinutes: value.durationMinutes,
    questionCount: QUIZ_POLICY.questionCount,
    passScore: value.passScore,
    attemptsPerDay: QUIZ_POLICY.attemptsPerCalendarDay,
    attemptResetTimezone: QUIZ_POLICY.attemptResetTimezone,
    presentation: null,
    updatedAt: value.publishedAt,
    seo: defaultContentSeo(value.title, value.description),
    jurisdiction: '',
    effectiveDate: '',
    sources: [],
  };
}

function localizedTopicFromRecord(value: LocalizedCourseRecord, locale: AppLocale): Topic {
  return {
    id: value.id,
    slug: value.slug,
    title: value.title,
    description: value.description,
    icon: value.icon,
    displayOrder: value.displayOrder,
    durationMinutes: value.durationMinutes,
    questionCount: QUIZ_POLICY.questionCount,
    passScore: value.passScore,
    attemptsPerDay: value.attemptsPerCalendarDay,
    attemptResetTimezone: value.resetTimezone,
    presentation: presentationFromRecord(value.presentation, value.slug, locale),
    updatedAt: value.publishedAt,
    seo: topicSeo(value.seo, value.title, value.description),
    ...metadataFields(value as unknown as Record<string, unknown>),
  };
}

async function getLocalizedTopicsFromSource(locale: AppLocale): Promise<Topic[]> {
  const supabase = createPublicClient();
  if (!supabase) return getLegacyTopics();
  try {
    const { data, error, status } = await (supabase as unknown as LocalizedCourseRpcClient).rpc(
      'list_published_courses_locale',
      { p_locale: locale },
    );
    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        fallback: () => lastKnownLocalizedTopics.get(locale) ?? [],
        operation: `list ${locale} topics`,
        status,
      });
    }
    const raw = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    const items = raw && 'items' in raw && Array.isArray(raw.items) ? raw.items : [];
    const topics = items
      .filter((item): item is LocalizedCourseListItem => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const row = item as Partial<LocalizedCourseListItem>;
        return (
          typeof row.slug === 'string' &&
          isContentSlug(row.slug) &&
          row.locale === locale &&
          typeof row.title === 'string' &&
          typeof row.description === 'string' &&
          typeof row.icon === 'string' &&
          Number.isInteger(row.displayOrder) &&
          Number.isInteger(row.durationMinutes) &&
          Number.isInteger(row.passScore) &&
          typeof row.publishedAt === 'string'
        );
      })
      .map(localizedTopicFromList);
    lastKnownLocalizedTopics.set(locale, topics);
    return topics;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () => lastKnownLocalizedTopics.get(locale) ?? [],
      operation: `list ${locale} topics`,
    });
  }
}

const getCachedLocalizedTopics = unstable_cache(
  getLocalizedTopicsFromSource,
  ['content-topics-localized-v1'],
  {
    revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
    tags: [CONTENT_CACHE_TAG, TOPICS_CACHE_TAG],
  },
);

export const getTopics = cache((locale: AppLocale = DEFAULT_LOCALE) =>
  rolloutFeatureEnabled('localeRoutes') ? getCachedLocalizedTopics(locale) : getLegacyTopics(),
);

async function getLocalizedTopicBySlugFromSource(slug: string, locale: AppLocale) {
  const supabase = createPublicClient();
  if (!supabase) return getLegacyTopicBySlug(slug);
  const key = localizedTopicKey(locale, slug);
  try {
    const { data, error, status } = await (supabase as unknown as LocalizedCourseRpcClient).rpc(
      'get_published_course_locale',
      { p_slug: slug, p_locale: locale },
    );
    if (error) {
      return fallbackAfterContentFailure({
        configured: true,
        error,
        fallback: () => lastKnownLocalizedTopicsBySlug.get(key) ?? null,
        operation: `read ${locale} topic ${slug}`,
        status,
      });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const topic = localizedTopicFromRecord(data as unknown as LocalizedCourseRecord, locale);
    lastKnownLocalizedTopicsBySlug.set(key, topic);
    return topic;
  } catch (error) {
    if (error instanceof ContentSourceError) throw error;
    return fallbackAfterContentFailure({
      configured: true,
      error,
      fallback: () => lastKnownLocalizedTopicsBySlug.get(key) ?? null,
      operation: `read ${locale} topic ${slug}`,
    });
  }
}

const getCachedLocalizedTopicBySlug = unstable_cache(
  getLocalizedTopicBySlugFromSource,
  ['content-topic-localized-v1'],
  {
    revalidate: CONTENT_CACHE_REVALIDATE_SECONDS,
    tags: [CONTENT_CACHE_TAG, TOPICS_CACHE_TAG],
  },
);

export const getTopicBySlug = cache((slug: string, locale: AppLocale = DEFAULT_LOCALE) => {
  if (!isContentSlug(slug)) return Promise.resolve(null);
  return rolloutFeatureEnabled('localeRoutes')
    ? getCachedLocalizedTopicBySlug(slug, locale)
    : getLegacyTopicBySlug(slug);
});

export async function getTopicSlugs(): Promise<string[]> {
  return (await getTopics()).map((topic) => topic.slug).filter(isContentSlug);
}

type CourseRedirectClient = {
  rpc(
    name: 'resolve_course_slug',
    args: { p_old_slug: string },
  ): PromiseLike<{
    data: string | null;
    error: { code?: string; message?: string } | null;
    status: number;
  }>;
};

export async function getTopicRedirectBySlug(slug: string): Promise<string | null> {
  if (!isContentSlug(slug)) return null;
  const supabase = createPublicClient();
  if (!supabase) return null;
  const { data, error } = await (supabase as unknown as CourseRedirectClient).rpc(
    'resolve_course_slug',
    { p_old_slug: slug },
  );
  if (error) return null;
  return typeof data === 'string' && isContentSlug(data) ? data : null;
}
