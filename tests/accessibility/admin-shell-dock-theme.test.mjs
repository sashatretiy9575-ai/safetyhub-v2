import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
// Imported with no DOM in scope: the module must not touch `window` or
// `document` while it loads, because the CSP hash test imports it in Node too.
import { getThemeSnapshot, subscribeToTheme, toggleTheme } from '../../lib/theme.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

/** The few browser globals the theme store reads, recorded so a test can inspect them. */
function installBrowser({ dark = false, storageBlocked = false } = {}) {
  const classes = new Set(dark ? ['dark'] : []);
  const stored = new Map();
  const listeners = new Map();
  const observers = new Set();
  const themeColor = { content: '' };

  globalThis.document = {
    documentElement: {
      classList: {
        contains: (name) => classes.has(name),
        toggle(name, force) {
          if (force) classes.add(name);
          else classes.delete(name);
          return force;
        },
      },
      style: {},
    },
    body: { style: { setProperty() {} } },
    querySelector: () => ({
      setAttribute(name, value) {
        themeColor[name] = value;
      },
    }),
  };
  globalThis.window = {
    localStorage: {
      setItem(key, value) {
        if (storageBlocked) throw new Error('storage is blocked');
        stored.set(key, value);
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, new Set([...(listeners.get(type) ?? []), listener]));
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  globalThis.MutationObserver = class {
    observe(target, options) {
      observers.add(this);
      this.target = target;
      this.options = options;
    }
    disconnect() {
      observers.delete(this);
    }
  };

  return {
    stored,
    themeColor,
    observers,
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    restore() {
      delete globalThis.document;
      delete globalThis.window;
      delete globalThis.MutationObserver;
    },
  };
}

test('the theme store flips the class, remembers the choice and tells every control', () => {
  const browser = installBrowser();
  try {
    let notified = 0;
    const unsubscribe = subscribeToTheme(() => {
      notified += 1;
    });
    // The class is watched as well: the bootstrap script, ThemeProvider and
    // another tab change it without going through toggleTheme.
    const [observer] = browser.observers;
    assert.equal(observer.target, document.documentElement);
    assert.deepEqual(observer.options, { attributes: true, attributeFilter: ['class'] });

    assert.equal(getThemeSnapshot(), false);
    toggleTheme();
    assert.equal(getThemeSnapshot(), true);
    assert.equal(browser.stored.get('theme'), 'dark');
    assert.equal(document.documentElement.style.colorScheme, 'dark');
    assert.equal(browser.themeColor.content, '#0d0f12');
    assert.equal(notified, 1);

    toggleTheme();
    assert.equal(getThemeSnapshot(), false);
    assert.equal(browser.stored.get('theme'), 'light');
    assert.equal(browser.themeColor.content, '#f7f8fa');
    assert.equal(notified, 2);

    unsubscribe();
    assert.equal(browser.observers.size, 0);
    assert.equal(browser.listenerCount(), 0);
    toggleTheme();
    assert.equal(notified, 2);
  } finally {
    browser.restore();
  }
});

test('a blocked storage still switches the theme for the session', () => {
  const browser = installBrowser({ dark: true, storageBlocked: true });
  try {
    assert.doesNotThrow(() => toggleTheme());
    assert.equal(getThemeSnapshot(), false);
    assert.equal(browser.stored.size, 0);
  } finally {
    browser.restore();
  }
});

test('one store serves the header switch and the menu item', async () => {
  const [store, hook, toggle, menuItem] = await Promise.all([
    read('lib/theme.ts'),
    read('components/shared/use-theme.ts'),
    read('components/shared/theme-toggle.tsx'),
    read('components/shared/theme-menu-item.tsx'),
  ]);

  assert.match(store, /export function subscribeToTheme\(/u);
  assert.match(store, /export function getThemeSnapshot\(/u);
  assert.match(store, /export function toggleTheme\(/u);
  assert.match(hook, /useSyncExternalStore\(subscribeToTheme, getThemeSnapshot, \(\) => false\)/u);
  for (const control of [toggle, menuItem]) {
    assert.match(control, /const isDark = useIsDarkTheme\(\);/u);
    assert.match(control, /import \{ toggleTheme \} from '@\/lib\/theme';/u);
    // A second copy of the store is how two controls come to disagree.
    assert.doesNotMatch(control, /MutationObserver|localStorage|useSyncExternalStore/u);
  }
});

test('inside a menu the theme is a checkbox item styled like its neighbours', async () => {
  const [menuItem, menu, primitives] = await Promise.all([
    read('components/shared/theme-menu-item.tsx'),
    read('components/shared/user-menu.tsx'),
    read('components/ui/dropdown-menu.tsx'),
  ]);

  // `role="switch"` is not allowed inside `role="menu"`; Radix renders this
  // primitive as `menuitemcheckbox`.
  assert.match(primitives, /export const DropdownMenuCheckboxItem\b/u);
  assert.match(menuItem, /<DropdownMenuCheckboxItem\b/u);
  assert.doesNotMatch(menuItem, /role="switch"/u);
  assert.match(menuItem, /checked=\{isDark\}/u);
  assert.match(menuItem, /onCheckedChange=\{toggleTheme\}/u);
  // The menu stays open: the change is visible behind it.
  assert.match(menuItem, /onSelect=\{\(event\) => event\.preventDefault\(\)\}/u);
  assert.match(menuItem, /aria-label=\{isDark \? t\('switchToLight'\) : t\('switchToDark'\)\}/u);
  assert.match(menuItem, /\{isDark \? t\('dark'\) : t\('light'\)\}/u);
  assert.match(menuItem, /useTranslations\('Shell\.theme'\)/u);
  assert.deepEqual(
    [...new Set([...menuItem.matchAll(/\bt\('([A-Za-z]+)'\)/gu)].map((match) => match[1]))].sort(),
    ['dark', 'light', 'switchToDark', 'switchToLight'],
  );
  assert.doesNotMatch(menuItem, /[Ѐ-ӿ]/u);

  // The same row, icon and text recipe as the items around it.
  for (const recipe of [
    'className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"',
    '<div className="flex min-w-0 items-center gap-3">',
    'size={18} weight="regular" className="text-[var(--color-text-muted)]"',
    '<span className="text-sm font-medium [overflow-wrap:anywhere] whitespace-normal">',
  ]) {
    assert.ok(menu.includes(recipe), `user-menu.tsx no longer uses: ${recipe}`);
    assert.ok(
      menuItem.includes(recipe),
      `theme-menu-item.tsx differs from its neighbours: ${recipe}`,
    );
  }
});

test('only the admin shell puts the theme into the user menu', async () => {
  const [menu, adminLayout, accountLayout, header] = await Promise.all([
    read('components/shared/user-menu.tsx'),
    read('app/(admin)/admin/layout.tsx'),
    read('app/(account)/layout.tsx'),
    read('components/layout/header.tsx'),
  ]);

  assert.match(menu, /showThemeToggle\?: boolean;/u);
  assert.match(menu, /showThemeToggle = false,/u);
  assert.equal((menu.match(/<ThemeMenuItem\b/gu) ?? []).length, 1);
  // Above the separator and the sign-out row, and nowhere without the flag.
  assert.match(
    menu,
    /\{showThemeToggle \? <ThemeMenuItem \/> : null\}\s*<DropdownMenuSeparator [^>]*\/>\s*<SignOutAction menuItem \/>/u,
  );

  const adminMenus = adminLayout.match(/<UserMenu\b[\s\S]*?\/>/gu) ?? [];
  assert.equal(adminMenus.length, 2);
  for (const element of adminMenus) assert.match(element, /\sshowThemeToggle\s+\/>$/u);

  // The account shell is the site header, which carries its own switch: a
  // second one in the menu would duplicate it.
  assert.match(header, /<DeferredThemeToggle \/>/u);
  assert.doesNotMatch(accountLayout, /showThemeToggle/u);
});

test('a menu says «Выйти»; only a page button spells out the device clean-up', async () => {
  const [signOut, menu, adminAccount, ruMessages] = await Promise.all([
    read('components/shared/sign-out-action.tsx'),
    read('components/shared/user-menu.tsx'),
    read('app/(admin)/admin/account/page.tsx'),
    read('messages/ru.json'),
  ]);
  const ru = JSON.parse(ruMessages);

  assert.match(
    signOut,
    /const label = menuItem \|\| compact \? t\('signOutShort'\) : t\('signOut'\);/u,
  );
  assert.equal((signOut.match(/signingOut \? t\('signingOut'\) : label/gu) ?? []).length, 2);
  assert.equal((signOut.match(/t\('signOut'\)/gu) ?? []).length, 1);
  assert.equal(ru.Shell.userMenu.signOutShort, 'Выйти');
  assert.match(menu, /<SignOutAction menuItem \/>/u);
  assert.match(adminAccount, /<SignOutAction compact \/>/u);
  // The wording changed, not what signing out does.
  assert.match(signOut, /await clearSafetyHubDeviceData\(\);/u);
});

test('the admin dock is the site dock and survives a short window', async () => {
  const [tabs, navLink, dockItem, layout, css] = await Promise.all([
    read('components/layout/bottom-tab-bar.tsx'),
    read('components/admin/admin-nav-link.tsx'),
    read('components/layout/dock-item.tsx'),
    read('app/(admin)/admin/layout.tsx'),
    read('app/globals.css'),
  ]);

  for (const caller of [tabs, navLink]) {
    assert.match(caller, /import \{ DockItem \} from '@\/components\/layout\/dock-item';/u);
  }
  // No hooks in the item: each caller decides what "active" means.
  assert.doesNotMatch(dockItem, /\buse[A-Z]\w*\(/u);
  assert.match(dockItem, /import Link from '@\/components\/shared\/navigation-link';/u);

  // The phone branch hands everything to the shared item; the wrap is the only
  // thing the admin adds: five items go 3 + 2 below 360 px, the last one
  // taking the rest of the row; six («Документы») go 3 + 3 below 400 px.
  assert.match(
    navLink,
    /if \(mobile\) \{\s*return \(\s*<DockItem\s+href=\{href\}\s+label=\{label\}\s+shortLabel=\{shortLabel\}\s+active=\{active\}\s+className=\{spanLast \? 'last:col-span-2 min-\[360px\]:last:col-span-1' : undefined\}/u,
  );
  assert.match(
    layout,
    /className=\{`grid grid-cols-3 gap-0\.5 \$\{sixItems \? 'xs:grid-cols-6' : 'min-\[360px\]:grid-cols-5'\}`\}/u,
  );
  assert.match(layout, /spanLast=\{!sixItems\}/u);
  assert.match(layout, /href: '\/admin\/documents', icon: Certificate, label: 'Документы'/u);
  assert.match(layout, /label: 'Сотрудники', shortLabel: 'Люди'/u);

  // The pill takes the classes of the public dock, minus its fixed height.
  const publicDock = tabs.match(/<nav[\s\S]+?className="([^"]+)"/u)?.[1] ?? '';
  const adminDock = layout.match(/data-admin-mobile-nav[\s\S]+?className="([^"]+)"/u)?.[1] ?? '';
  const classes = (value) => new Set(value.split(' '));
  assert.ok(publicDock.includes('h-[var(--mobile-tab-height)]'));
  for (const name of classes(publicDock)) {
    if (name === 'h-[var(--mobile-tab-height)]') continue;
    assert.ok(classes(adminDock).has(name), `the admin dock lost ${name}`);
  }
  assert.deepEqual(
    [...classes(adminDock)].filter((name) => !classes(publicDock).has(name)),
    ['mt-2'],
  );

  // globals.css un-sticks the dock in a short window through this attribute;
  // there the pill is an ordinary flex item, centred by its auto margins. A
  // width of 100% would overflow the fixed pill by its two side insets.
  assert.match(layout, /<nav\s+data-admin-mobile-nav\s/u);
  assert.match(
    css,
    /\[data-admin-mobile-header\],\s*\[data-admin-mobile-nav\] \{\s*position: static;\s*\}\s*\[data-admin-mobile-nav\] \{\s*order: 1;\s*\}/u,
  );
  assert.ok(classes(adminDock).has('mx-auto'));
  assert.ok(!classes(adminDock).has('w-full'));
});
