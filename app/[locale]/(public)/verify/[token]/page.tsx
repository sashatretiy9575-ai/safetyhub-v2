// Certificate verification contains a bearer-like token and personal record
// fields; it shares the physical locale document but must never enter ISR/CDN.
export const dynamic = 'force-dynamic';

import BasePage, { generateMetadata as baseGenerateMetadata } from '@/app/(public)/verify/[token]/page';
import { setPhysicalLocale } from '../../../locale-context';

type Props = { params: Promise<{ locale: string; token: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  setPhysicalLocale(locale);
  return baseGenerateMetadata();
}

export default async function LocalizedVerifyCertificatePage({ params }: Props) {
  const { locale, token } = await params;
  setPhysicalLocale(locale);
  return <BasePage params={Promise.resolve({ token })} />;
}
