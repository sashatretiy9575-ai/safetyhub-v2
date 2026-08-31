export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Buildings, CaretDown } from '@phosphor-icons/react/dist/ssr';
import { AuthenticationError, requireUser } from '@/features/auth/server';
import { ProfileForm } from '@/features/auth/profile-form';
import { AccountDeletion } from '@/features/profile/account-deletion';
import { AccountApprovalStatus } from '@/features/profile/account-approval-status';
import { AvatarUploader } from '@/features/profile/avatar-uploader';
import { LegalAcceptancePanel } from '@/features/profile/legal-acceptance-panel';
import {
  getProfileAvatarUrl,
  getProfileDashboard,
  type ProfileAttestation,
} from '@/features/profile/server';
import { Container } from '@/components/ui/container';
import { Card, CardContent } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataLoadFailure } from '@/components/shared/data-load-failure';
import { PwaManualInstall } from '@/components/shared/pwa-manual-install';
import { CertificateDownloadButton } from '@/features/certificates/download-button';
import { phoneInputValueFromE164 } from '@/lib/phone';
import { getSiteContacts } from '@/lib/site-contacts';

function certificateLabel(state: ProfileAttestation['certificateState']) {
  if (state === 'pending_identity') return 'Ожидает проверки';
  if (state === 'ready') return 'Готовится';
  if (state === 'issued') return 'Выдан';
  if (state === 'revoked') return 'Отозван';
  return 'Недоступен';
}

function certificateVariant(state: ProfileAttestation['certificateState']): BadgeProps['variant'] {
  if (state === 'issued') return 'success';
  if (state === 'pending_identity' || state === 'ready') return 'warning';
  if (state === 'revoked') return 'danger';
  return 'outline';
}

function resultLabel(item: ProfileAttestation) {
  if (item.resultState === 'passed')
    return item.score === null ? 'Сдан' : `${item.score}/${item.total}`;
  if (item.resultState === 'failed')
    return item.score === null ? 'Не сдан' : `${item.score}/${item.total}`;
  return 'Не начат';
}

function resultVariant(state: ProfileAttestation['resultState']): BadgeProps['variant'] {
  if (state === 'passed') return 'primary';
  if (state === 'failed') return 'danger';
  return 'outline';
}

function approvalStatus(state: 'profile_incomplete' | 'pending' | 'approved' | 'rejected') {
  if (state === 'approved') return { label: 'Данные подтверждены', variant: 'success' as const };
  if (state === 'rejected') return { label: 'Нужны уточнения', variant: 'danger' as const };
  if (state === 'pending') return { label: 'На проверке', variant: 'warning' as const };
  return { label: 'Заполните профиль', variant: 'warning' as const };
}

function NextStep({
  rows,
  needsProfileAction,
}: {
  rows: ProfileAttestation[];
  needsProfileAction: boolean;
}) {
  const current = rows.filter((item) => item.isCurrent);
  const waiting = current.find(
    (item) =>
      item.resultState === 'passed' &&
      (item.certificateState === 'pending_identity' || item.certificateState === 'ready'),
  );
  if (waiting) {
    return (
      <Card className="border-[var(--color-primary)]">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold tracking-wide text-[var(--color-primary)] uppercase">
                Следующий шаг
              </p>
              <h2 className="font-display mt-1 text-xl font-bold">
                Тест пройден — {waiting.score}/{waiting.total}
              </h2>
              <p className="mt-1 text-sm font-semibold">{waiting.courseTitle}</p>
            </div>
            <Badge variant="warning">Сертификат готовится</Badge>
          </div>
          {needsProfileAction ? (
            <div className="rounded-xl bg-[var(--color-accent-amber-soft)] p-3 text-sm">
              <strong>Нужно действие:</strong> проверьте название компании в профиле.
              <div className="mt-3">
                <Button asChild size="sm">
                  <a href="#my-data">Исправить данные</a>
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1 text-sm text-[var(--color-text-muted)]">
              <p>
                <strong className="text-[var(--color-text)]">Сейчас:</strong> данные ожидают
                проверки администратора.
              </p>
              <p>
                <strong className="text-[var(--color-text)]">Дальше:</strong> после проверки здесь
                станет доступен сертификат PDF.
              </p>
              <p>
                <strong className="text-[var(--color-text)]">
                  От вас сейчас ничего не требуется.
                </strong>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }
  const failed = current.find((item) => item.resultState === 'failed');
  if (failed) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <div>
            <p className="text-sm text-[var(--color-text-muted)]">Следующий шаг</p>
            <h2 className="font-display text-lg font-bold">
              Повторить курс «{failed.courseTitle}»
            </h2>
            <p className="text-sm">
              Результат: {failed.score}/{failed.total}
            </p>
          </div>
          <Button asChild size="sm">
            <Link href={`/topics/${failed.testSlug}`}>К курсу</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  const nextCourse = current.find((item) => item.resultState === 'not_started') ?? current[0];
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div>
          <p className="text-sm text-[var(--color-text-muted)]">Следующий шаг</p>
          <h2 className="font-display text-lg font-bold">
            {nextCourse ? `Продолжить курс «${nextCourse.courseTitle}»` : 'Выбрать курс'}
          </h2>
        </div>
        <Button asChild size="sm">
          <Link href={nextCourse ? `/topics/${nextCourse.testSlug}` : '/topics'}>
            {nextCourse ? 'К курсу' : 'Все курсы'}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function CourseRow({ item }: { item: ProfileAttestation }) {
  return (
    <article className="grid min-w-0 gap-3 border-t border-[var(--color-border)] px-3 py-3 first:border-t-0 min-[760px]:min-h-[68px] min-[760px]:grid-cols-[minmax(0,2fr)_7rem_10rem_8rem] min-[760px]:items-center min-[760px]:px-4">
      <div className="min-w-0">
        <h3 className="font-semibold break-words">{item.courseTitle}</h3>
        {!item.isCurrent ? (
          <p className="text-xs text-[var(--color-text-muted)]">Архивная версия</p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 min-[760px]:block">
        <span className="text-xs text-[var(--color-text-muted)] min-[760px]:sr-only">
          Результат
        </span>
        <Badge variant={resultVariant(item.resultState)}>{resultLabel(item)}</Badge>
      </div>
      <div className="flex items-center justify-between gap-2 min-[760px]:block">
        <span className="text-xs text-[var(--color-text-muted)] min-[760px]:sr-only">
          Сертификат
        </span>
        <Badge variant={certificateVariant(item.certificateState)}>
          {certificateLabel(item.certificateState)}
        </Badge>
      </div>
      <div>
        {item.certificateState === 'issued' && item.certificateId ? (
          <CertificateDownloadButton certificateId={item.certificateId} className="w-full">
            Скачать
          </CertificateDownloadButton>
        ) : (
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link href={`/topics/${item.testSlug}`}>
              {item.resultState === 'not_started' ? 'Начать' : 'Подробнее'}
            </Link>
          </Button>
        )}
      </div>
    </article>
  );
}

function LearningDashboard({
  rows,
  failureId,
  needsProfileAction,
}: {
  rows: ProfileAttestation[] | null;
  failureId?: string;
  needsProfileAction: boolean;
}) {
  if (!rows) {
    return (
      <div data-learning-dashboard data-state="failed">
        <DataLoadFailure
          correlationId={failureId ?? 'profile-dashboard'}
          message="Результаты обучения временно не загрузились. Настройки аккаунта продолжают работать."
        />
      </div>
    );
  }
  const current = rows.filter((item) => item.isCurrent);
  const passed = current.filter((item) => item.resultState === 'passed').length;
  const issued = rows.filter(
    (item) => item.certificateState === 'issued' && item.certificateId,
  ).length;

  return (
    <div className="space-y-5" data-learning-dashboard data-state="ready">
      <NextStep rows={rows} needsProfileAction={needsProfileAction} />
      <section aria-labelledby="my-courses-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="my-courses-title" className="font-display text-xl font-bold">
              Мои курсы
            </h2>
            <p className="mt-1 text-sm font-semibold text-[var(--color-text-muted)]">
              Сдано {passed} из {current.length} · Сертификатов {issued}
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/topics">
              Все курсы <ArrowRight />
            </Link>
          </Button>
        </div>
        <div className="overflow-hidden rounded-2xl border bg-[var(--color-surface)]">
          <div className="hidden min-h-11 grid-cols-[minmax(0,2fr)_7rem_10rem_8rem] items-center gap-3 bg-[var(--color-surface-muted)] px-4 text-xs font-bold text-[var(--color-text-muted)] min-[760px]:grid">
            <span>Курс</span>
            <span>Результат</span>
            <span>Сертификат</span>
            <span>Действие</span>
          </div>
          {rows.length ? (
            rows.map((item) => <CourseRow key={item.attestationId} item={item} />)
          ) : (
            <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">
              Курсы пока не опубликованы.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export default async function ProfilePage() {
  let context: Awaited<ReturnType<typeof requireUser>>;
  try {
    context = await requireUser({ enforceLegal: false });
  } catch (error) {
    if (error instanceof AuthenticationError && error.status === 401) redirect('/auth/login');
    if (error instanceof AuthenticationError && error.code === 'ACCOUNT_SUSPENDED')
      redirect('/auth/login');
    throw error;
  }

  if (context.role === 'admin') redirect('/admin');

  const [dashboardResult, avatarUrl, contacts] = await Promise.all([
    getProfileDashboard(),
    context.profile.avatar_updated_at
      ? getProfileAvatarUrl(context.user.id)
      : Promise.resolve(null),
    getSiteContacts(),
  ]);
  const dashboard = dashboardResult.state === 'ready' ? dashboardResult.data : null;
  const profile = dashboard?.profile ?? {
    id: context.profile.id,
    name: context.profile.name,
    surname: context.profile.surname,
    job: context.profile.job,
    organization: context.profile.organization,
    avatarUpdatedAt: context.profile.avatar_updated_at,
    onboardingCompletedAt: context.profile.onboarding_completed_at,
    createdAt: context.profile.created_at,
    updatedAt: context.profile.updated_at,
  };
  const fullName = `${profile.name} ${profile.surname}`.trim() || 'Пользователь';
  const initials = fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  const approval = approvalStatus(context.approval.state);
  const canAccessLearning = context.approval.state === 'approved';

  return (
    <section className="py-7 md:py-12">
      <Container size="content" className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-3xl font-black md:text-4xl">Личный кабинет</h1>
          <Button asChild>
            <Link href={canAccessLearning ? '/topics' : '#my-data'}>
              {canAccessLearning ? 'К курсам' : 'Мои данные'} <ArrowRight />
            </Link>
          </Button>
        </div>

        {!context.hasCurrentLegalAcceptance ? (
          <Card className="border-[var(--color-warning)]">
            <CardContent className="p-4 md:p-5">
              <LegalAcceptancePanel
                initialAcceptances={dashboard?.legalAcceptances ?? []}
                initiallyUnavailable={!dashboard}
              />
            </CardContent>
          </Card>
        ) : null}

        <AccountApprovalStatus
          state={context.approval.state}
          dueAt={context.approval.dueAt}
          rejectionReason={context.approval.rejectionReason}
          contacts={contacts}
        />

        {canAccessLearning ? (
          <LearningDashboard
            rows={dashboard?.attestations ?? null}
            failureId={
              dashboardResult.state === 'failed' ? dashboardResult.correlationId : undefined
            }
            needsProfileAction={!profile.organization || !context.profile.phone_e164}
          />
        ) : null}

        <Card id="my-data">
          <CardContent className="p-0">
            <details className="group">
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden md:px-6">
                <span className="min-w-0">
                  <span className="font-display block text-lg font-bold">Мои данные</span>
                  <span className="block truncate text-sm text-[var(--color-text-muted)]">
                    {fullName} · {profile.organization || 'компания не указана'}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge variant={approval.variant}>{approval.label}</Badge>
                  <CaretDown className="transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <div className="grid gap-5 border-t p-4 sm:grid-cols-[auto_minmax(0,1fr)] md:p-6">
                <AvatarUploader
                  initialUrl={avatarUrl}
                  initials={initials || 'SH'}
                  required
                  compact
                />
                <div className="min-w-0 space-y-4">
                  <div>
                    <h2 className="font-display text-xl font-bold break-words">{fullName}</h2>
                    <p className="text-sm text-[var(--color-text-muted)]">
                      {profile.job || 'Должность не указана'}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
                      <Buildings />
                      <span className="break-words">
                        {profile.organization || 'Компания не указана'}
                      </span>
                    </p>
                  </div>
                  <ProfileForm
                    initial={{
                      name: profile.name,
                      surname: profile.surname,
                      job: profile.job,
                      organization: profile.organization,
                      phone: phoneInputValueFromE164(
                        context.profile.phone_country_iso2,
                        context.profile.phone_e164,
                      ),
                    }}
                  />
                  <div className="flex flex-wrap gap-2">
                    {!profile.onboardingCompletedAt ? (
                      <Button asChild size="sm">
                        <Link href="/onboarding">Завершить профиль</Link>
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </details>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            <details className="group">
              <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden md:px-6">
                <span className="font-display text-lg font-bold">Настройки аккаунта</span>
                <CaretDown className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-4 border-t p-4 md:p-6">
                <p className="text-sm text-[var(--color-text-muted)]">
                  Вход выполняется одноразовым кодом, который приходит на email. Пароль не
                  используется.
                </p>
                <PwaManualInstall />
                <AccountDeletion />
              </div>
            </details>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
