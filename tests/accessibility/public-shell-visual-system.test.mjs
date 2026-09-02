import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('public shell uses neutral glass chrome and the 1024px navigation breakpoint', async () => {
  const [css, header, tabs, shell] = await Promise.all([
    read('app/globals.css'),
    read('components/layout/header.tsx'),
    read('components/layout/bottom-tab-bar.tsx'),
    read('components/layout/app-shell.tsx'),
  ]);

  assert.match(css, /--color-bg:\s*#f7f8fa/);
  assert.match(css, /--color-bg:\s*#0d0f12/);
  assert.match(css, /\.glass-strong/);
  assert.match(css, /@supports \(\(-webkit-backdrop-filter:/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(header, /glass-strong/);
  assert.match(header, /min-\[1024px\]:flex/);
  assert.match(header, /min-\[1024px\]:hidden/);
  assert.match(tabs, /rounded-\[var\(--radius-dock\)\]/);
  assert.match(tabs, /weight="regular"/);
  assert.match(tabs, /min-\[1024px\]:hidden/);
  assert.match(shell, /min-\[1024px\]:pb-0/);
});

test('theme, contact actions, and footer keep explicit accessible labels', async () => {
  const [theme, header, footer, ruMessages] = await Promise.all([
    read('components/shared/theme-toggle.tsx'),
    read('components/layout/header.tsx'),
    read('components/layout/footer.tsx'),
    read('messages/ru.json'),
  ]);
  const ru = JSON.parse(ruMessages);

  assert.match(theme, /role="switch"/);
  assert.match(theme, /aria-checked=\{isDark\}/);
  assert.match(theme, /translations\('light'\)/);
  assert.match(theme, /translations\('dark'\)/);
  assert.equal(ru.Shell.theme.light, 'Светлая');
  assert.equal(ru.Shell.theme.dark, 'Тёмная');
  assert.match(header, /translations\('call', \{ phone: contacts\.phoneDisplay \}\)/);
  assert.match(header, /translations\('whatsapp'\)/);
  assert.equal(ru.Shell.call, 'Позвонить: {phone}');
  assert.equal(ru.Shell.whatsapp, 'Написать в WhatsApp');
  assert.match(footer, /href="https:\/\/rc-web\.kz\/"/);
  assert.match(footer, /aria-label=\{translations\('footer\.navigation'\)\}/);
  assert.match(footer, /aria-label=\{translations\('footer\.legalNavigation'\)\}/);
  assert.equal(ru.Shell.footer.navigation, 'Навигация в подвале');
  assert.equal(ru.Shell.footer.legalNavigation, 'Юридическая информация');
  assert.match(footer, /text-white\/45/);
  assert.match(footer, /min-h-11/);
  assert.match(footer, /text-\[#ff8a24\]/);
  assert.match(footer, /sm:text-\[20px\]/);
});

test('marketing descriptions and card labels preserve native accessible semantics', async () => {
  const [testimonials, courses, articles, contacts] = await Promise.all([
    read('components/marketing/testimonials.tsx'),
    read('components/marketing/course-card.tsx'),
    read('components/marketing/article-card.tsx'),
    read('components/shared/contact-actions.tsx'),
  ]);

  assert.doesNotMatch(testimonials, /<dl className="mt-4/);
  assert.match(testimonials, /<div className="mt-4 space-y-3 text-sm">/);
  assert.doesNotMatch(courses, /aria-label=\{`Открыть курс/);
  assert.doesNotMatch(articles, /aria-label=\{`Читать статью/);
  assert.doesNotMatch(contacts, /aria-label=/);
});
