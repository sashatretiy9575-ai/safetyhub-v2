export const LIGHT_THEME_COLOR = '#f7f8fa';
export const DARK_THEME_COLOR = '#0d0f12';

export function applyDocumentTheme(dark: boolean) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const color = dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  root.style.backgroundColor = color;
  document.body?.style.setProperty('background-color', color);
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', color);
}

export function preferredDarkTheme() {
  try {
    const stored = window.localStorage.getItem('theme');
    return (
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    );
  } catch {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
}

const THEME_CHANGE_EVENT = 'safetyhub:theme-change';

// The store behind every theme control. The `dark` class on <html> is the one
// source of truth — the bootstrap script, ThemeProvider and another tab all
// write it — so a control reads the class instead of keeping a copy of it.
// `window` and `document` are touched only inside these functions: Node imports
// this module for the CSP hash test.
export function subscribeToTheme(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);

  return () => {
    observer.disconnect();
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
  };
}

export function getThemeSnapshot() {
  return document.documentElement.classList.contains('dark');
}

export function toggleTheme() {
  const root = document.documentElement;
  const dark = !root.classList.contains('dark');
  applyDocumentTheme(dark);

  try {
    window.localStorage.setItem('theme', dark ? 'dark' : 'light');
  } catch {
    // The selected theme still applies for the current session.
  }

  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export const THEME_BOOTSTRAP = `(()=>{try{const s=localStorage.getItem('theme');const d=s==='dark'||(s!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);const c=d?'${DARK_THEME_COLOR}':'${LIGHT_THEME_COLOR}';const r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';r.style.backgroundColor=c;const m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',c)}catch{}})()`;

// SHA-256 of THEME_BOOTSTRAP. It authorizes only this exact early theme script
// on nonce-protected auth/admin pages without making the public root dynamic.
export const THEME_BOOTSTRAP_CSP_HASH = "'sha256-dNBtcYJ/t71McTMhH1Es97mZ4QdzpKUWreW3GOheV/0='";
