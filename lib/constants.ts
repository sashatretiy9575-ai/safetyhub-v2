export const BRAND = {
  name: 'SafetyHub',
  domain: 'SafetyHub.kz',
  tagline: 'Онлайн-обучение по охране труда и промышленной безопасности',
  city: 'Алматы',
  country: 'Казахстан',
} as const;

export const CONTACT_DETAILS = {
  city: 'Казахстан, г. Алматы',
  hours: 'Пн–Пт, 09:00–18:00',
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
  resetPassword: '/auth/reset-password',
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
  durationMinutes: 15,
  variants: 3,
  attemptsPerCalendarDay: 8,
  attemptResetTimezone: 'Asia/Oral',
  passPercent: Math.round((DEFAULT_PASS_SCORE / DEFAULT_QUESTION_COUNT) * 100),
} as const;

/** @deprecated Use QUIZ_POLICY for new code. */
export const QUIZ = {
  defaultPassPercent: QUIZ_POLICY.passPercent,
  defaultQuestionCount: QUIZ_POLICY.questionCount,
} as const;
