'use client';

const SUPABASE_AUTH_STORAGE_KEY = /^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/iu;

function isSafetyHubStorageKey(key: string | null) {
  return (
    key === 'theme' ||
    key?.startsWith('safetyhub:') ||
    key?.startsWith('safetyhub-') ||
    (key !== null && SUPABASE_AUTH_STORAGE_KEY.test(key))
  );
}

function clearKnownStorage(storage: Storage) {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (isSafetyHubStorageKey(key) && key !== null) storage.removeItem(key);
  }
}

/**
 * Clears only known SafetyHub browser state. It deliberately leaves unrelated
 * origin storage and Cloudflare/Turnstile cookies alone; server endpoints
 * remain responsible for HttpOnly session cookies.
 */
export async function clearSafetyHubDeviceData() {
  try {
    clearKnownStorage(window.localStorage);
  } catch {
    // Storage can be unavailable in private or hardened browser contexts.
  }
  try {
    clearKnownStorage(window.sessionStorage);
  } catch {
    // Storage can be unavailable in private or hardened browser contexts.
  }

  try {
    const cacheNames = await window.caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith('safetyhub-'))
        .map((name) => window.caches.delete(name)),
    );
  } catch {
    // Cache Storage may be unavailable; the server Clear-Site-Data header is
    // still applied by browsers that support it.
  }
}
