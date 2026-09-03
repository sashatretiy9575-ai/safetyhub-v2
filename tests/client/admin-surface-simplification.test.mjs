import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('settings consolidates contacts, companies, and history without access management', async () => {
  const [settings, contacts, access, overview, audit] = await Promise.all([
    read('app/(admin)/admin/settings/page.tsx'),
    read('components/admin/site-contacts-form.tsx'),
    read('app/(admin)/admin/access/page.tsx'),
    read('app/(admin)/admin/page.tsx'),
    read('app/(admin)/admin/audit/page.tsx'),
  ]);
  assert.match(settings, />Настройки<\/h1>/);
  assert.match(settings, /Контакты сайта/);
  assert.match(settings, /\/admin\/organizations\/cleanup/);
  assert.match(settings, /\/admin\/settings\/history/);
  assert.doesNotMatch(settings, /роль|полномочи|superadmin/iu);
  assert.doesNotMatch(contacts, /Предпросмотр|Версия \{settings\.version\}|updatedBy/iu);
  assert.match(contacts, /Контакты сохранены\./u);
  assert.equal((contacts.match(/role="alert"/g) ?? []).length, 2);
  assert.match(access, /redirect\('\/admin\/settings'\)/);
  assert.equal((overview.match(/href: '\/admin\/employees\?certificate=/g) ?? []).length, 2);
  assert.match(overview, /href: '\/admin\/organizations\/cleanup'/);
  assert.match(overview, /aria-label="Рабочие очереди"/);
  assert.doesNotMatch(overview, /<Card/);
  assert.doesNotMatch(overview, /Рабочая сводка доступных вам разделов/u);
  const auditList = audit.slice(audit.indexOf('auditResult.data.items.map'));
  assert.equal((auditList.match(/Код обращения/g) ?? []).length, 1);
});
