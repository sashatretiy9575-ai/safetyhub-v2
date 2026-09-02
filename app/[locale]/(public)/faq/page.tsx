import BasePage, { generateMetadata as baseGenerateMetadata } from '@/app/(public)/faq/page';
import { setPhysicalLocale } from '../../locale-context';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props) {
  setPhysicalLocale((await params).locale);
  return baseGenerateMetadata();
}

export default async function LocalizedFaqPage({ params }: Props) {
  setPhysicalLocale((await params).locale);
  return <BasePage />;
}
