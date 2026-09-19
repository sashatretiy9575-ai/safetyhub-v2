import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
type BankQuestion = { id: string; text: string; correctOptionId: string };
type JsonLdNode = {
  '@type'?: string;
  inLanguage?: string;
  name?: string;
  description?: string;
  url?: string;
};
const slugs = ['svarshchik', 'promyshlennaya-bezopasnost'];
const locales = ['ru', 'kk', 'en', 'zh'];
// `htmlLanguage()` in i18n/config.ts: what <html lang> and the Course JSON-LD declare.
const htmlLanguages: Record<string, string> = {
  ru: 'ru-KZ',
  kk: 'kk-KZ',
  en: 'en',
  zh: 'zh-Hans',
};
// ADMIN_LOCALE_LABELS in lib/admin/localization-contract.ts.
const localeTabLabels: Record<string, string> = {
  ru: 'Русский',
  kk: 'Қазақша',
  en: 'English',
  zh: '简体中文',
};
// PRIVATE_PATHS in app/robots.ts, which also repeats each one under /kk, /en and /zh.
const robotsPrivatePaths = ['/profile', '/onboarding', '/auth/*', '/callback', '/topics/*/test'];
const localizedRoute = (locale: string, pathname: string) =>
  `${locale === 'ru' ? '' : '/' + locale}${pathname}`;
/** A robots.txt rule is a path prefix in which `*` stands for any run of characters. */
const robotsRule = (rule: string) =>
  new RegExp(
    '^' +
      rule
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*'),
  );
if (process.env.E2E_COURSE_BATCH === '1') {
  test.use({ channel: 'chrome' });
  for (const slug of slugs)
    for (const locale of locales) {
      test(`published ${slug}/${locale} desktop and mobile SEO`, async ({ page }) => {
        const deck = JSON.parse(
          await readFile(`content/course-batch-2026-09/${slug}/${locale}/deck.json`, 'utf8'),
        );
        const route = `${locale === 'ru' ? '' : '/' + locale}/topics/${slug}`;
        const response = await page.goto(route);
        expect(response?.status()).toBe(200);
        await expect(page.locator('h1')).toContainText(deck.title);
        await expect(page.locator('meta[name="description"]')).toHaveAttribute(
          'content',
          deck.seo.description,
        );
        const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
        expect(new URL(canonical!).pathname).toBe(route);
        const links = await page
          .locator('link[rel="alternate"][hreflang]')
          .evaluateAll((nodes) =>
            nodes.map((n) => ({ lang: n.getAttribute('hreflang'), href: n.getAttribute('href') })),
          );
        expect(links.map((l) => l.lang).sort()).toEqual(
          ['en', 'kk-KZ', 'ru-KZ', 'x-default', 'zh-Hans'].sort(),
        );
        for (const l of locales)
          expect(
            links.some(
              (x) => new URL(x.href!).pathname === `${l === 'ru' ? '' : '/' + l}/topics/${slug}`,
            ),
          ).toBe(true);
        await expect(page.locator('meta[property="og:image"]').first()).toHaveAttribute(
          'content',
          new RegExp(`${slug}-${locale}\\.webp`),
        );
        expect(await page.content()).not.toContain('correctOptionId');
        for (const width of [1440, 375]) {
          await page.setViewportSize({ width, height: 900 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          ).toBe(true);
        }
      });
    }
  test('published courses appear in sitemap; personal learning routes do not', async ({
    request,
  }) => {
    const r = await request.get('/sitemap.xml');
    expect(r.ok()).toBe(true);
    const body = await r.text();
    for (const slug of slugs)
      for (const l of locales)
        expect(body).toContain(`${l === 'ru' ? '' : '/' + l}/topics/${slug}`);
    expect(body).not.toMatch(/\/test<|\/profile<|\/api\/certificates/);
  });
  for (const slug of slugs)
    for (const locale of locales) {
      test(`published ${slug}/${locale} Open Graph text and Course structured data`, async ({
        page,
      }) => {
        const deck = JSON.parse(
          await readFile(`content/course-batch-2026-09/${slug}/${locale}/deck.json`, 'utf8'),
        );
        const route = localizedRoute(locale, `/topics/${slug}`);
        const response = await page.goto(route);
        expect(response?.status()).toBe(200);
        // The page swaps in a generated heading only when an editor left the SEO title equal
        // to the course name. The reviewed decks never do, so the stored text is served as is.
        expect(deck.seo.title).not.toBe(deck.title);
        await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
          'content',
          deck.seo.ogTitle,
        );
        await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
          'content',
          deck.seo.ogDescription,
        );
        const graph = await page
          .locator('script[type="application/ld+json"]')
          .evaluateAll((nodes) =>
            nodes.flatMap((node) => {
              const parsed: unknown = JSON.parse(node.textContent ?? 'null');
              return Array.isArray(parsed) ? parsed : [parsed];
            }),
          );
        const courses = (graph as (JsonLdNode | null)[]).filter(
          (node) => node?.['@type'] === 'Course',
        );
        expect(courses).toHaveLength(1);
        const course = courses[0]!;
        expect(course.inLanguage).toBe(htmlLanguages[locale]);
        expect(course.name).toBe(deck.title);
        expect(course.description).toBe(deck.description);
        expect(new URL(course.url!).pathname).toBe(route);
      });
    }
  test('the legacy industrial-safety address redirects permanently in every language', async ({
    request,
  }, info) => {
    const base = String(info.project.use.baseURL);
    for (const locale of locales) {
      const legacy = localizedRoute(locale, '/topics/industrial-safety');
      const destination = localizedRoute(locale, '/topics/promyshlennaya-bezopasnost');
      // `permanent: true` in next.config.ts answers 308, ahead of the page's own fallback.
      const redirect = await request.get(legacy, { maxRedirects: 0 });
      expect(redirect.status(), legacy).toBe(308);
      expect(new URL(redirect.headers()['location'] ?? '', base).pathname, legacy).toBe(
        destination,
      );
      const followed = await request.get(legacy);
      expect(followed.status(), legacy).toBe(200);
      expect(new URL(followed.url()).pathname, legacy).toBe(destination);
    }
  });
  test('robots.txt closes the private paths in every language and leaves the courses open', async ({
    request,
  }) => {
    const response = await request.get('/robots.txt');
    expect(response.ok()).toBe(true);
    const lines = (await response.text()).split(/\r?\n/).map((line) => line.trim());
    const disallowed = lines
      .filter((line) => /^disallow:/i.test(line))
      .map((line) => line.slice(line.indexOf(':') + 1).trim());
    for (const entry of [
      '/api/',
      '/admin',
      '/admin/*',
      ...robotsPrivatePaths,
      ...locales
        .filter((locale) => locale !== 'ru')
        .flatMap((locale) => robotsPrivatePaths.map((pathname) => `/${locale}${pathname}`)),
    ])
      expect(disallowed, entry).toContain(entry);
    expect(lines.some((line) => /^allow:\s*\/$/i.test(line))).toBe(true);
    expect(lines.some((line) => /^sitemap:\s*\S+\/sitemap\.xml$/i.test(line))).toBe(true);
    const blocked = (pathname: string) =>
      disallowed.some((rule) => rule !== '' && robotsRule(rule).test(pathname));
    for (const locale of locales) {
      expect(blocked(localizedRoute(locale, '/profile')), `${locale} profile`).toBe(true);
      for (const slug of slugs) {
        const route = localizedRoute(locale, `/topics/${slug}`);
        expect(blocked(route), route).toBe(false);
        expect(blocked(`${route}/test`), `${route}/test`).toBe(true);
      }
    }
  });
  test('an anonymous visitor is refused every presentation and thumbnail, with nothing to index', async ({
    playwright,
  }, info) => {
    // A context of its own with no cookies at all: what a crawler or a signed-out visitor gets.
    const anonymous = await playwright.request.newContext({
      baseURL: String(info.project.use.baseURL),
      storageState: { cookies: [], origins: [] },
    });
    try {
      for (const slug of slugs)
        for (const locale of locales)
          for (const asset of ['presentation', 'thumbnail']) {
            const address = `/course-presentations/${slug}/${asset}?locale=${locale}`;
            const response = await anonymous.get(address, { maxRedirects: 0 });
            // The route answers 401 itself (the proxy does not cover it), before any quota.
            expect(response.status(), address).toBe(401);
            const headers = response.headers();
            expect(headers['x-robots-tag'] ?? '', address).toContain('noindex');
            expect(headers['cache-control'] ?? '', address).toContain('no-store');
            expect(headers['content-type'] ?? '', address).not.toMatch(/pdf|image/i);
          }
    } finally {
      await anonymous.dispose();
    }
  });
  test('the course editor offers the four language tabs for both batch courses', async ({
    browser,
  }, info) => {
    test.setTimeout(180000);
    const base = String(info.project.use.baseURL);
    expect(['localhost', '127.0.0.1']).toContain(new URL(base).hostname);
    expect(process.env.E2E_ADMIN_STORAGE_STATE, 'Admin storage state is required').toBeTruthy();
    const admin = await browser.newContext({
      baseURL: base,
      storageState: process.env.E2E_ADMIN_STORAGE_STATE,
    });
    try {
      // The course-access read lists every published course with its id for ANY account id.
      // The administrator's own is used when it has an identity record; the listing does not
      // depend on it, so a synthetic id serves otherwise.
      const identityResponse = await admin.request.get('/api/identity');
      const identity = identityResponse.ok()
        ? ((await identityResponse.json()) as { userId?: string } | null)
        : null;
      const subject = identity?.userId ?? '00000000-0000-4000-8000-000000000000';
      const access = await admin.request.get(`/api/admin/users/${subject}/course-access`);
      expect(access.ok(), await access.text()).toBe(true);
      const published = (await access.json()).courses as { id: string; slug: string }[];
      const page = await admin.newPage();
      for (const slug of slugs) {
        const course = published.find((candidate) => candidate.slug === slug);
        expect(course, `${slug} is not among the published courses`).toBeTruthy();
        const response = await page.goto(`/admin/courses/${course!.id}`);
        expect(response?.status(), slug).toBe(200);
        const tablist = page
          .locator('[data-admin-course-localizations]')
          .getByRole('tablist', { name: 'Языки локализации' });
        await expect(tablist.getByRole('tab')).toHaveCount(4);
        for (const locale of locales)
          await expect(
            tablist.getByRole('tab', { name: localeTabLabels[locale]! }),
            `${slug}/${locale}`,
          ).toBeVisible();
        // Every tab says where its language stands, in words an administrator reads: a
        // published and complete translation is «Опубликовано»; a saved draft that
        // differs from the live revision is «Готово к публикации». Nothing in the batch
        // may read as unfilled, unready or published with gaps.
        for (const locale of locales) {
          const tab = tablist.getByRole('tab', { name: localeTabLabels[locale]! });
          await expect(tab, `${slug}/${locale}`).toContainText(
            /Опубликовано$|Готово к публикации/u,
          );
          await expect(tab, `${slug}/${locale}`).not.toContainText(
            /Не заполнено|Не готово|не полностью/u,
          );
        }
      }
    } finally {
      await admin.close();
    }
  });
  test('course permission gates, four-language questions, timer resume, and successful grading', async ({
    browser,
  }, info) => {
    test.setTimeout(600000);
    const base = String(info.project.use.baseURL);
    expect(['localhost', '127.0.0.1']).toContain(new URL(base).hostname);
    const admin = await browser.newContext({
      baseURL: base,
      storageState: process.env.E2E_ADMIN_STORAGE_STATE,
    });
    const learner = await browser.newContext({
      baseURL: base,
      storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE,
    });
    expect(process.env.E2E_ZH_STORAGE_STATE, 'Chinese realm fixture is required').toBeTruthy();
    const chineseLearner = await browser.newContext({
      baseURL: base,
      storageState: process.env.E2E_ZH_STORAGE_STATE,
    });
    const chineseIdentity = await (await chineseLearner.request.get('/api/identity')).json();
    expect(chineseIdentity.userId).toBeTruthy();
    const chineseAccessUrl = `/api/admin/users/${chineseIdentity.userId}/course-access`;
    const chineseAccess = await (await admin.request.get(chineseAccessUrl)).json();
    const chineseOriginal = chineseAccess.courses
      .filter((c: { granted: boolean }) => c.granted)
      .map((c: { id: string }) => c.id);
    const id = await (await learner.request.get('/api/identity')).json();
    expect(id.userId).toBeTruthy();
    const photo = await learner.request.get('/api/profile/avatar');
    if (photo.status() === 404) {
      const sharp = (await import('sharp')).default;
      const buffer = await sharp({
        create: { width: 360, height: 360, channels: 3, background: '#738491' },
      })
        .jpeg()
        .toBuffer();
      const upload = await learner.request.post('/api/profile/avatar', {
        headers: { origin: base },
        multipart: {
          avatar: { name: 'local-learner-fixture.jpg', mimeType: 'image/jpeg', buffer },
        },
      });
      expect(upload.ok(), await upload.text()).toBe(true);
    }
    const accessUrl = `/api/admin/users/${id.userId}/course-access`;
    const access = await (await admin.request.get(accessUrl)).json();
    const original = access.courses
      .filter((c: { granted: boolean }) => c.granted)
      .map((c: { id: string }) => c.id);
    const added = access.courses
      .filter((c: { slug: string }) => slugs.includes(c.slug))
      .map((c: { id: string }) => c.id);
    expect(added).toHaveLength(2);
    const setAccess = async (courseIds: string[], target = accessUrl) => {
      const r = await admin.request.put(target, {
        headers: { origin: base },
        data: { courseIds },
      });
      expect(r.ok(), await r.text()).toBe(true);
    };
    try {
      await setAccess(original.filter((i: string) => !added.includes(i)));
      for (const slug of slugs) {
        const denied = await learner.request.post('/api/attempts', {
          headers: { origin: base },
          data: { testSlug: slug, locale: 'ru' },
        });
        expect(denied.status()).toBe(403);
        expect((await denied.json()).error).toBe('COURSE_ACCESS_REQUIRED');
        const pdf = await learner.request.get(
          `/course-presentations/${slug}/presentation?locale=ru`,
        );
        expect(pdf.status()).toBe(403);
      }
      await setAccess([...new Set([...original, ...added])]);
      await setAccess([...new Set([...chineseOriginal, ...added])], chineseAccessUrl);
      const crossRealm = await learner.request.post('/api/attempts', {
        headers: { origin: base },
        data: { testSlug: slugs[0], locale: 'zh' },
      });
      expect(crossRealm.status()).toBe(403);
      expect((await crossRealm.json()).error).toBe('AUTH_REALM_LOCALE_MISMATCH');
      const profilePage = await learner.newPage();
      await profilePage.goto('/profile');
      await expect(async () => {
        if (!(await profilePage.locator('#profile-phone-country').isVisible())) {
          await profilePage.getByRole('button', { name: 'Изменить данные', exact: true }).click();
        }
        await expect(profilePage.locator('#profile-phone-country')).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 15000 });
      await profilePage.locator('#profile-phone-country').selectOption('CN');
      await expect(profilePage.locator('#profile-phone')).toHaveAttribute('placeholder', /\+86/);
      await profilePage.locator('#profile-phone').fill('13800138000');
      expect((await profilePage.locator('#profile-phone').inputValue()).replace(/\D/g, '')).toBe(
        '13800138000',
      );
      await profilePage.close();
      for (const slug of slugs)
        for (const locale of locales) {
          const actor = locale === 'zh' ? chineseLearner : learner;
          const q = JSON.parse(
            await readFile(
              `content/course-batch-2026-09/${slug}/${locale}/assessment.json`,
              'utf8',
            ),
          );
          const start = await actor.request.post('/api/attempts', {
            headers: { origin: base },
            data: { testSlug: slug, locale },
          });
          expect(start.ok(), `${slug}/${locale}: ${await start.text()}`).toBe(true);
          const attempt = await start.json();
          expect(attempt.locale).toBe(locale);
          expect(attempt.questions).toHaveLength(10);
          expect(attempt.durationMinutes).toBe(15);
          expect(attempt.passScore).toBe(7);
          expect(JSON.stringify(attempt)).not.toContain('correctOptionId');
          const bank = new Map(
            q.variants
              .flatMap((v: { questions: BankQuestion[] }) => v.questions)
              .map((item: BankQuestion) => [item.id, item]),
          );
          for (const question of attempt.questions) {
            expect(question.text).toBe((bank.get(question.id) as BankQuestion).text);
            expect(question.options).toHaveLength(4);
          }
          const resume = await actor.request.post('/api/attempts', {
            headers: { origin: base },
            data: { testSlug: slug, locale },
          });
          const resumed = await resume.json();
          expect(resumed.attemptId).toBe(attempt.attemptId);
          expect(resumed.expiresAt).toBe(attempt.expiresAt);
          if (locale === 'ru' || locale === 'zh') {
            const page = await actor.newPage();
            await page.goto(`${locale === 'zh' ? '/zh' : ''}/topics/${slug}/test`);
            await expect(page.getByText(attempt.questions[0].text, { exact: true })).toBeVisible();
            await page.reload();
            await expect(page.getByText(attempt.questions[0].text, { exact: true })).toBeVisible();
            await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
            await page.close();
          }
          const answers = attempt.questions.map((question: { id: string }) => ({
            questionId: question.id,
            optionId: (bank.get(question.id) as BankQuestion).correctOptionId,
          }));
          const done = await actor.request.post(`/api/attempts/${attempt.attemptId}/complete`, {
            headers: { origin: base },
            data: { attemptId: attempt.attemptId, answers },
          });
          expect(done.ok(), await done.text()).toBe(true);
          const result = await done.json();
          expect(result.score).toBe(10);
          expect(result.passed).toBe(true);
        }
    } finally {
      await setAccess(original);
      await setAccess(chineseOriginal, chineseAccessUrl);
      await admin.close();
      await learner.close();
      await chineseLearner.close();
    }
  });
}
