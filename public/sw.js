const CACHE_PREFIX = 'safetyhub-static-';
const CACHE_VERSION = `${CACHE_PREFIX}v6`;
const OFFLINE_URL = '/offline.html';
const NAVIGATION_TIMEOUT_MS = 6000;
const RUNTIME_MAX_ENTRIES = 48;
const RUNTIME_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CACHED_AT_HEADER = 'x-safetyhub-cached-at';
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/maskable-512x512.png',
  '/icons/apple-touch-icon.png',
];

// Content-hashed Next.js chunks already have an immutable HTTP cache policy.
// Duplicating them in Cache Storage makes old deploys accumulate indefinitely.
const STATIC_PREFIXES = ['/icons/', '/images/', '/fonts/'];
const PRIVATE_PATH =
  /^\/(?:[a-z]{2}\/)?(?:api|auth|admin|profile|account|onboarding|callback)(?:\/|$)/;
const AUTH_CALLBACK_PATH = /^\/(?:[a-z]{2}\/)?(?:auth\/)?callback(?:\/|$)/;
const PRIVATE_TOPIC_TEST_PATH = /^\/(?:[a-z]{2}\/)?topics\/[^/]+\/test(?:\/|$)/;
const PRECACHE_PATHS = new Set(PRECACHE_URLS);

function isPrecached(request) {
  return PRECACHE_PATHS.has(new URL(request.url).pathname);
}

function isPrivatePath(pathname) {
  return PRIVATE_PATH.test(pathname) || PRIVATE_TOPIC_TEST_PATH.test(pathname);
}

function isAuthCallbackPath(pathname) {
  return AUTH_CALLBACK_PATH.test(pathname);
}

async function authCallbackResponse(event) {
  const preloaded = await Promise.resolve(event.preloadResponse).catch(() => undefined);
  return preloaded || fetch(event.request);
}

async function trimRuntimeCache(cache) {
  const now = Date.now();
  const runtimeEntries = [];

  for (const request of await cache.keys()) {
    if (isPrecached(request)) continue;
    const response = await cache.match(request);
    const cachedAt = Number(response?.headers.get(CACHED_AT_HEADER) ?? 0);
    if (!response || !Number.isFinite(cachedAt) || now - cachedAt > RUNTIME_MAX_AGE_MS) {
      await cache.delete(request);
      continue;
    }
    runtimeEntries.push({ request, cachedAt });
  }

  runtimeEntries.sort((left, right) => left.cachedAt - right.cachedAt);
  while (runtimeEntries.length > RUNTIME_MAX_ENTRIES) {
    const oldest = runtimeEntries.shift();
    if (oldest) await cache.delete(oldest.request);
  }
}

async function putRuntimeResponse(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(Date.now()));
  const stamped = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  try {
    await cache.put(request, stamped);
  } catch {
    // Quota pressure must never break the network response or the PWA shell.
  }
  await trimRuntimeCache(cache);
}

async function freshCachedResponse(cache, request) {
  const response = await cache.match(request);
  if (!response || isPrecached(request)) return response;
  const cachedAt = Number(response.headers.get(CACHED_AT_HEADER) ?? 0);
  if (!Number.isFinite(cachedAt) || Date.now() - cachedAt > RUNTIME_MAX_AGE_MS) {
    await cache.delete(request);
    return undefined;
  }
  return response;
}

async function navigationResponse(event) {
  const network = Promise.resolve(event.preloadResponse)
    .catch(() => undefined)
    .then((preloaded) => preloaded || fetch(event.request))
    .then((response) => {
      if (!response || !response.ok) throw new Error('NAVIGATION_FAILED');
      return response;
    });
  // Keep a useful slow response alive without blocking the offline fallback.
  event.waitUntil(network.then(() => undefined).catch(() => undefined));

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
    return (await caches.match(OFFLINE_URL)) || Response.error();
  } catch {
    return (await caches.match(OFFLINE_URL)) || Response.error();
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      ),
      self.registration.navigationPreload?.enable() ?? Promise.resolve(),
    ]).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Turbopack reuses development chunk URLs. Let localhost always reach the
  // network so a previously installed PWA can never break Fast Refresh.
  if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') {
    return;
  }

  // Navigation preload has already started a request before the worker runs.
  // Consume it for one-time callbacks so falling through cannot issue the same
  // PKCE exchange twice.
  if (request.mode === 'navigate' && isAuthCallbackPath(url.pathname)) {
    event.respondWith(authCallbackResponse(event));
    return;
  }

  // Authenticated pages and downloads must stay fully browser-native. A
  // service-worker navigation response can suppress Content-Disposition and a
  // slow mobile request must never be replaced with the public offline shell.
  if (isPrivatePath(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(event));
    return;
  }

  const isStaticAsset =
    STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ||
    url.pathname === '/manifest.json' ||
    url.pathname === OFFLINE_URL;

  if (!isStaticAsset) return;

  const cachePromise = caches.open(CACHE_VERSION);
  const cachedPromise = cachePromise.then((cache) => freshCachedResponse(cache, request));
  const networkPromise = fetch(request).then(async (response) => {
    if (response.ok && response.type === 'basic') {
      await putRuntimeResponse(await cachePromise, request, response);
    }
    return response;
  });

  event.waitUntil(networkPromise.then(() => undefined).catch(() => undefined));
  event.respondWith(
    cachedPromise.then((cachedResponse) => cachedResponse || networkPromise).catch(() => networkPromise),
  );
});
