import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { LOCALE_PREFIXES, localizePathname } from './i18n/config';
import {
  reportingEndpointsHeader,
  STATIC_CONTENT_SECURITY_POLICY,
} from './lib/security/content-security-policy';
import { assertDeploymentRuntimeSecrets } from './lib/security/deployment-secrets';
import { assertDeploymentSiteUrl, resolveSiteOrigin } from './lib/site-url';

assertDeploymentSiteUrl();
assertDeploymentRuntimeSecrets();

const securityHeaders = [
  { key: 'Content-Security-Policy', value: STATIC_CONTENT_SECURITY_POLICY },
  // Chromium needs the endpoint group declared out of band; without it the
  // policy's report-to directive is inert and nothing can be measured before
  // tightening it.
  { key: 'Reporting-Endpoints', value: reportingEndpointsHeader(resolveSiteOrigin()) },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

const privateNoStoreHeaders = [
  { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
  { key: 'CDN-Cache-Control', value: 'no-store' },
  { key: 'Vercel-CDN-Cache-Control', value: 'no-store' },
  { key: 'Pragma', value: 'no-cache' },
  { key: 'Expires', value: '0' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
];

// Features this product never uses. The FLoC token that used to head this list
// was withdrawn with the API itself and is no longer parsed by any engine,
// while the browsing and attribution APIs that replaced it were left at their
// permissive defaults.
const DENIED_BROWSER_FEATURES = [
  'accelerometer',
  'ambient-light-sensor',
  'attribution-reporting',
  'autoplay',
  'bluetooth',
  'browsing-topics',
  'display-capture',
  'encrypted-media',
  'gyroscope',
  'hid',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'picture-in-picture',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'storage-access',
  'usb',
  'xr-spatial-tracking',
];

const permissionsPolicy = (camera: 'self' | 'none') =>
  [
    camera === 'self' ? 'camera=(self)' : 'camera=()',
    // The avatar flow previews a captured frame, which needs autoplay on the
    // screens that own it and nowhere else.
    ...(camera === 'self' ? ['autoplay=(self)'] : []),
    'geolocation=()',
    ...DENIED_BROWSER_FEATURES.filter(
      (feature) => !(camera === 'self' && feature === 'autoplay'),
    ).map((feature) => `${feature}=()`),
  ].join(', ');

const restrictedPermissions = {
  key: 'Permissions-Policy',
  value: permissionsPolicy('none'),
};

const profilePermissions = {
  key: 'Permissions-Policy',
  value: permissionsPolicy('self'),
};

const legacyTopicRedirects = [
  { source: '/topics/fire-safety', destination: '/topics/pozharnaya-bezopasnost' },
  { source: '/topics/occupational-health', destination: '/topics/biot' },
  { source: '/topics/industrial-safety', destination: '/topics' },
] as const;

const localizedPrivateSource = (pathname: string) =>
  `/:locale(${LOCALE_PREFIXES.join('|')})${pathname}`;

/** The screens allowed to use the camera, in every form they are served. */
const CAMERA_EXEMPT_PATH = `(?:(?:${LOCALE_PREFIXES.join('|')})/)?(?:onboarding|profile)(?:/.*)?$`;

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  serverExternalPackages: ['@napi-rs/canvas'],
  // Sharp discovers its platform binding and libvips payload dynamically.
  // Next's file tracer can otherwise keep the binding while dropping the
  // shared library from this route's Vercel function.
    outputFileTracingIncludes: {
      '/api/certificates/*/photo': ['./node_modules/@img/sharp-linux-x64/**/*', './node_modules/@img/sharp-libvips-linux-x64/**/*'],
      '/api/admin/documents/photo/*': ['./node_modules/@img/sharp-linux-x64/**/*', './node_modules/@img/sharp-libvips-linux-x64/**/*'],
    '/api/profile/avatar': [
      './node_modules/@img/sharp-linux-x64/**/*',
      './node_modules/@img/sharp-libvips-linux-x64/**/*',
    ],
    // Same reason, same payload: these two also call sharp, and without the
    // shared library the function throws on its first upload.
    '/api/admin/content-assets': [
      './node_modules/@img/sharp-linux-x64/**/*',
      './node_modules/@img/sharp-libvips-linux-x64/**/*',
    ],
    '/api/admin/courses/*/presentation/finalize': [
      './node_modules/@img/sharp-linux-x64/**/*',
      './node_modules/@img/sharp-libvips-linux-x64/**/*',
    ],
      '/certificate-assets/font': [
        './lib/pdf/assets/NotoSerif-Regular.ttf',
        './lib/pdf/assets/NotoSerif-Bold.ttf',
        './lib/pdf/assets/NotoSans-Bold.ttf',
      './lib/pdf/assets/noto-sans-latin-cyrillic.ttf',
      './lib/pdf/assets/NotoSansCJKsc-Regular-b2e9d66e.otf',
    ],
  },
  // The course snapshot is read with readdirSync, so the file tracer bundles
  // everything in the directory into every function that reads the catalogue:
  // five presentation PDFs, five thumbnails and the page manifests, none of
  // which any server route opens. They are only read by scripts.
  //
  // Verify on Linux, not on Windows: Next does not normalise separators here,
  // so on win32 these globs match nothing and the check passes for the wrong
  // reason.
  outputFileTracingExcludes: {
    '*': [
      './content/snapshots/courses/**/presentation.pdf',
      './content/snapshots/courses/**/thumbnail.webp',
      './content/snapshots/courses/**/presentation-manifest.json',
    ],
  },
  async redirects() {
    return [
      ...legacyTopicRedirects.map((redirect) => ({ ...redirect, permanent: true })),
      ...LOCALE_PREFIXES.flatMap((locale) =>
        legacyTopicRedirects.map((redirect) => ({
          source: localizePathname(redirect.source, locale),
          destination: localizePathname(redirect.destination, locale),
          permanent: true,
        })),
      ),
    ];
  },
  async headers() {
    return [
      {
        // Every font under /fonts is content-addressed, so it is safe to cache
        // indefinitely; publishing a changed font must use a new filename. The
        // rule used to name a single file, which left the four Manrope subsets
        // on the /public default of `max-age=0, must-revalidate` — four
        // conditional requests on every navigation, for the site's body text.
        source: '/fonts/:file([a-z0-9-]+\\.[0-9a-f]+\\.woff2)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      { source: '/', headers: [...securityHeaders, restrictedPermissions] },
      { source: '/onboarding/:path*', headers: [...securityHeaders, profilePermissions] },
      { source: '/profile/:path*', headers: [...securityHeaders, profilePermissions] },
      {
        source: localizedPrivateSource('/onboarding/:path*'),
        headers: [...securityHeaders, profilePermissions],
      },
      {
        source: localizedPrivateSource('/profile/:path*'),
        headers: [...securityHeaders, profilePermissions],
      },
      {
        // Last, and skipping exactly the screens above — including their
        // locale-prefixed forms. Next stops at the first matching source, so
        // with this rule ahead of them /kk/profile was served `camera=()` and
        // the avatar camera could not open on any prefixed route.
        source: `/:path((?!${CAMERA_EXEMPT_PATH}).*)`,
        headers: [...securityHeaders, restrictedPermissions],
      },
      {
        source: '/api/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: '/callback',
        headers: privateNoStoreHeaders,
      },
      {
        source: localizedPrivateSource('/callback'),
        headers: privateNoStoreHeaders,
      },
      {
        source: '/auth/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: localizedPrivateSource('/auth/:path*'),
        headers: privateNoStoreHeaders,
      },
      {
        source: '/onboarding/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: localizedPrivateSource('/onboarding/:path*'),
        headers: privateNoStoreHeaders,
      },
      {
        source: '/profile/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: localizedPrivateSource('/profile/:path*'),
        headers: privateNoStoreHeaders,
      },
      {
        source: '/admin/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: '/topics/:slug/test/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: localizedPrivateSource('/topics/:slug/test/:path*'),
        headers: privateNoStoreHeaders,
      },
      {
        // Verification URLs contain an unguessable bearer token and render
        // participant data plus live revocation state. Never retain that HTML
        // in browser caches or at the CDN, and never forward the token.
        source: '/verify/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: localizedPrivateSource('/verify/:path*'),
        headers: privateNoStoreHeaders,
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'CDN-Cache-Control', value: 'no-store' },
          { key: 'Vercel-CDN-Cache-Control', value: 'no-store' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    // Only these are asked for: 75 is next/image's own default, and 76, 78
    // and 82 are the values the components pass. Every other entry was an
    // extra variant the optimizer would happily cache and nothing requests.
    qualities: [75, 76, 78, 82],
  },
  experimental: {
    optimizePackageImports: ['@phosphor-icons/react', '@radix-ui/react-dropdown-menu'],
  },
};

export default withNextIntl(nextConfig);
