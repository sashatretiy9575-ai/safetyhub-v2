export type InstallPlatform = 'ios' | 'android' | 'desktop' | 'other';

/**
 * Which set of manual instructions applies. Browsers without
 * `beforeinstallprompt` — iOS Safari above all — can only be told where the
 * menu item is, so the answer decides what the interface may offer.
 */
export function detectInstallPlatform(): InstallPlatform {
  const userAgent = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (window.matchMedia('(pointer: fine)').matches) return 'desktop';
  return 'other';
}
