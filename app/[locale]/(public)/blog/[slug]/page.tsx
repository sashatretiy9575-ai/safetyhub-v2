import BasePage, {
  generateMetadata as baseGenerateMetadata,
} from '@/app/(public)/blog/[slug]/page';
import { isAppLocale } from '@/i18n/config';
import { getArticleSlugs } from '@/lib/content/articles';
import { setPhysicalLocale } from '../../../locale-context';

type Props = { params: Promise<{ locale: string; slug: string }> };

// Overrides `dynamicParams = false` from app/[locale]/layout.tsx. That setting
// is right for the fixed set of locales; applied to content slugs it meant
// anything published after the last build could never be reached.
export const dynamicParams = true;

export async function generateStaticParams({ params }: { params: { locale: string } }) {
  // The Russian slug list used to be re-exported here, so a localization whose
  // slug differs from the Russian one was never generated — and under
  // dynamicParams = false that meant a permanent 404.
  if (!isAppLocale(params.locale) || params.locale === 'ru') return [];
  return (await getArticleSlugs(params.locale)).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props) {
  const { locale, slug } = await params;
  setPhysicalLocale(locale);
  return baseGenerateMetadata({ params: Promise.resolve({ slug }) });
}

export default async function LocalizedBlogArticlePage({ params }: Props) {
  const { locale, slug } = await params;
  setPhysicalLocale(locale);
  return <BasePage params={Promise.resolve({ slug })} />;
}
