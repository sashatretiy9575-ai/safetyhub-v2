import type { NextConfig } from 'next';
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
  },
  async redirects() {
    return [
      {
        source: '/topics/fire-safety',
        destination: '/topics/pozharnaya-bezopasnost',
        permanent: true,
      },
      {
        source: '/topics/occupational-health',
        destination: '/topics/biot',
        permanent: true,
      },
      {
        source: '/topics/industrial-safety',
        destination: '/topics',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      { source: '/', headers: [...securityHeaders, restrictedPermissions] },
      { source: '/onboarding/:path*', headers: [...securityHeaders, profilePermissions] },
      { source: '/profile/:path*', headers: [...securityHeaders, profilePermissions] },
      {
        source: '/:path((?!onboarding(?:/.*)?$|profile(?:/.*)?$).*)',
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
        source: '/auth/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: '/onboarding/:path*',
        headers: privateNoStoreHeaders,
      },
      {
        source: '/profile/:path*',
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
        // Verification URLs contain an unguessable bearer token and render
        // participant data plus live revocation state. Never retain that HTML
        // in browser caches or at the CDN, and never forward the token.
        source: '/verify/:path*',
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

export default nextConfig;
