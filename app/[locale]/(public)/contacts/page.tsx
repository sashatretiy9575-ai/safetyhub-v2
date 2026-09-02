import BasePage, { generateMetadata as baseGenerateMetadata } from '@/app/(public)/contacts/page';
import { setPhysicalLocale } from '../../locale-context';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props) {
  setPhysicalLocale((await params).locale);
  return baseGenerateMetadata();
}

export default async function LocalizedContactsPage({ params }: Props) {
  setPhysicalLocale((await params).locale);
  return <BasePage />;
}
