import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
type BankQuestion = { id: string; text: string; correctOptionId: string };
const slugs = ['svarshchik', 'promyshlennaya-bezopasnost'];
const locales = ['ru', 'kk', 'en', 'zh'];
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
