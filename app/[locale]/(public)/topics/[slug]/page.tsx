import BasePage, {
  generateMetadata as baseGenerateMetadata,
  generateStaticParams,
} from '@/app/(public)/topics/[slug]/page';
import { setPhysicalLocale } from '../../../locale-context';

export { generateStaticParams };

type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale, slug } = await params;
  setPhysicalLocale(locale);
  return baseGenerateMetadata({ params: Promise.resolve({ slug }) });
}

export default async function LocalizedTopicPage({ params }: Props) {
  const { locale, slug } = await params;
  setPhysicalLocale(locale);
  return <BasePage params={Promise.resolve({ slug })} />;
}
