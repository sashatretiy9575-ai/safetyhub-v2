import { Clock, MapPin } from '@phosphor-icons/react/dist/ssr';
import { ContactActions } from '@/components/shared/contact-actions';
import { Container } from '@/components/ui/container';
import { PageHeader } from '@/components/ui/page-header';
import { CONTACT_DETAILS } from '@/lib/constants';
import { getSiteContacts } from '@/lib/site-contacts';
import { buildMetadata } from '@/lib/seo';

export const metadata = buildMetadata({
  title: 'Связаться с SafetyHub',
  description: 'Контакты SafetyHub: телефон, WhatsApp, город и часы работы.',
  path: '/contacts',
});

export default async function ContactsPage() {
  const contacts = await getSiteContacts();
  const details = [
    {
      icon: MapPin,
      label: 'Город',
      value: CONTACT_DETAILS.city,
      href: 'https://www.google.com/maps/search/?api=1&query=Almaty%2C%20Kazakhstan',
    },
    { icon: Clock, label: 'Часы работы', value: CONTACT_DETAILS.hours },
  ] as const;
  return (
    <>
      <PageHeader
        title="Связаться с SafetyHub"
        description="Подскажем программу и ответим на вопросы об обучении."
        eyebrow="Контакты"
        variant="contact"
        className="[&>div:last-child>p]:text-[15px] sm:[&>div:last-child>p]:text-base"
      />

      <section aria-labelledby="contact-options-heading" className="py-8 sm:py-11 lg:py-14">
        <Container size="wide">
          <div className="grid gap-7 lg:grid-cols-[minmax(0,0.76fr)_minmax(25rem,1.24fr)] lg:items-start lg:gap-10">
            <div>
              <h2
                id="contact-options-heading"
                className="text-[20px] leading-tight font-bold tracking-[-0.02em] sm:text-2xl"
              >
                Удобный способ связи
              </h2>
              <p className="mt-2 max-w-lg text-sm leading-5 text-[var(--color-text-muted)] sm:text-[15px] sm:leading-6">
                Для быстрого ответа укажите тему курса и примерное количество участников.
              </p>
              <div className="mt-5 max-w-xl">
                <ContactActions contacts={contacts} />
              </div>
            </div>

            <dl className="grid overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)]/76 shadow-[0_16px_40px_-28px_rgba(15,23,18,0.28)] backdrop-blur-xl sm:grid-cols-2">
              {details.map(({ icon: Icon, label, value, ...item }, index) => (
                <div
                  key={label}
                  className={`min-w-0 p-4 sm:p-5 ${
                    index === 0
                      ? 'border-b border-[var(--color-border)] sm:border-r sm:border-b-0'
                      : ''
                  }`}
                >
                  <dt className="text-xs font-bold tracking-[0.12em] text-[var(--color-text-subtle)] uppercase">
                    <span className="grid size-9 place-items-center rounded-[13px] border border-[var(--color-primary)]/20 bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                      <Icon size={19} weight="duotone" aria-hidden="true" />
                    </span>
                    <span className="mt-3 block sm:mt-4">{label}</span>
                  </dt>
                  <dd className="mt-1 min-w-0 text-[15px] leading-6 font-semibold break-words">
                    {'href' in item ? (
                      <a
                        href={item.href}
                        target={item.href.startsWith('http') ? '_blank' : undefined}
                        rel={item.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                        className="transition hover:text-[var(--color-primary)]"
                      >
                        {value}
                      </a>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Container>
      </section>
    </>
  );
}
