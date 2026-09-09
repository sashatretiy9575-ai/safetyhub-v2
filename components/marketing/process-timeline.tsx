import { BookOpenText, CheckCircle, ListChecks } from '@phosphor-icons/react/dist/ssr';
import { SectionHeading } from '@/components/marketing/_shared/section-heading';
import { Container } from '@/components/ui/container';
import { MarketingSlider } from '@/components/ui/marketing-slider';
import { QUIZ_POLICY } from '@/lib/constants';
import { useTranslations } from 'next-intl';

export function ProcessTimeline() {
  const t = useTranslations('Home.process');
  const steps = [
    { icon: BookOpenText, title: t('chooseTitle'), text: t('chooseText') },
    { icon: ListChecks, title: t('learnTitle'), text: t('learnText', { count: QUIZ_POLICY.questionCount }) },
    { icon: CheckCircle, title: t('resultTitle'), text: t('resultText') },
  ] as const;
  return (
    <section
      id="process"
      aria-labelledby="process-heading"
      className="relative isolate overflow-hidden py-10 sm:py-14 lg:py-16"
    >
      {/* A painted wash replaces the former 44 KB texture: the image was drawn at
          0.08 opacity under an 82% surface fill, so nothing of it was visible. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 bg-[radial-gradient(120%_100%_at_50%_0%,var(--color-primary-soft),transparent_70%)]"
      />

      <Container size="wide">
        <SectionHeading
          id="process-heading"
          eyebrow={t('eyebrow')}
          title={t('title')}
          description={t('description')}
        />

        <MarketingSlider label={t('slider')} itemLabel={t('item')} className="mt-7 sm:mt-10">
          {steps.map(({ icon: Icon, title, text }, index) => (
            <article
              key={title}
              className="relative flex h-full min-h-[12.5rem] flex-col overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)]/72 p-5 shadow-[0_16px_40px_-28px_rgba(15,23,18,0.28)] backdrop-blur-xl min-[1200px]:min-h-[12rem] min-[1200px]:p-6"
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-1 bg-[var(--color-primary)]/65"
              />
              <div className="flex items-start justify-between gap-4">
                <span className="grid size-12 place-items-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text)]">
                  <Icon size={24} weight="duotone" aria-hidden="true" />
                </span>
                <span className="text-2xl font-semibold text-[var(--color-border-strong)] tabular-nums">
                  {String(index + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 className="mt-6 text-[17px] leading-[1.3] font-bold sm:text-lg">{title}</h3>
              <p className="mt-2 line-clamp-3 text-sm leading-5 text-[var(--color-text-muted)]">
                {text}
              </p>
            </article>
          ))}
        </MarketingSlider>
      </Container>
    </section>
  );
}
