import { LegalContacts } from '@/components/legal/legal-contacts';
import { Container } from '@/components/ui/container';
import { PageHeader } from '@/components/ui/page-header';
import { formatLegalDate, LEGAL_REFERENCE_LINKS, type LegalDocumentVersion } from '@/lib/legal';

type PrivacyPolicyV12Props = {
  policy: LegalDocumentVersion;
};

const externalLinkClass =
  'font-semibold text-[var(--color-primary)] underline underline-offset-2 hover:no-underline';

/**
 * Rendered copy for privacy-1.2. This component is deliberately versioned:
 * changing its wording requires publishing another legal-document version.
 */
export function PrivacyPolicyV12({ policy }: PrivacyPolicyV12Props) {
  const effectiveDate = formatLegalDate(policy.effectiveDate);

  return (
    <>
      <PageHeader
        title={policy.title}
        eyebrow="Документы"
        variant="compact"
        className="[&_h1]:hyphens-auto"
      />
      <article
        className="py-10 md:py-14"
        data-privacy-version={policy.version}
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
          </header>

          <section className="space-y-3" aria-labelledby="privacy-scope">
            <h2 id="privacy-scope" className="text-xl font-semibold text-[var(--color-text)]">
              Область действия и основания
            </h2>
            <p>
              Политика относится к сайту и PWA SafetyHub.kz, аккаунту, курсам, тестам, сертификатам
              и административным функциям. Данные обрабатываются, чтобы предоставить доступ к
              обучению, провести проверку профиля, выполнить тестирование, выдать и проверить
              сертификат, ответить на обращение, защитить сервис и выполнить применимые требования
              закона.
            </p>
            <p>
              Предполагаемые основания — согласие пользователя, исполнение принятых условий и
              требования закона в той мере, в которой они применимы. Их достаточность для каждого
              сценария должен подтвердить оператор при локальной юридической проверке. Общая
              нормативная отправная точка — Закон Республики Казахстан «О персональных данных и их
              защите» на{' '}
              <a
                className={externalLinkClass}
                href={LEGAL_REFERENCE_LINKS.kazakhstanPersonalData}
                target="_blank"
                rel="noreferrer"
              >
                официальном портале «Әділет»
              </a>
              .
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="privacy-data">
            <h2 id="privacy-data" className="text-xl font-semibold text-[var(--color-text)]">
              Какие данные обрабатываются
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Аккаунт и доступ: email, статус подтверждения, служебные идентификаторы аккаунта и
                сессии и auth/PKCE-cookie. Вход и подтверждение email выполняются одноразовым кодом
                из письма (email OTP). Пароль, SMS-код и номер телефона для аутентификации не
                используются.
              </li>
              <li>
                Профиль и проверка: имя, фамилия, должность, организация, контактный номер с
                выбранным кодом страны, квадратная фотография профиля, статус и время ручной
                проверки администратором. Номер нужен только как контакт для проверки и поддержки,
                не используется для входа и не передаётся в SMS-провайдера.
              </li>
              <li>
                Обучение: версия курса и теста, завершённые ответы, время и статус попытки, лучший
                результат, а также метаданные выданного, заменённого или отозванного сертификата.
              </li>
              <li>
                Согласия: тип документа, его версия, дата принятия и источник действия («профиль»).
              </li>
              <li>
                Безопасность и администрирование: причины и история привилегированных действий,
                correlation/request ID, сокращённый user-agent, а также HMAC-хэш укрупнённого
                сетевого адреса для лимитов и расследования злоупотреблений.
              </li>
              <li>
                Обращения: адрес и содержание сообщения, если пользователь сам пишет в поддержку.
              </li>
            </ul>
            <p>
              Фотография хранится как один приватный сжатый WebP-файл в Supabase Storage. Оригинал и
              промежуточный кадр не сохраняются, публичного доступа к аватару нет, распознавание
              лица и автоматическая биометрическая идентификация не выполняются. Поток камеры не
              покидает устройство: на сервер отправляется только выбранный и обработанный кадр.
            </p>
            <p>
              Публичная проверка сертификата по непредсказуемой ссылке может показать имя владельца,
              номер и статус сертификата, название теста, результат и дату выдачи. Не публикуйте
              такую ссылку, если не хотите делиться этими сведениями.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="privacy-approval">
            <h2 id="privacy-approval" className="text-xl font-semibold text-[var(--color-text)]">
              Ручная проверка профиля
            </h2>
            <p>
              После явного принятия актуальных документов пользователь заполняет профиль и
              отправляет его на ручную проверку. Обычный ориентир рассмотрения — до 24 часов с
              момента отправки; это срок ожидания, а не автоматическое одобрение и не гарантия
              доступа к курсу в конкретный момент.
            </p>
            <p>
              Пока статус «на проверке» или «отклонено», система не открывает материалы и вопросы
              курса, не позволяет начать тест и не выдаёт сертификат. Администратор видит заявку в
              служебном кабинете и принимает решение; при отклонении может быть показана причина и
              пользователь может исправить профиль и подать заявку повторно.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="privacy-storage">
            <h2 id="privacy-storage" className="text-xl font-semibold text-[var(--color-text)]">
              Cookie и локальное хранилище
            </h2>
            <p>
              Необходимые cookie используются для входа по email-коду, обновления сессии,
              PKCE-восстановления и защиты закрытых маршрутов. В localStorage могут сохраняться тема
              оформления, скрытие подсказки установки PWA, незавершённые ответы теста и, для
              администратора, локальный черновик редактора. Эти данные остаются в выбранном
              браузере, пока пользователь или приложение их не удалит. Рекламные cookie и
              поведенческая реклама в текущей версии приложения не используются.
            </p>
            <p>
              Если включён Cloudflare Turnstile, его технические данные и storage обрабатываются
              Cloudflare для проверки безопасности согласно{' '}
              <a
                className={externalLinkClass}
                href={LEGAL_REFERENCE_LINKS.cloudflareTurnstile}
                target="_blank"
                rel="noreferrer"
              >
                политике Turnstile
              </a>
              .
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="privacy-processors">
            <h2 id="privacy-processors" className="text-xl font-semibold text-[var(--color-text)]">
              Поставщики и трансграничная обработка
            </h2>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="text-[var(--color-text)]">Supabase</strong> — Auth, PostgreSQL,
                приватный Storage, краткоживущие подписанные ссылки и доставка email-кодов. См.{' '}
                <a
                  className={externalLinkClass}
                  href={LEGAL_REFERENCE_LINKS.supabaseDpa}
                  target="_blank"
                  rel="noreferrer"
                >
                  DPA
                </a>{' '}
                и{' '}
                <a
                  className={externalLinkClass}
                  href={LEGAL_REFERENCE_LINKS.supabaseRegions}
                  target="_blank"
                  rel="noreferrer"
                >
                  доступные регионы
                </a>
                .
              </li>
              <li>
                <strong className="text-[var(--color-text)]">Vercel</strong> — hosting, CDN,
                serverless-выполнение и технические логи. См.{' '}
                <a
                  className={externalLinkClass}
                  href={LEGAL_REFERENCE_LINKS.vercelPrivacy}
                  target="_blank"
                  rel="noreferrer"
                >
                  privacy notice
                </a>{' '}
                и{' '}
                <a
                  className={externalLinkClass}
                  href={LEGAL_REFERENCE_LINKS.vercelDpa}
                  target="_blank"
                  rel="noreferrer"
                >
                  DPA
                </a>
                .
              </li>
              <li>
                <strong className="text-[var(--color-text)]">Cloudflare</strong> — только
                опциональная anti-bot проверка Turnstile, когда она включена в конфигурации.
              </li>
            </ul>
            <p>
              Регион хранения и места доступа поставщиков зависят от выбранных регионов,
              deployment-настроек и их актуальных subprocessors; код не гарантирует хранение только
              в Казахстане. До production-запуска оператор должен зафиксировать фактические регионы,
              договоры и допустимый механизм трансграничной передачи.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="privacy-retention">
            <h2 id="privacy-retention" className="text-xl font-semibold text-[var(--color-text)]">
              Сроки хранения и удаление
            </h2>
            <p>
              Данные аккаунта, профиль, контактный номер, фотография, завершённые попытки, лучший
              результат, сертификаты, согласия и связанный административный аудит хранятся, пока
              существует аккаунт. Сырые попытки и аудит не имеют автоматического срока удаления в
              этот период.
            </p>
            <p>
              При окончательном удалении аккаунта приложение удаляет Auth-аккаунт, профиль,
              фотографию, ответы и попытки, лучшие результаты, подтверждённые данные, сертификаты и
              связанный аудит. Публичная QR-проверка удалённого сертификата после этого возвращает
              «Документ не найден». Уже скачанную на чужое устройство копию PDF физически удалить
              невозможно. Резервные копии поставщиков могут обновляться по их техническому циклу.
            </p>
            <p>
              PDF-сертификаты и ZIP-архивы создаются по запросу и не записываются постоянно ни в
              PostgreSQL, ни в Storage. Фотография не включается в PDF, ZIP или QR-проверку.
              Корпоративный отчёт с данными аттестации может быть передан уполномоченному
              представителю компании пользователя для подтверждения обучения.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="privacy-rights">
            <h2 id="privacy-rights" className="text-xl font-semibold text-[var(--color-text)]">
              Права и обращения
            </h2>
            <p>
              Пользователь может запросить сведения об обработке и копию данных, исправление,
              ограничение или прекращение обработки, отзыв согласия и удаление аккаунта — в объёме,
              предусмотренном применимым правом. Некоторые записи могут быть сохранены, если для
              этого есть обязательное основание; оператор должен объяснить такое решение.
            </p>
            <p>
              Чтобы отправить запрос или уточнить статус ручной проверки, используйте{' '}
              <a className={externalLinkClass} href="#legal-contacts">
                контакты по документу
              </a>
              . Для защиты аккаунта может потребоваться подтверждение личности. Если ответ не
              устраивает, пользователь вправе обратиться в компетентный орган или суд в порядке,
              установленном применимым законодательством.
            </p>
          </section>

          <section className="space-y-3" aria-labelledby="privacy-security">
            <h2 id="privacy-security" className="text-xl font-semibold text-[var(--color-text)]">
              Безопасность и изменения документа
            </h2>
            <p>
              Приложение использует вход по одноразовому коду из email, разграничение ролей и
              полномочий, RLS, ограничение частоты операций, проверку источника административных
              запросов, защитные browser headers, аудит критических действий и шифрованный
              транспорт. Код из письма нельзя передавать другим лицам; ни одна мера не исключает
              риск полностью.
            </p>
            <p>
              Новая существенная версия публикуется под новым номером и датой. Принятая версия
              остаётся доступной по versioned-ссылке в профиле; повторное согласие запрашивается,
              если текущая версия ещё не принята.
            </p>
          </section>

          <LegalContacts />
        </Container>
      </article>
    </>
  );
}
