import { FaqAccordion, getFaqData } from '@/components/marketing/faq-accordion';
import { ContactCta } from '@/components/marketing/contact-cta';
import { JsonLd } from '@/components/shared/json-ld';
import { buildMetadata, faqJsonLd } from '@/lib/seo';
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

export default async function FaqPage() {
  const faqData = await getFaqData();
  return (
    <>
      <JsonLd data={faqJsonLd(faqData)} />
      <FaqAccordion headingLevel={1} />
      <ContactCta />
    </>
  );
}
