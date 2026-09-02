import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { LOCALE_PREFIXES, localizePathname } from './i18n/config';
import { STATIC_CONTENT_SECURITY_POLICY } from './lib/security/content-security-policy';
import { assertDeploymentSiteUrl } from './lib/site-url';

assertDeploymentSiteUrl();

const securityHeaders = [
  { key: 'Content-Security-Policy', value: STATIC_CONTENT_SECURITY_POLICY },
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

const restrictedPermissions = {
  key: 'Permissions-Policy',
  value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};

const profilePermissions = {
  key: 'Permissions-Policy',
  value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};

const legacyTopicRedirects = [
  { source: '/topics/fire-safety', destination: '/topics/pozharnaya-bezopasnost' },
  { source: '/topics/occupational-health', destination: '/topics/biot' },
  { source: '/topics/industrial-safety', destination: '/topics' },
] as const;

const localizedPrivateSource = (pathname: string) =>
  `/:locale(${LOCALE_PREFIXES.join('|')})${pathname}`;

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
    '/api/profile/avatar': [
      './node_modules/@img/sharp-linux-x64/**/*',
      './node_modules/@img/sharp-libvips-linux-x64/**/*',
    ],
    '/certificate-assets/font': [
      './lib/pdf/assets/noto-sans-latin-cyrillic.ttf',
      './lib/pdf/assets/NotoSansCJKsc-Regular-Sans2.004.otf',
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
        // This is a content-addressed UI font. It is safe to cache indefinitely;
        // publishing a changed font must use a new filename.
        source: '/fonts/noto-sans-sc-ui.f113fe63.woff2',
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
        source: '/:path((?!onboarding(?:/.*)?$|profile(?:/.*)?$).*)',
        headers: [...securityHeaders, restrictedPermissions],
      },
      {
        source: localizedPrivateSource('/onboarding/:path*'),
        headers: [...securityHeaders, profilePermissions],
      },
      {
        source: localizedPrivateSource('/profile/:path*'),
        headers: [...securityHeaders, profilePermissions],
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
    qualities: [70, 72, 75, 76, 78, 80, 82, 90],
  },
  experimental: {
    optimizePackageImports: ['@phosphor-icons/react', '@radix-ui/react-dropdown-menu'],
  },
};

export default withNextIntl(nextConfig);
