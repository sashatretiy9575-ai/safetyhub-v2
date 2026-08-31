import { ArrowRight, CheckCircle, Quotes } from '@phosphor-icons/react/dist/ssr';
import { Carousel } from '@/components/ui/carousel';

const CASES = [
  {
    context: 'Новый сотрудник',
    problem: 'Нужно быстро освежить правила перед первым рабочим днём.',
    action: 'Материал проходит с телефона небольшими смысловыми блоками.',
    outcome: 'Результат теста сразу остаётся в аккаунте.',
  },
  {
    context: 'Специалист по охране труда',
    problem: 'Важно видеть, какие темы уже пройдены участниками.',
    action: 'Лучший результат по каждому курсу собран в одном профиле без бумажных записей.',
    outcome: 'К аттестациям и сертификатам можно вернуться в любой момент.',
  },
  {
    context: 'Руководитель команды',
    problem: 'Сотрудникам неудобно проходить длинные проверки на телефоне.',
    action: 'Каждый тест ограничен десятью понятными вопросами.',
    outcome: 'Проверка не превращается в длинную мобильную анкету.',
  },
] as const;

export function Testimonials() {
  return (
    <section
      aria-labelledby="cases-heading"
      className="overflow-hidden bg-[var(--color-surface-muted)]/30 py-10 [contain-intrinsic-size:auto_610px] [content-visibility:auto] sm:py-14 lg:py-16"
    >
      <div className="mx-auto w-full max-w-[1280px] px-4 md:px-6 xl:px-8">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(20rem,0.6fr)] lg:items-end lg:gap-14">
          <div>
            <p className="text-[11px] font-bold tracking-[0.14em] text-[var(--color-text-subtle)] uppercase sm:text-xs">
              Сценарии использования
            </p>
            <h2
              id="cases-heading"
              className="mt-2.5 text-[24px] leading-[1.2] font-bold tracking-[-0.03em] text-balance sm:text-[30px] lg:text-[38px]"
            >
              Как используют SafetyHub
            </h2>
          </div>
          <p className="max-w-xl border-l-2 border-[var(--color-primary)]/45 pl-4 text-[14px] leading-[1.6] text-[var(--color-text-muted)] sm:text-[15px] sm:leading-6 lg:justify-self-end">
            Обезличенные типовые сценарии без названий компаний, лиц и рекламных цифр.
          </p>
        </div>

        <Carousel
          label="Сценарии использования"
          className="mt-7 md:mt-11"
          gridClassName="md:grid-cols-3"
        >
          {CASES.map((item) => (
            <article
              key={item.context}
              className="flex h-full flex-col rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)]/72 p-4 shadow-[0_16px_40px_-28px_rgba(15,23,18,0.28)] backdrop-blur-xl md:p-6"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1.5 text-[10px] font-bold tracking-wider text-[var(--color-text-muted)] uppercase">
                  Типовой сценарий
                </span>
                <Quotes
                  size={26}
                  weight="fill"
                  className="text-[var(--color-border-strong)]"
                  aria-hidden="true"
                />
              </div>
              <h3 className="mt-4 text-lg font-bold">{item.context}</h3>

              <div className="mt-4 space-y-3 text-sm">
                <dl>
                  <dt className="text-[10px] font-black tracking-widest text-[var(--color-text-subtle)] uppercase">
                    Задача
                  </dt>
                  <dd className="mt-1 leading-relaxed text-[var(--color-text-muted)]">
                    {item.problem}
                  </dd>
                </dl>
                <div className="flex gap-2 border-t border-[var(--color-border)] pt-3">
                  <ArrowRight
                    size={18}
                    weight="bold"
                    className="mt-0.5 shrink-0 text-[var(--color-text-subtle)]"
                    aria-hidden="true"
                  />
                  <dl>
                    <dt className="text-[10px] font-black tracking-widest text-[var(--color-text-subtle)] uppercase">
                      Действие
                    </dt>
                    <dd className="mt-1 leading-relaxed text-[var(--color-text-muted)]">
                      {item.action}
                    </dd>
                  </dl>
                </div>
                <div className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-muted)]/75 p-3">
                  <CheckCircle
                    size={18}
                    weight="fill"
                    className="mt-0.5 shrink-0 text-[var(--color-primary)]"
                    aria-hidden="true"
                  />
                  <dl>
                    <dt className="text-[10px] font-black tracking-widest text-[var(--color-text-subtle)] uppercase">
                      Результат
                    </dt>
                    <dd className="mt-1 leading-relaxed text-[var(--color-text-muted)]">
                      {item.outcome}
                    </dd>
                  </dl>
                </div>
              </div>
            </article>
          ))}
        </Carousel>
      </div>
    </section>
  );
}
