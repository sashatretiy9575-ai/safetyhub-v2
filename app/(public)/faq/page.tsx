import { FaqAccordion } from '@/components/marketing/faq-accordion';
import { ContactCta } from '@/components/marketing/contact-cta';
import { buildMetadata } from '@/lib/seo';
import { getLocale, getTranslations } from 'next-intl/server';

export async function generateMetadata() {
  const t = await getTranslations('Faq');
  return buildMetadata({
    title: t('metadataTitle'),
    description: t('metadataDescription'),
    path: '/faq',
    locale: await getLocale(),
  });
}

export default function FaqPage() {
  return (
    <>
      <FaqAccordion headingLevel={1} />
      <ContactCta />
    </>
  );
}
