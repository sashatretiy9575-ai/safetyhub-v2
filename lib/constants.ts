export const BRAND = {
  name: 'SafetyHub',
  domain: 'SafetyHub.kz',
} as const;

export const ROUTES = {
  home: '/',
  topics: '/topics',
  topic: (slug: string) => `/topics/${slug}`,
  test: (slug: string) => `/topics/${slug}/test`,
  onboarding: '/onboarding',
  profile: '/profile',
  blog: '/blog',
  admin: '/admin',
  adminAccount: '/admin/account',
  signIn: '/auth/login',
  signUp: '/auth/register',
  contacts: '/contacts',
  faq: '/faq',
  privacy: '/privacy',
  terms: '/terms',
} as const;

export const PROTECTED_PATTERNS = [
  /^\/onboarding/,
  /^\/profile/,
  /^\/admin/,
  /^\/topics\/[^/]+\/test/,
] as const;

const DEFAULT_QUESTION_COUNT = 10;
const DEFAULT_PASS_SCORE = 7;

/**
 * Canonical product policy for the fixed-size SafetyHub assessment.
 * User-facing copy and certificate rendering must derive from this object.
 */
export const QUIZ_POLICY = {
  questionCount: DEFAULT_QUESTION_COUNT,
  passScore: DEFAULT_PASS_SCORE,
  /** Answers per question. The renderer, the editor and the parser share it. */
  optionCount: 4,
  durationMinutes: 15,
  durationMinutesMin: 1,
  durationMinutesMax: 120,
  variants: 3,
  attemptsPerCalendarDay: 8,
  attemptResetTimezone: 'Asia/Oral',
  passPercent: Math.round((DEFAULT_PASS_SCORE / DEFAULT_QUESTION_COUNT) * 100),
} as const;


/**
 * How many accounts one purge request may carry.
 *
 * The database function accepts up to 500, but a single HTTP request has to
 * finish inside the hosted statement timeout, so the admin UI splits a large
 * selection into chunks of this size and sends them one after another.
 */
/**
 * The largest row set one bulk attestation operation may carry. The database
 * refuses a broader filter, so the browser needs the same number to say why
 * before the request is made.
 */
export const ADMIN_ATTESTATION_BULK_LIMIT = 500;

/**
 * A synchronous certificate export renders every PDF inside one request, so it
 * is deliberately smaller than the queued job that the browser polls. Both
 * numbers used to be literals repeated across the route, the archive builder
 * and the operator panel.
 */
export const CERTIFICATE_EXPORT_SYNC_LIMIT = 100;

/** Upper bound of a queued certificate export job. */
export const CERTIFICATE_EXPORT_JOB_LIMIT = 500;

export const ADMIN_PURGE_BULK_LIMIT = 50;

/**
 * How many courses one learner may have open. `set_course_access` refuses a
 * longer list, so the route and the employee card check the same number and
 * can name the limit before the database does.
 */
export const ADMIN_COURSE_ACCESS_LIMIT = 200;
