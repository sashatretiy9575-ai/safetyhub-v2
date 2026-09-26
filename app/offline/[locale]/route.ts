import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  htmlLanguage,
  isAppLocale,
  localizePathname,
  type AppLocale,
} from '@/i18n/config';
import { loadMessages } from '@/i18n/messages';
import { rolloutFeatureEnabled } from '@/lib/rollout-flags';

export const dynamicParams = false;

export function generateStaticParams() {
  return APP_LOCALES.map((locale) => ({ locale }));
}

const OFFLINE_FALLBACK: Record<
  AppLocale,
  { title: string; description: string; home: string }
> = {
  ru: {
    title: 'Нет подключения',
    description:
      'Проверьте интернет и повторите попытку. Без связи тест нельзя начать или отправить.',
    home: 'На главную',
  },
  kk: {
    title: 'Интернет байланысы жоқ',
    description:
      'Интернетті тексеріп, қайталап көріңіз. Байланыссыз тестті бастау не жіберу мүмкін емес.',
    home: 'Басты бетке',
  },
  en: {
    title: 'You’re offline',
    description:
      'Check your connection and try again. A test can’t be started or submitted offline.',
    home: 'Back to home',
  },
  zh: {
    title: '网络连接已断开',
    description: '请检查网络连接后重试。离线时无法开始或提交测试。',
    home: '返回首页',
  },
};

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export async function GET(_request: Request, context: { params: Promise<{ locale: string }> }) {
  const { locale: candidate } = await context.params;
  if (!isAppLocale(candidate)) return new Response('Not found', { status: 404 });
  if (candidate !== DEFAULT_LOCALE && !rolloutFeatureEnabled('localeRoutes')) {
    return new Response('Not found', { status: 404 });
  }

  // The page a visitor reaches without a network cannot ask for a translation,
  // so the last resort carries its own copy in every language instead of
  // showing Russian to a Chinese reader.
  const fallback = OFFLINE_FALLBACK[candidate];
  let title = escapeHtml(fallback.title);
  let description = escapeHtml(fallback.description);
  let home = escapeHtml(fallback.home);
  const homeUrl = escapeHtml(localizePathname('/', candidate));

  try {
    const messages = await loadMessages(candidate);
    const offline = messages.Offline as Record<'title' | 'description' | 'home', string> | undefined;
    if (offline?.title) title = escapeHtml(offline.title);
    if (offline?.description) description = escapeHtml(offline.description);
    if (offline?.home) home = escapeHtml(offline.home);
  } catch {
    // Fallback strings remain active
  }

  const document = `<!doctype html>
<html lang="${htmlLanguage(candidate)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#176b43" />
    <title>${title} — SafetyHub</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom)); background: #f4faf6; color: #0e0e0e; }
      main { width: min(100%, 420px); border: 1px solid #d4dad7; border-radius: 24px; background: #fff; padding: 28px; text-align: center; box-shadow: 0 16px 48px -16px rgb(15 23 42 / 0.18); }
      .mark { display: grid; place-items: center; width: 64px; height: 64px; margin: 0 auto 20px; border-radius: 18px; background: #176b43; color: #fff; font-size: 34px; font-weight: 900; }
      h1 { margin: 0; font-size: clamp(24px, 8vw, 34px); line-height: 1.1; }
      p { margin: 12px 0 22px; color: #5f6b66; line-height: 1.55; }
      a { min-height: 48px; width: 100%; display: grid; place-items: center; border-radius: 999px; background: #176b43; color: #fff; padding: 12px 18px; font: inherit; font-weight: 800; text-decoration: none; }
      a:focus-visible { outline: 3px solid rgb(23 107 67 / 0.4); outline-offset: 3px; }
      @media (prefers-color-scheme: dark) { body { background: #0b0d0c; color: #f5f7f6; } main { border-color: #3a423e; background: #131715; } p { color: #b3bcb6; } }
    </style>
  </head>
  <body>
    <main>
      <div class="mark" aria-hidden="true">✓</div>
      <h1>${title}</h1>
      <p>${description}</p>
      <a href="${homeUrl}">${home}</a>
    </main>
  </body>
</html>`;

  return new Response(document, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800',
      'Content-Type': 'text/html; charset=utf-8',
      Vary: 'Accept-Encoding',
    },
  });
}
