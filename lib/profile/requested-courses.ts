// The course a visitor clicked before they had an account. It waits in this
// browser until the onboarding form sends it with the application, so the
// administrator sees which course the newcomer came for.
const KEY = 'safetyhub:requested-courses';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const LIMIT = 5;

export function readRequestedCourses(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value)
      ? value
          .filter((slug): slug is string => typeof slug === 'string' && SLUG.test(slug))
          .slice(0, LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function rememberRequestedCourse(slug: string) {
  if (!SLUG.test(slug)) return;
  try {
    const courses = [slug, ...readRequestedCourses().filter((item) => item !== slug)];
    localStorage.setItem(KEY, JSON.stringify(courses.slice(0, LIMIT)));
  } catch {
    // Storage unavailable: the person picks the course again after approval.
  }
}

export function forgetRequestedCourses() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable
  }
}
