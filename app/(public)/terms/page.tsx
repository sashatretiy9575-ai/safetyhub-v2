import { notFound } from 'next/navigation';
import { TermsPolicyV22 } from '@/components/legal/terms-policy-v2-2';
import { LegalContacts } from '@/components/legal/legal-contacts';
import { Container } from '@/components/ui/container';
import { PageHeader } from '@/components/ui/page-header';
import {
  formatLegalDate,
  PRIVACY_POLICY_V1_1,
  resolveLegalDocumentVersion,
  TERMS_POLICY,
} from '@/lib/legal';
import { buildMetadata } from '@/lib/seo';

export const metadata = buildMetadata({
  title: 'Условия использования',
  description: 'Условия использования платформы и получения сертификатов SafetyHub.',
  path: '/terms',
});

type TermsPageProps = {
  searchParams: Promise<{ version?: string | string[] }>;
};

const linkClass =
  'font-semibold text-[var(--color-primary)] underline underline-offset-2 hover:no-underline';

export default async function TermsPage({ searchParams }: TermsPageProps) {
  const requested = (await searchParams).version;
  const requestedVersion = Array.isArray(requested) ? requested[0] : requested;
  const policy = resolveLegalDocumentVersion('terms', requestedVersion);
  if (!policy) notFound();
  if (policy.bodyRevision === 'terms-2.2') return <TermsPolicyV22 policy={policy} />;
  if (policy.bodyRevision !== 'terms-2.1') notFound();

  const effectiveDate = formatLegalDate(policy.effectiveDate);

  return (
    <>
      <PageHeader
        title="Условия использования и сертификации"
        eyebrow="Документы"
        variant="compact"
        className="[&_h1]:hyphens-auto"
      />
      <article
        className="py-10 md:py-14"
        data-terms-version={policy.version}
        data-body-revision={policy.bodyRevision}
        data-effective-date={policy.effectiveDate}
      >
        <Container
          size="content"
          className="max-w-[52rem] space-y-8 text-[15px] leading-7 text-[var(--color-text-muted)] md:text-base"
        >
          <header
            id="document-version"
            className="scroll-mt-24 space-y-3 border-y border-[var(--color-border)] py-5"
          >
            <p className="font-semibold text-[var(--color-text)]">
              Версия {policy.version}. Действует с {effectiveDate}
            </p>
            <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
              {policy.version === TERMS_POLICY.version ? 'Текущая редакция' : 'Архивная редакция'}
            </p>
          </header>

          <section className="space-y-3" aria-labelledby="terms-acceptance">
            <h2 id="terms-acceptance" className="text-xl font-semibold text-[var(--color-text)]">
              Принятие и предмет условий
            </h2>
            <p>
              Эти условия регулируют использование сайта и PWA SafetyHub.kz, материалов, аккаунта,
              тестов, сертификатов и функций их проверки. Создавая аккаунт или явно принимая текущую
              версию в профиле, пользователь подтверждает, что прочитал условия и связанную Политику
              конфиденциальности версии {PRIVACY_POLICY_V1_1.version}.
            </p>
            <p>
              Если пользователь не согласен, он не должен регистрироваться или продолжать работу с
              закрытыми функциями. Текущая реализация не содержит оплаты; при появлении платных
              услуг цена, возвраты и отдельные коммерческие условия должны быть опубликованы до
              оплаты.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="terms-account">
            <h2 id="terms-account" className="text-xl font-semibold text-[var(--color-text)]">
              Аккаунт и подтверждение данных
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>Пользователь указывает действующий email и защищает единственный пароль.</li>
              <li>
                Вход выполняется без MFA; передавать аккаунт или ссылку восстановления нельзя.
              </li>
              <li>
                Перед первым тестом обязательны имя, фамилия, должность, компания и собственная
                актуальная фотография. Использовать фотографию другого человека запрещено.
              </li>
              <li>
                Отображаемый профиль не заменяет подтверждённые данные сертификата. Имя, должность и
                организация для сертификата проходят отдельную проверку и сохраняются как версия.
              </li>
              <li>
                При подозрении на компрометацию, злоупотребление или нарушение условий доступ может
                быть временно ограничен с сохранением предусмотренных законом способов обращения.
              </li>
            </ul>
          </section>

          <section className="space-y-3" aria-labelledby="terms-learning">
            <h2 id="terms-learning" className="text-xl font-semibold text-[var(--color-text)]">
              Обучение, тесты и попытки
            </h2>
            <p>
              Для успешного результата нужно правильно ответить не менее чем на 7 вопроса из 10, то
              есть набрать 70%. Ответы, время, статус и результат попытки фиксируются. Для каждого
              курса в интерфейсе показывается один лучший результат. При равном балле используется
              более свежая завершённая сдача. Технический лимит — не более шести начатых попыток
              одной версии теста за любые последние 30 суток; счётчик не показывается, а при
              блокировке сообщается дата следующей доступности.
            </p>
            <p>
              Запрещено использовать ботов, извлекать или распространять ключи ответов, вмешиваться
              в работу сервиса, обходить ограничения либо проходить тест за другого человека. Ошибки
              в материале следует направлять через{' '}
              <a className={linkClass} href="#legal-contacts">
                контакты по документу
              </a>
              .
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="terms-certificates">
            <h2 id="terms-certificates" className="text-xl font-semibold text-[var(--color-text)]">
              Сертификаты и их проверка
            </h2>
            <p>
              Электронный сертификат подтверждает проходной лучший результат конкретной версии
              онлайн-теста для подтверждённых данных пользователя. Первую выдачу выполняет
              администратор явно. При строго более высоком результате сертификат автоматически
              заменяется новым; исправление подтверждённых данных также может вызвать перевыпуск.
              Администратор вправе отозвать документ с указанием причины. QR показывает статус
              «Действует», «Отозван» или «Документ не найден».
            </p>
            <p>
              PDF и ZIP создаются только при скачивании и не хранятся постоянно в базе или Storage.
              Администратор может передать уполномоченному представителю компании общий отчёт и
              сертификаты её участников. Пользователь скачивает только собственный действующий PDF.
            </p>
            <p>
              Сертификат сам по себе не объявляется государственной лицензией, разрешением на
              опасные работы или заменой обязательного обучения, инструктажа, медосмотра либо
              аттестации работодателя. Применимость документа к конкретной отрасли и нормативному
              требованию должен отдельно подтвердить работодатель или компетентный специалист.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="terms-content">
            <h2 id="terms-content" className="text-xl font-semibold text-[var(--color-text)]">
              Материалы и допустимое использование
            </h2>
            <p>
              Материалы предназначены для информационного обучения. Их можно читать и использовать
              для личной подготовки; массовое копирование, перепродажа, удаление обозначений
              авторства, вредоносное сканирование и создание ложных сертификатов запрещены.
            </p>
            <p>
              Нормативные сведения могут меняться. Дата проверки и источники материала, когда они
              указаны, помогают оценить актуальность, но не заменяют официальную редакцию акта и
              профессиональную консультацию для конкретной производственной ситуации.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="terms-availability">
            <h2 id="terms-availability" className="text-xl font-semibold text-[var(--color-text)]">
              Доступность и ответственность
            </h2>
            <p>
              Сервис зависит от Supabase, Vercel, сети пользователя и, при включении, Cloudflare
              Turnstile. Оператор стремится поддерживать работоспособность и безопасность, но не
              обещает непрерывную доступность или отсутствие всех ошибок. Плановые изменения и
              экстренные защитные ограничения возможны.
            </p>
            <p>
              Ничто в условиях не ограничивает права пользователя и ответственность оператора там,
              где такое ограничение запрещено законом. Объём ответственности и порядок претензий
              должны быть окончательно проверены местным юристом после заполнения реквизитов
              оператора.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="terms-termination">
            <h2 id="terms-termination" className="text-xl font-semibold text-[var(--color-text)]">
              Прекращение использования и данные
            </h2>
            <p>
              Пользователь может прекратить использование и безвозвратно удалить аккаунт. При этом
              удаляются профиль, фотография, попытки, сертификаты и связанный аудит, а QR-проверка
              прежнего документа прекращается. Уже скачанный внешний PDF физически отозвать с
              устройства нельзя. Категории, поставщики и порядок удаления описаны в{' '}
              <a className={linkClass} href={`/privacy?version=${PRIVACY_POLICY_V1_1.version}`}>
                Политике конфиденциальности версии {PRIVACY_POLICY_V1_1.version}
              </a>
              .
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="terms-changes">
            <h2 id="terms-changes" className="text-xl font-semibold text-[var(--color-text)]">
              Изменения и связь
            </h2>
            <p>
              Существенные изменения получают новый номер и дату. Принятая версия остаётся доступной
              по versioned-ссылке в профиле, а для новой версии интерфейс запрашивает отдельное
              принятие. Вопросы и претензии направляйте через{' '}
              <a className={linkClass} href="#legal-contacts">
                контакты по документу
              </a>
              .
            </p>
          </section>

          <LegalContacts />
        </Container>
      </article>
    </>
  );
}
