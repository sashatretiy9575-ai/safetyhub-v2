/**
 * `beforeinstallprompt` fires once, early, and cannot be replayed. The install
 * banner lives in a lazily loaded client chunk, so on a full document load the
 * browser regularly fired the event before that chunk had attached its listener
 * and the banner never appeared — while a later soft navigation, which makes
 * Chrome re-evaluate installability, made it appear out of nowhere.
 *
 * This runs in the document head, before any React code, and parks the event on
 * `window` so the hook can pick it up whenever it mounts. Same shape as the
 * theme bootstrap in `lib/theme.ts`.
 */
export const PWA_INSTALL_EVENT_KEY = '__safetyhubInstallPrompt';
export const PWA_INSTALL_READY_EVENT = 'safetyhub:install-prompt';

export const PWA_INSTALL_BOOTSTRAP = `(function(){try{
window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();
window['${PWA_INSTALL_EVENT_KEY}']=e;
window.dispatchEvent(new Event('${PWA_INSTALL_READY_EVENT}'));});
window.addEventListener('appinstalled',function(){window['${PWA_INSTALL_EVENT_KEY}']=null;
window.dispatchEvent(new Event('${PWA_INSTALL_READY_EVENT}'));});
}catch(_){}})();`;

// SHA-256 of PWA_INSTALL_BOOTSTRAP. Account and admin HTML is served with a
// strict nonce policy that has no 'unsafe-inline', so this exact script has to
// be authorized by hash the same way the theme bootstrap is. Regenerated and
// verified by tests/security/browser-headers.test.mjs.
export const PWA_INSTALL_BOOTSTRAP_CSP_HASH =
  "'sha256-wfAlwSms+L0OleTj5Bcv7aB8SMP9nq3uHPiBsbKKt6U='";
