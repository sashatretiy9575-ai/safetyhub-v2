import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from '@/components/shared/theme-provider';
import { PWARegistration } from '@/components/shared/pwa-registration';
import { buildMetadata } from '@/lib/seo';
import './globals.css';

export const metadata: Metadata = {
  ...buildMetadata({
    description:
      'Онлайн-обучение по промышленной безопасности, охране труда и пожарной безопасности.',
  }),
  alternates: {},
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'SafetyHub',
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#f7f8fa',
  colorScheme: 'light dark',
  viewportFit: 'cover',
};

export const preferredRegion = 'fra1';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className="bg-[var(--color-bg)] text-[var(--color-text)] antialiased">
        <ThemeProvider>
          {children}
          <PWARegistration />
        </ThemeProvider>
      </body>
    </html>
  );
}
