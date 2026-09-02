import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LegalContacts } from '@/components/legal/legal-contacts';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import { Container } from '@/components/ui/container';
import { PageHeader } from '@/components/ui/page-header';
import { getStaticLegalDocument } from '@/lib/content/legal-documents';
import { DEFAULT_LOCALE } from '@/i18n/config';
import {
  formatLegalDate,
  LEGAL_REFERENCE_LINKS,
  PRIVACY_POLICY,
  type LegalDocumentVersion,
} from '@/lib/legal';
import { buildMetadata } from '@/lib/seo';

export const revalidate = 300;

export async function generateMetadata() {
  const t = await getTranslations('LegalFlow');
  return buildMetadata({
    title: t('privacy'),
    description: t('privacyMetadataDescription'),
    path: '/privacy',
    locale: DEFAULT_LOCALE,
  });
}

const externalLinkClass =
  'font-semibold text-[var(--color-primary)] underline underline-offset-2 hover:no-underline';

/** Immutable renderer for the only pre-structured Russian privacy copy. */
export function PrivacyPolicyV11({ policy }: { policy: LegalDocumentVersion }) {
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
              Политика относится к сайту и PWA SafetyHub.kz, аккаунту, тестам, сертификатам и
              административным функциям. Обработка предназначена для регистрации, предоставления
              обучения и тестирования, выпуска и проверки сертификатов, поддержки, защиты аккаунтов
              и выполнения обязательных требований.
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
                сессии и auth/PKCE-cookie. Пароль обрабатывает Supabase Auth; приложение не
                показывает и не сохраняет его в открытом виде.
              </li>
              <li>
                Профиль и идентификация: имя, фамилия, должность, организация, квадратная фотография
                профиля, версия, статус и время административной проверки.
              </li>
              <li>
                Обучение: версия темы и теста, завершённые ответы, время и статус попытки, лучший
                результат, а также метаданные выданного, заменённого или отозванного сертификата.
              </li>
              <li>
                Согласия: тип документа, его версия, дата принятия и источник действия
                («регистрация» или «профиль»).
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

          <section className="space-y-3" aria-labelledby="privacy-storage">
            <h2 id="privacy-storage" className="text-xl font-semibold text-[var(--color-text)]">
              Cookie и локальное хранилище
            </h2>
            <p>
              Необходимые cookie используются для входа, обновления сессии, PKCE-восстановления и
              защиты закрытых маршрутов. В localStorage могут сохраняться тема оформления, скрытие
              подсказки установки PWA, незавершённые ответы теста и, для администратора, локальный
              черновик редактора. Эти данные остаются в выбранном браузере, пока пользователь или
              приложение их не удалит. Рекламные cookie и поведенческая реклама в текущей версии
              приложения не используются.
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
                приватный Storage, краткоживущие подписанные ссылки и доставка auth-писем. См.{' '}
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
              Данные аккаунта, профиль, фотография, завершённые попытки, лучший результат,
              сертификаты, согласия и связанный административный аудит хранятся, пока существует
              аккаунт. Сырые попытки и аудит не имеют автоматического срока удаления в этот период.
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
              Чтобы отправить запрос, используйте{' '}
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
              Приложение использует вход по email и паролю без MFA, разграничение ролей и
              полномочий, RLS, ограничение частоты операций, проверку источника административных
              запросов, защитные browser headers, аудит критических действий и шифрованный
              транспорт. Компрометация единственного пароля может дать доступ к аккаунту до смены
              пароля или отзыва сессии. Ни одна мера не исключает риск полностью.
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

/**
 * The unversioned public URL is deliberately a local immutable read. Historical
 * versions have physical `/privacy/:version` routes, so neither a session cookie
 * nor a query string can make this CDN response viewer-specific.
 */
export default function PrivacyPage() {
  const document = getStaticLegalDocument('privacy', PRIVACY_POLICY.version, DEFAULT_LOCALE);
  if (!document) notFound();
  return <LocalizedLegalDocumentView document={document} />;
}
