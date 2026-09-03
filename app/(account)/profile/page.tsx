export const dynamic = 'force-dynamic';

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
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
import { SignOutAction } from '@/components/shared/sign-out-action';
import { CertificateDownloadButton } from '@/features/certificates/download-button';
import { phoneCountryOptions, phoneInputValueFromE164 } from '@/lib/phone';
import { getSiteContacts } from '@/lib/site-contacts';
import { localizePathname, type AppLocale } from '@/i18n/config';
import { getCurrentLegalPolicies } from '@/lib/legal-current';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';

type ProfileTranslator = Awaited<ReturnType<typeof getTranslations>>;

function certificateLabel(state: ProfileAttestation['certificateState'], t: ProfileTranslator) {
  if (state === 'pending_identity') return t('certificatePendingIdentity');
  if (state === 'ready') return t('certificateReady');
  if (state === 'issued') return t('certificateIssued');
  if (state === 'revoked') return t('certificateRevoked');
  return t('certificateUnavailable');
}

function certificateVariant(state: ProfileAttestation['certificateState']): BadgeProps['variant'] {
  if (state === 'issued') return 'success';
  if (state === 'pending_identity' || state === 'ready') return 'warning';
  if (state === 'revoked') return 'danger';
  return 'outline';
}

function resultLabel(item: ProfileAttestation, t: ProfileTranslator) {
  if (item.resultState === 'passed')
    return item.score === null ? t('passed') : `${item.score}/${item.total}`;
  if (item.resultState === 'failed')
    return item.score === null ? t('failed') : `${item.score}/${item.total}`;
  return t('notStarted');
}

function resultVariant(state: ProfileAttestation['resultState']): BadgeProps['variant'] {
  if (state === 'passed') return 'primary';
  if (state === 'failed') return 'danger';
  return 'outline';
}

function approvalStatus(
  state: 'profile_incomplete' | 'pending' | 'approved' | 'rejected',
  t: ProfileTranslator,
) {
  if (state === 'approved') return { label: t('approvalApproved'), variant: 'success' as const };
  if (state === 'rejected') return { label: t('approvalRejected'), variant: 'danger' as const };
  if (state === 'pending') return { label: t('approvalPending'), variant: 'warning' as const };
  return { label: t('approvalIncomplete'), variant: 'warning' as const };
}

function NextStep({
  rows,
  needsProfileAction,
  locale,
  t,
}: {
  rows: ProfileAttestation[];
  needsProfileAction: boolean;
  locale: AppLocale;
  t: ProfileTranslator;
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
                {t('nextStep')}
              </p>
              <h2 className="font-display mt-1 text-xl font-bold">
                {t('testPassed', { score: waiting.score ?? '—', total: waiting.total })}
              </h2>
              <p className="mt-1 text-sm font-semibold">{waiting.courseTitle}</p>
            </div>
            <Badge variant="warning">{t('certificatePreparing')}</Badge>
          </div>
          {needsProfileAction ? (
            <div className="rounded-xl bg-[var(--color-accent-amber-soft)] p-3 text-sm">
              <strong>{t('actionRequired')}</strong> {t('checkCompany')}
              <div className="mt-3">
                <Button asChild size="sm">
                  <a href="#my-data">{t('fixData')}</a>
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1 text-sm text-[var(--color-text-muted)]">
              <p>
                <strong className="text-[var(--color-text)]">{t('now')}</strong>{' '}
                {t('nowDescription')}
              </p>
              <p>
                <strong className="text-[var(--color-text)]">{t('then')}</strong>{' '}
                {t('thenDescription')}
              </p>
              <p>
                <strong className="text-[var(--color-text)]">{t('nothingRequired')}</strong>
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
            <p className="text-sm text-[var(--color-text-muted)]">{t('nextStep')}</p>
            <h2 className="font-display text-lg font-bold">
              {t('retryCourse', { title: failed.courseTitle })}
            </h2>
            <p className="text-sm">
              {t('score', { score: failed.score ?? '—', total: failed.total })}
            </p>
          </div>
          <Button asChild size="sm">
            <Link href={localizePathname(`/topics/${failed.testSlug}`, locale)}>
              {t('toCourse')}
            </Link>
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
          <p className="text-sm text-[var(--color-text-muted)]">{t('nextStep')}</p>
          <h2 className="font-display text-lg font-bold">
            {nextCourse
              ? t('continueCourse', { title: nextCourse.courseTitle })
              : t('chooseCourse')}
          </h2>
        </div>
        <Button asChild size="sm">
          <Link
            href={localizePathname(
              nextCourse ? `/topics/${nextCourse.testSlug}` : '/topics',
              locale,
            )}
          >
            {nextCourse ? t('toCourse') : t('allCourses')}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function CourseRow({
  item,
  locale,
  t,
}: {
  item: ProfileAttestation;
  locale: AppLocale;
  t: ProfileTranslator;
}) {
  const isIssued = item.certificateState === 'issued' && item.certificateId;
  const isSpecialCertState =
    item.certificateState === 'pending_identity' ||
    item.certificateState === 'ready';

  return (
    <article className="grid min-w-0 gap-3 border-t border-[var(--color-border)] px-4 py-3 first:border-t-0 md:min-h-[58px] md:grid-cols-[minmax(0,1fr)_11rem_8.5rem] md:items-center">
      <div className="min-w-0">
        <h3 className="font-semibold break-words leading-tight">{item.courseTitle}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)] md:hidden">
          <Badge
            variant={
              isSpecialCertState
                ? certificateVariant(item.certificateState)
                : resultVariant(item.resultState)
            }
          >
            {isSpecialCertState ? certificateLabel(item.certificateState, t) : resultLabel(item, t)}
          </Badge>
          {!item.isCurrent ? <span>· {t('archive')}</span> : null}
        </div>
        {!item.isCurrent ? (
          <p className="hidden text-xs text-[var(--color-text-muted)] md:block">{t('archive')}</p>
        ) : null}
      </div>

      <div className="hidden md:flex md:items-center md:gap-1.5">
        <Badge
          variant={
            isSpecialCertState
              ? certificateVariant(item.certificateState)
              : resultVariant(item.resultState)
          }
        >
          {isSpecialCertState ? certificateLabel(item.certificateState, t) : resultLabel(item, t)}
        </Badge>
        {isSpecialCertState && item.resultState === 'passed' ? (
          <Badge variant="outline" className="text-[11px] text-[var(--color-text-muted)]">
            {resultLabel(item, t)}
          </Badge>
        ) : null}
      </div>

      <div className="w-full">
        {isIssued ? (
          <CertificateDownloadButton certificateId={item.certificateId!} className="w-full">
            {t('download')}
          </CertificateDownloadButton>
        ) : (
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link href={localizePathname(`/topics/${item.testSlug}`, locale)}>
              {item.resultState === 'not_started' ? t('start') : t('details')}
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
  locale,
  t,
}: {
  rows: ProfileAttestation[] | null;
  failureId?: string;
  needsProfileAction: boolean;
  locale: AppLocale;
  t: ProfileTranslator;
}) {
  if (!rows) {
    return (
      <div data-learning-dashboard data-state="failed">
        <DataLoadFailure
          correlationId={failureId ?? 'profile-dashboard'}
          message={t('dashboardFailure')}
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
      <NextStep rows={rows} needsProfileAction={needsProfileAction} locale={locale} t={t} />
      <section aria-labelledby="my-courses-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="my-courses-title" className="font-display text-xl font-bold">
              {t('coursesTitle')}
            </h2>
            <p className="mt-1 text-sm font-semibold text-[var(--color-text-muted)]">
              {t('coursesSummary', {
                passed,
                total: current.length,
                certificates: issued,
              })}
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={localizePathname('/topics', locale)}>
              {t('allCourses')} <ArrowRight />
            </Link>
          </Button>
        </div>
        <div className="overflow-hidden rounded-2xl border bg-[var(--color-surface)]">
          <div className="hidden min-h-10 grid-cols-[minmax(0,1fr)_11rem_8.5rem] items-center gap-3 bg-[var(--color-surface-muted)] px-4 text-xs font-bold text-[var(--color-text-muted)] md:grid">
            <span>{t('course')}</span>
            <span>{t('result')}</span>
            <span className="sr-only">{t('action')}</span>
          </div>
          {rows.length ? (
            rows.map((item) => (
              <CourseRow key={item.attestationId} item={item} locale={locale} t={t} />
            ))
          ) : (
            <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">
              {t('coursesEmpty')}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

export default async function ProfilePage() {
  const locale = (await getPrivateRequestLocale()) as AppLocale;
  const t = await getTranslations({ locale, namespace: 'Profile' });
  let context: Awaited<ReturnType<typeof requireUser>>;
  try {
    context = await requireUser({ enforceLegal: false });
  } catch (error) {
    if (error instanceof AuthenticationError && error.status === 401)
      redirect(localizePathname('/auth/login', locale));
    if (error instanceof AuthenticationError && error.code === 'ACCOUNT_SUSPENDED')
      redirect(localizePathname('/auth/login', locale));
    throw error;
  }

  if (context.role === 'admin') redirect('/admin');

  const [dashboardResult, avatarUrl, contacts, currentPolicies] = await Promise.all([
    getProfileDashboard(locale),
    context.profile.avatar_updated_at
      ? getProfileAvatarUrl(context.user.id)
      : Promise.resolve(null),
    getSiteContacts(),
    context.hasCurrentLegalAcceptance ? Promise.resolve(null) : getCurrentLegalPolicies(),
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
  const fullName =
    (locale === 'zh'
      ? `${profile.surname}${profile.name}`.trim()
      : `${profile.name} ${profile.surname}`.trim()) || t('userFallback');
  const initials = fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  const approval = approvalStatus(context.approval.state, t);
  const canAccessLearning = context.approval.state === 'approved';

  return (
    <section className="py-7 md:py-12">
      <Container size="content" className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-3xl font-black md:text-4xl">{t('dashboardTitle')}</h1>
          <Button asChild>
            <Link href={canAccessLearning ? localizePathname('/topics', locale) : '#my-data'}>
              {canAccessLearning ? t('toCourses') : t('myData')} <ArrowRight />
            </Link>
          </Button>
        </div>

        {!context.hasCurrentLegalAcceptance ? (
          <section className="border-y border-[var(--color-border)] py-4 md:py-5">
            <LegalAcceptancePanel
              initialAcceptances={dashboard?.legalAcceptances ?? []}
              initiallyUnavailable={!dashboard}
              currentPolicies={currentPolicies!}
            />
          </section>
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
            locale={locale}
            t={t}
          />
        ) : null}

        <Card id="my-data">
          <CardContent className="p-0">
            <details
              className="group"
              open={!profile.onboardingCompletedAt || context.approval.state === 'rejected' || !context.profile.phone_e164 || !profile.organization}
            >
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden md:px-6">
                <span className="min-w-0">
                  <span className="font-display block text-lg font-bold">
                    {t('myData')}
                    {!context.profile.phone_e164 || !profile.organization ? ` (${t('actionRequired').replace(/:$/, '')})` : ''}
                  </span>
                  <span className="block truncate text-sm text-[var(--color-text-muted)]">
                    {fullName} · {profile.organization || t('companyMissing')}
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
                      {profile.job || t('jobMissing')}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
                      <Buildings />
                      <span className="break-words">
                        {profile.organization || t('companyMissingCapital')}
                      </span>
                    </p>
                  </div>
                  <ProfileForm
                    countryOptions={phoneCountryOptions(locale)}
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
                        <Link href={localizePathname('/onboarding', locale)}>
                          {t('completeProfile')}
                        </Link>
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
                <span className="font-display text-lg font-bold">{t('settings')}</span>
                <CaretDown className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-4 border-t p-4 md:p-6">
                <PwaManualInstall />
                <SignOutAction />
                <AccountDeletion />
              </div>
            </details>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
