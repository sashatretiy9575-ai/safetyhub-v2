import BasePage, { generateMetadata as baseGenerateMetadata } from '@/app/(public)/topics/page';
import { setPhysicalLocale } from '../../locale-context';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props) {
  setPhysicalLocale((await params).locale);
  return baseGenerateMetadata();
}

export default async function LocalizedTopicsPage({ params }: Props) {
  setPhysicalLocale((await params).locale);
  return <BasePage />;
}
