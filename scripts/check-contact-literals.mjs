import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const roots = ['app', 'components', 'features', 'lib'];
const allowed = new Set([
  path.normalize('lib/site-contacts.ts'),
  path.normalize('lib/site-contacts-shared.ts'),
  path.normalize('components/admin/site-contacts-form.tsx'),
]);
const violations = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute);
    } else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
      const relative = path.normalize(path.relative(root, absolute));
      if (allowed.has(relative)) continue;
      const source = await readFile(absolute, 'utf8');
      if (/tel:|https:\/\/wa\.me\/|\+7\s*701\s*729\s*0349/.test(source)) {
        violations.push(relative);
      }
    }
  }
}

for (const directory of roots) await walk(path.join(root, directory));

if (violations.length) {
  console.error(
    `Direct contact literals are forbidden outside SAFETYHUB_GLOBAL_CONTACTS:\n${violations.join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log('Contact literals are centralized.');
}
