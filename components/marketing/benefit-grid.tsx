import { DeviceMobile, Gauge, ShieldCheck } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { ROUTES } from '@/lib/constants';

const BENEFITS = [
  {
    icon: Gauge,
    title: 'Короткий путь',
    description: 'Презентация, десять вопросов и результат без перегруженных экранов.',
  },
  {
    icon: DeviceMobile,
    title: 'Удобно с телефона',
    description: 'Крупные действия, понятная навигация и поддержка узких экранов.',
  },
  {
    icon: ShieldCheck,
    title: 'Данные под контролем',
    description: 'Попытки и результаты доступны только владельцу и уполномоченным ролям.',
  },
] as const;

export function BenefitGrid() {
  return (
    <section
      id="benefits"
      aria-labelledby="benefits-heading"
      className="bg-[var(--color-surface)] py-10 [contain-intrinsic-size:auto_600px] [content-visibility:auto] md:py-20"
    >
      <div className="mx-auto w-full max-w-[1280px] px-4 md:px-6 xl:px-8">
        <div className="grid gap-3 md:grid-cols-[1.15fr_1fr] md:items-end md:gap-8">
          <div>
            <p className="text-[10px] font-bold tracking-widest text-[var(--color-primary)] uppercase">
              Преимущества
            </p>
            <h2
              id="benefits-heading"
              className="mt-2 text-2xl font-black tracking-tight text-balance md:text-4xl"
            >
              Понятно с первого экрана
            </h2>
          </div>
          <p className="text-sm leading-relaxed text-[var(--color-text-muted)] md:text-right">
            Интерфейс помогает сосредоточиться на обучении, а не на управлении платформой.
          </p>
        </div>

        <div className="mt-6 grid gap-3 md:mt-10 md:grid-cols-3 md:gap-5">
          {BENEFITS.map(({ icon: Icon, title, description }) => (
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
          <p className="text-base font-bold">Попробуйте первый тест на телефоне.</p>
          <Link
            href={ROUTES.topics}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-[var(--color-primary)] px-6 text-sm font-bold text-white transition hover:bg-[var(--color-primary-hover)]"
          >
            Выбрать тему
          </Link>
        </div>
      </div>
    </section>
  );
}
