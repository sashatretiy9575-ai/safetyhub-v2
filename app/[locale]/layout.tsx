import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { RootDocument } from '@/components/layout/root-document';
import { LOCALE_PREFIXES, isAppLocale, type AppLocale } from '@/i18n/config';
import { buildMetadata } from '@/lib/seo';
import '../globals.css';

export const revalidate = 300;
export const dynamicParams = false;
export const preferredRegion = 'fra1';

export const viewport: Viewport = {
  themeColor: '#f7f8fa',
  colorScheme: 'light dark',
  viewportFit: 'cover',
};

function localeFromParams(value: string): AppLocale {
  if (!isAppLocale(value) || value === 'ru') notFound();
  return value;
}

export function generateStaticParams() {
  return LOCALE_PREFIXES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const locale = localeFromParams((await params).locale);
  setRequestLocale(locale);
  const metadata = await getTranslations('Metadata');
  return {
    ...buildMetadata({ description: metadata('description'), path: '/', locale }),
    manifest: `/manifest/${locale}`,
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
}

export default async function LocalizedRootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const locale = localeFromParams((await params).locale);
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <RootDocument locale={locale} messages={messages}>
      {children}
    </RootDocument>
  );
}
