import { FaqAccordion } from '@/components/marketing/faq-accordion';
import { ContactCta } from '@/components/marketing/contact-cta';
import { buildMetadata } from '@/lib/seo';

export const metadata = buildMetadata({
  title: 'Ответы перед началом обучения',
  description: 'Ответы на частые вопросы о курсах, тестах и аккаунте SafetyHub.',
  path: '/faq',
});

export default function FaqPage() {
  return (
    <>
      <FaqAccordion headingLevel={1} />
      <ContactCta />
    </>
  );
}
