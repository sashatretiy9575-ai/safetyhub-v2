import {
  BookOpenText,
  Clock,
  DeviceMobile,
  ListChecks,
} from '@phosphor-icons/react/dist/ssr';
import { useTranslations } from 'next-intl';

export function ResultsNumbers() {
  const t = useTranslations('Home.format');
  const facts = [
    { icon: BookOpenText, value: '3', label: t('directions'), note: t('directionsNote') },
    { icon: ListChecks, value: '10', label: t('questions'), note: t('questionsNote') },
    { icon: Clock, value: '24/7', label: t('access'), note: t('accessNote') },
    { icon: DeviceMobile, value: 'PWA', label: t('phone'), note: t('phoneNote') },
  ] as const;
  return (
    <section aria-labelledby="format-heading" className="relative overflow-hidden bg-[#101412] py-10 text-white [contain-intrinsic-size:auto_520px] [content-visibility:auto] md:py-16 dark:bg-[#0a0d0b]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'radial-gradient(60vw 50vw at 80% -10%, rgba(31,159,74,0.4), transparent 60%), radial-gradient(60vw 50vw at -10% 100%, rgba(245,158,11,0.16), transparent 60%)',
        }}
      />
      <div className="relative z-10 mx-auto w-full max-w-[1280px] px-4 md:px-6 xl:px-8">
        <div className="max-w-2xl">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-primary)]">
            {t('eyebrow')}
          </p>
          <h2 id="format-heading" className="mt-2 text-balance text-2xl font-black tracking-tight md:text-4xl">
            {t('title')}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-white/70">
            {t('description')}
          </p>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-2.5 md:mt-8 md:grid-cols-4 md:gap-4">
          {facts.map(({ icon: Icon, value, label, note }) => (
            <article
              key={label}
              className="rounded-2xl border border-white/15 bg-white/[0.06] p-3 backdrop-blur-sm md:p-5"
            >
              <Icon size={22} weight="duotone" className="text-[var(--color-primary)]" aria-hidden="true" />
              <p className="mt-3 text-xl font-black tracking-tight tabular-nums md:text-3xl">{value}</p>
              <h3 className="mt-1 text-[11px] font-bold uppercase tracking-wider md:text-xs">{label}</h3>
              <p className="mt-2 hidden text-xs leading-relaxed text-white/65 sm:block">{note}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
