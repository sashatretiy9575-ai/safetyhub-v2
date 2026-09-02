import { DeviceMobile, Gauge, ShieldCheck } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { ROUTES } from '@/lib/constants';
import { useLocale, useTranslations } from 'next-intl';
import { localizePathname } from '@/i18n/config';

export function BenefitGrid() {
  const locale = useLocale();
  const t = useTranslations('Home.extraBenefits');
  const benefits = [
    { icon: Gauge, title: t('shortTitle'), description: t('shortDescription') },
    { icon: DeviceMobile, title: t('mobileTitle'), description: t('mobileDescription') },
    { icon: ShieldCheck, title: t('controlTitle'), description: t('controlDescription') },
  ] as const;
  return (
    <section
      id="benefits"
      aria-labelledby="benefits-heading"
      className="bg-[var(--color-surface)] py-10 [contain-intrinsic-size:auto_600px] [content-visibility:auto] md:py-20"
    >
      <div className="mx-auto w-full max-w-[1280px] px-4 md:px-6 xl:px-8">
        <div className="grid gap-3 md:grid-cols-[1.15fr_1fr] md:items-end md:gap-8">
          <div>
            <p className="text-xs font-bold tracking-widest text-[var(--color-primary)] uppercase">
              {t('eyebrow')}
            </p>
            <h2
              id="benefits-heading"
              className="mt-2 text-2xl font-black tracking-tight text-balance md:text-4xl"
            >
              {t('title')}
            </h2>
          </div>
          <p className="text-sm leading-relaxed text-[var(--color-text-muted)] md:text-right">
            {t('description')}
          </p>
        </div>

        <div className="mt-6 grid gap-3 md:mt-10 md:grid-cols-3 md:gap-5">
          {benefits.map(({ icon: Icon, title, description }) => (
            <article
              key={title}
              className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-soft)] md:p-6"
            >
              <span className="grid size-11 place-items-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <Icon size={23} weight="duotone" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-lg font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-muted)]">
                {description}
              </p>
            </article>
          ))}
        </div>

        <div className="mt-5 flex flex-col gap-3 rounded-2xl bg-[var(--color-footer)] p-4 text-[var(--color-footer-foreground)] sm:flex-row sm:items-center sm:justify-between md:mt-8 md:p-6">
          <p className="text-base font-bold">{t('cta')}</p>
          <Link
            href={localizePathname(ROUTES.topics, locale)}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-[var(--color-primary)] px-6 text-sm font-bold text-white transition hover:bg-[var(--color-primary-hover)]"
          >
            {t('choose')}
          </Link>
        </div>
      </div>
    </section>
  );
}
