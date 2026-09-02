import Image from 'next/image';
import { DeviceMobile, ListChecks, UserCircle } from '@phosphor-icons/react/dist/ssr';
import { SectionHeading } from '@/components/marketing/_shared/section-heading';
import { SectionShell } from '@/components/marketing/_shared/section-shell';
import { MarketingSlider } from '@/components/ui/marketing-slider';
import { useTranslations } from 'next-intl';

export function PartnersStrip() {
  const t = useTranslations('Home.benefits');
  const benefits = [
    { icon: DeviceMobile, image: '/images/generated/benefit-mobile-v2.webp', title: t('mobileTitle'), text: t('mobileText') },
    { icon: ListChecks, image: '/images/generated/benefit-quiz-v2.webp', title: t('quizTitle'), text: t('quizText') },
    { icon: UserCircle, image: '/images/generated/benefit-results-v2.webp', title: t('resultsTitle'), text: t('resultsText') },
  ] as const;
  return (
    <SectionShell
      id="benefits"
      aria-labelledby="benefits-heading"
      className="bg-[var(--color-surface-muted)]/28 py-10 sm:py-14 lg:py-16"
    >
      <SectionHeading
        id="benefits-heading"
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
      />

      <MarketingSlider
        label={t('slider')}
        itemLabel={t('item')}
        className="mt-7 sm:mt-10"
      >
        {benefits.map(({ icon: Icon, image, title, text }, index) => (
          <article
            key={title}
            className="group flex h-full min-h-[16rem] flex-col overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)]/78 shadow-[0_16px_40px_-28px_rgba(15,23,18,0.28)] backdrop-blur-xl"
          >
            <div className="relative h-36 shrink-0 overflow-hidden bg-[var(--color-surface-muted)] sm:h-[9.5rem]">
              <Image
                src={image}
                alt=""
                fill
                sizes="(max-width: 599px) 82vw, (max-width: 1199px) 46vw, 33vw"
                quality={78}
                loading="lazy"
                className="object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.025]"
              />
              <span className="absolute top-3 left-3 grid size-10 place-items-center rounded-[14px] border border-white/55 bg-white/82 text-[#176b43] shadow-sm backdrop-blur-xl">
                <Icon size={21} weight="duotone" aria-hidden="true" />
              </span>
              <span className="absolute top-3 right-3 rounded-full border border-white/45 bg-white/68 px-2.5 py-1 text-xs font-black tracking-[0.1em] text-slate-700 tabular-nums backdrop-blur-xl">
                {String(index + 1).padStart(2, '0')}
              </span>
            </div>

            <div className="flex min-h-0 flex-1 flex-col p-5">
              <h3 className="line-clamp-2 text-[16px] leading-[1.3] font-bold sm:text-[17px]">
                {title}
              </h3>
              <p className="mt-2.5 line-clamp-2 text-[13.5px] leading-5 text-[var(--color-text-muted)] sm:text-sm">
                {text}
              </p>
            </div>
          </article>
        ))}
      </MarketingSlider>
    </SectionShell>
  );
}
