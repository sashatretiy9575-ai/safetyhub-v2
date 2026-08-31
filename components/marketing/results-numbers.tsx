import {
  BookOpenText,
  Clock,
  DeviceMobile,
  ListChecks,
} from '@phosphor-icons/react/dist/ssr';

const FORMAT_FACTS = [
  {
    icon: BookOpenText,
    value: '3',
    label: 'направления',
    note: 'Ключевые темы безопасности',
  },
  {
    icon: ListChecks,
    value: '5',
    label: 'вопросов',
    note: 'В каждом проверочном тесте',
  },
  {
    icon: Clock,
    value: '24/7',
    label: 'доступ',
    note: 'Учитесь в удобное время',
  },
  {
    icon: DeviceMobile,
    value: 'PWA',
    label: 'на телефоне',
    note: 'Можно установить как приложение',
  },
] as const;

export function ResultsNumbers() {
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
            Формат платформы
          </p>
          <h2 id="format-heading" className="mt-2 text-balance text-2xl font-black tracking-tight md:text-4xl">
            Только проверяемые возможности
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-white/70">
            Без рекламных процентов и неподтверждённых обещаний.
          </p>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-2.5 md:mt-8 md:grid-cols-4 md:gap-4">
          {FORMAT_FACTS.map(({ icon: Icon, value, label, note }) => (
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
