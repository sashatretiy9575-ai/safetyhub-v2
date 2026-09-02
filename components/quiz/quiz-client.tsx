'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  CaretLeft,
  CheckCircle,
  ListChecks,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import Link from 'next/link';
import type { AttemptPayload } from '@/features/learning/types';
import {
  deadlineAnchorFromServer,
  formatDeadlineSeconds,
  remainingDeadlineSeconds,
} from '@/lib/attempt-deadline';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import {
  clearQuizDraft,
  readQuizDraft,
  restoreQuizDraft,
  writeQuizDraft,
  type QuizAnswer,
} from '@/lib/quiz-draft';
import { Container } from '@/components/ui/container';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CertificateDownloadButton } from '@/features/certificates/download-button';
import { Progress } from '@/components/ui/progress';
import { localizedClientRequestMessage } from '@/i18n/client-errors';
import {
  BUSINESS_TIME_ZONE,
  HTML_LANGUAGE_BY_LOCALE,
  localizePathname,
  type AppLocale,
} from '@/i18n/config';

type AttemptErrorPayload = {
  error?: string;
  retryAt?: string;
  attempt?: AttemptPayload;
};
type SaveState = 'idle' | 'saved' | 'error';

function retryDate(value: string | undefined, locale: AppLocale) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString(HTML_LANGUAGE_BY_LOCALE[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: BUSINESS_TIME_ZONE,
  });
}

async function readAttemptError(response: Response) {
  return (await readClientResponseJson<AttemptErrorPayload>(response)) ?? {};
}

function AttemptTimer({
  timerText,
  urgent,
  expired,
  ariaLabel,
}: {
  timerText: string;
  urgent: boolean;
  expired: boolean;
  ariaLabel: string;
}) {
  const tone = expired
    ? 'border-[var(--color-danger)]/60 bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
    : urgent
      ? 'border-[var(--color-warning)]/65 bg-[var(--color-surface)] text-[var(--color-warning)]'
      : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)]';

  return (
    <span
      role="timer"
      aria-label={ariaLabel}
      data-urgency={urgent ? 'soon' : expired ? 'expired' : 'normal'}
      className={`inline-flex min-h-11 min-w-[6.25rem] items-center justify-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-sm font-black tabular-nums ${tone}`}
    >
      {urgent || expired ? <WarningCircle size={16} weight="fill" aria-hidden="true" /> : null}
      <span className="font-mono">{timerText}</span>
    </span>
  );
}

export function QuizClient({ slug, title }: { slug: string; title: string }) {
  const router = useRouter();
  const locale = useLocale() as AppLocale;
  const t = useTranslations('Quiz');
  const tErrors = useTranslations('Common.errors');
  const policyMessage = useCallback(
    (payload: AttemptErrorPayload, status: number) => {
      switch (payload.error) {
        case 'ACCOUNT_APPROVAL_REQUIRED':
          return t('errors.approvalRequired');
        case 'PROFILE_ONBOARDING_REQUIRED':
          return t('errors.onboardingRequired');
        case 'AVATAR_REQUIRED':
          return t('errors.avatarRequired');
        case 'ATTEMPT_ROLLING_LIMIT': {
          const availableAt = retryDate(payload.retryAt, locale);
          return availableAt
            ? t('errors.rollingLimitAt', { availableAt })
            : t('errors.rollingLimitUnknown');
        }
        case 'ATTEMPT_DAILY_LIMIT': {
          const availableAt = retryDate(payload.retryAt, locale);
          return availableAt
            ? t('errors.dailyLimitAt', { availableAt })
            : t('errors.dailyLimitUnknown', { count: 8 });
        }
        case 'ATTEMPT_NOT_FOUND':
          return t('errors.notFound');
        case 'ATTEMPT_VARIANT_INVALID':
          return t('errors.variantInvalid');
        case 'COURSE_CATALOG_MAINTENANCE':
          return t('errors.catalogMaintenance');
        case 'ATTEMPT_ALREADY_COMPLETED':
          return t('errors.alreadyCompleted');
        case 'ATTEMPT_EXPIRED':
          return t('errors.expired');
        default:
          return status === 401 ? t('errors.unauthenticated') : t('errors.openFailed');
      }
    },
    [locale, t],
  );
  const transportMessage = useCallback(
    (error: unknown) =>
      localizedClientRequestMessage(error, t('errors.transportWithDraft'), tErrors),
    [t, tErrors],
  );
  const [attempt, setAttempt] = useState<AttemptPayload | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<QuizAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingExpiry, setCheckingExpiry] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [startedQuiz, setStartedQuiz] = useState(false);

  const attemptRef = useRef<AttemptPayload | null>(null);
  const answersRef = useRef<QuizAnswer[]>([]);
  const currentIndexRef = useRef(0);
  const submissionAnswersRef = useRef<QuizAnswer[] | null>(null);
  const mountedRef = useRef(true);
  const localBackupFailedRef = useRef(false);
  const remainingSecondsRef = useRef<number | null>(null);
  const checkingExpiryRef = useRef(false);

  const persistDraft = useCallback((attemptId: string) => {
    if (typeof window === 'undefined') return true;
    const written = writeQuizDraft(
      window.localStorage,
      attemptId,
      answersRef.current,
      currentIndexRef.current,
    );
    localBackupFailedRef.current = !written;
    return written;
  }, []);

  const applyTerminalAttempt = useCallback((payload: AttemptPayload) => {
    attemptRef.current = payload;
    answersRef.current = [];
    submissionAnswersRef.current = null;
    const settledRemaining = payload.status === 'expired' ? 0 : null;
    remainingSecondsRef.current = settledRemaining;
    setAttempt(payload);
    setAnswers([]);
    setSaveState('idle');
    setSaveError('');
    setReviewing(false);
    setReviewConfirmed(false);
    setSubmissionLocked(false);
    setRemainingSeconds(settledRemaining);
    setError('');
    setErrorCode('');
    if (typeof window !== 'undefined') clearQuizDraft(window.localStorage, payload.attemptId);
  }, []);

  const applyResponseError = useCallback(
    async (response: Response) => {
      const payload = await readAttemptError(response);
      if (payload.error === 'ATTEMPT_EXPIRED' && payload.attempt?.status === 'expired') {
        applyTerminalAttempt(payload.attempt);
        return;
      }
      if (payload.error === 'ATTEMPT_NOT_FOUND') {
        const staleAttemptId = attemptRef.current?.attemptId;
        if (staleAttemptId && typeof window !== 'undefined') {
          clearQuizDraft(window.localStorage, staleAttemptId);
        }
        attemptRef.current = null;
        answersRef.current = [];
        currentIndexRef.current = 0;
        submissionAnswersRef.current = null;
        setAttempt(null);
        setAnswers([]);
        setCurrentIndex(0);
        setReviewing(false);
        setReviewConfirmed(false);
        setSubmissionLocked(false);
        setSaveState('idle');
        setSaveError('');
      }
      setErrorCode(payload.error ?? 'REQUEST_FAILED');
      setError(policyMessage(payload, response.status));
      if (payload.error === 'PROFILE_ONBOARDING_REQUIRED' || payload.error === 'AVATAR_REQUIRED') {
        router.replace(localizePathname('/onboarding', locale));
      }
    },
    [applyTerminalAttempt, locale, policyMessage, router],
  );

  const refreshAttemptStatus = useCallback(
    async (attemptId: string) => {
      if (checkingExpiryRef.current) return;
      checkingExpiryRef.current = true;
      setCheckingExpiry(true);
      try {
        const result = await clientRequest(`/api/attempts/${attemptId}`, { method: 'POST' });
        if (!result.ok) {
          if (result.response) await applyResponseError(result.response);
          else setError(transportMessage(result.error));
          return;
        }
        const payload = await readClientResponseJson<AttemptPayload>(result.response);
        if (!payload) throw new Error('INVALID_ATTEMPT_RESPONSE');
        if (payload.status === 'started') {
          attemptRef.current = payload;
          setAttempt(payload);
          setError('');
          setErrorCode('');
        } else {
          applyTerminalAttempt(payload);
        }
      } catch (requestError) {
        setError(localizedClientRequestMessage(requestError, t('errors.expiryCheck'), tErrors));
      } finally {
        checkingExpiryRef.current = false;
        if (mountedRef.current) setCheckingExpiry(false);
      }
    },
    [applyResponseError, applyTerminalAttempt, t, tErrors, transportMessage],
  );

  const loadAttempt = useCallback(
    async (startNew = false) => {
      setLoading(true);
      setError('');
      setErrorCode('');
      try {
        const result = await clientRequest('/api/attempts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testSlug: slug, startNew, locale }),
        });
        if (!result.ok) {
          if (result.response) await applyResponseError(result.response);
          else {
            setErrorCode('REQUEST_FAILED');
            setError(transportMessage(result.error));
          }
          return;
        }

        const payload = await readClientResponseJson<AttemptPayload>(result.response);
        if (!payload) throw new Error('INVALID_ATTEMPT_RESPONSE');
        if (payload.locale !== locale) {
          window.location.replace(
            localizePathname(`/topics/${payload.testSlug}/test`, payload.locale),
          );
          return;
        }
        attemptRef.current = payload;
        setAttempt(payload);
        setReviewing(false);
        setReviewConfirmed(false);
        setSubmissionLocked(false);
        submissionAnswersRef.current = null;

        if (payload.status === 'started') {
          const localDraft =
            typeof window === 'undefined'
              ? null
              : readQuizDraft(window.localStorage, payload.attemptId);
          const restored = restoreQuizDraft(payload.attemptId, payload.questions, localDraft);
          answersRef.current = restored.answers;
          currentIndexRef.current = restored.currentIndex;
          setAnswers(restored.answers);
          setCurrentIndex(restored.currentIndex);
          setSaveState(restored.answers.length > 0 ? 'saved' : 'idle');
          persistDraft(payload.attemptId);
        } else {
          answersRef.current = [];
          setAnswers([]);
          setSaveState('idle');
          if (typeof window !== 'undefined') clearQuizDraft(window.localStorage, payload.attemptId);
        }
      } catch (requestError) {
        setErrorCode('REQUEST_FAILED');
        setError(localizedClientRequestMessage(requestError, t('errors.loadFailed'), tErrors));
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [applyResponseError, locale, persistDraft, slug, t, tErrors, transportMessage],
  );

  useEffect(() => {
    mountedRef.current = true;
    void loadAttempt();
    return () => {
      mountedRef.current = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    const refreshExpiredAttempt = () => {
      const activeAttempt = attemptRef.current;
      if (activeAttempt?.status === 'started' && remainingSecondsRef.current === 0) {
        void refreshAttemptStatus(activeAttempt.attemptId);
      }
    };
    window.addEventListener('online', refreshExpiredAttempt);
    return () => window.removeEventListener('online', refreshExpiredAttempt);
  }, [refreshAttemptStatus]);

  useEffect(() => {
    if (attempt?.status !== 'started') {
      const settledValue = attempt?.status === 'expired' ? 0 : null;
      remainingSecondsRef.current = settledValue;
      setRemainingSeconds(settledValue);
      return;
    }

    const anchor = deadlineAnchorFromServer(
      attempt.expiresAt,
      attempt.serverNow,
      performance.now(),
    );
    if (anchor === null) {
      remainingSecondsRef.current = null;
      setRemainingSeconds(null);
      setError(t('errors.invalidDeadline'));
      return;
    }

    let requestedServerConfirmation = false;
    const updateTimer = () => {
      const next = remainingDeadlineSeconds(anchor, performance.now());
      if (next !== remainingSecondsRef.current) {
        remainingSecondsRef.current = next;
        setRemainingSeconds(next);
      }
      if (next === 0 && !requestedServerConfirmation) {
        requestedServerConfirmation = true;
        void refreshAttemptStatus(attempt.attemptId);
      }
    };
    updateTimer();
    const interval = window.setInterval(updateTimer, 1000);
    return () => window.clearInterval(interval);
  }, [attempt, refreshAttemptStatus, t]);

  useEffect(() => {
    if (!localBackupFailedRef.current && !submissionLocked) return;
    const warnAboutUnsavedAnswers = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnAboutUnsavedAnswers);
    return () => window.removeEventListener('beforeunload', warnAboutUnsavedAnswers);
  }, [saveState, submissionLocked]);

  const navigateToQuestion = (index: number) => {
    const activeAttempt = attemptRef.current;
    currentIndexRef.current = index;
    setCurrentIndex(index);
    setReviewing(false);
    setReviewConfirmed(false);
    if (activeAttempt?.status === 'started') persistDraft(activeAttempt.attemptId);
  };

  const selectOption = (questionId: string, optionId: string) => {
    const activeAttempt = attemptRef.current;
    if (!activeAttempt || activeAttempt.status !== 'started') return;
    const nextAnswers = [
      ...answersRef.current.filter((answer) => answer.questionId !== questionId),
      { questionId, optionId },
    ];
    answersRef.current = nextAnswers;
    setAnswers(nextAnswers);
    setSaveError('');
    setReviewConfirmed(false);
    const persisted = persistDraft(activeAttempt.attemptId);
    if (!persisted) {
      setSaveState('error');
      setSaveError(t('errors.localSaveFailed'));
    } else {
      setSaveState('saved');
    }
  };

  const openReview = () => {
    if (!attempt || answersRef.current.length !== attempt.questions.length) return;
    setReviewConfirmed(false);
    setSubmissionLocked(false);
    submissionAnswersRef.current = null;
    setReviewing(true);
  };

  const submitAttempt = async () => {
    const activeAttempt = attemptRef.current;
    if (
      !activeAttempt ||
      activeAttempt.status !== 'started' ||
      answersRef.current.length !== activeAttempt.questions.length ||
      !reviewConfirmed
    ) {
      return;
    }

    setSubmitting(true);
    setSubmissionLocked(true);
    setError('');
    setErrorCode('');
    const submissionAnswers =
      submissionAnswersRef.current ??
      [...answersRef.current].sort((a, b) => a.questionId.localeCompare(b.questionId));
    submissionAnswersRef.current = submissionAnswers;
    try {
      const result = await clientRequest(`/api/attempts/${activeAttempt.attemptId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: submissionAnswers }),
      });
      if (!result.ok) {
        if (result.response) await applyResponseError(result.response);
        else setError(transportMessage(result.error));
        return;
      }

      const payload = await readClientResponseJson<AttemptPayload>(result.response);
      if (!payload) throw new Error('INVALID_ATTEMPT_RESPONSE');
      attemptRef.current = payload;
      setAttempt(payload);
      setReviewing(false);
      setReviewConfirmed(false);
      setSubmissionLocked(false);
      submissionAnswersRef.current = null;
      setSaveState('idle');
      setSaveError('');
      if (typeof window !== 'undefined') clearQuizDraft(window.localStorage, payload.attemptId);
    } catch (requestError) {
      setError(localizedClientRequestMessage(requestError, t('errors.submitFailed'), tErrors));
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  if (loading)
    return (
      <section className="py-16">
        <Container size="narrow">
          <p role="status" className="text-center text-sm text-[var(--color-text-muted)]">
            {t('loading')}
          </p>
        </Container>
      </section>
    );

  if (!attempt) {
    const onboardingAction = errorCode === 'PROFILE_ONBOARDING_REQUIRED';
    const approvalAction = errorCode === 'ACCOUNT_APPROVAL_REQUIRED';
    return (
      <section className="py-16">
        <Container size="narrow">
          <Card>
            <CardContent className="space-y-4 p-6 text-center">
              <p role="alert">{error}</p>
              <div className="flex flex-wrap justify-center gap-3">
                {errorCode === 'UNAUTHENTICATED' ? (
                  <Button asChild>
                    <Link href={localizePathname('/auth/login', locale)}>{t('signIn')}</Link>
                  </Button>
                ) : onboardingAction ? (
                  <Button onClick={() => router.push(localizePathname('/onboarding', locale))}>
                    {t('completeProfile')}
                  </Button>
                ) : approvalAction ? (
                  <Button onClick={() => router.push(localizePathname('/profile', locale))}>
                    {t('openApproval')}
                  </Button>
                ) : errorCode === 'ATTEMPT_NOT_FOUND' ? (
                  <Button onClick={() => void loadAttempt(true)}>{t('newAttempt')}</Button>
                ) : (
                  <Button variant="outline" onClick={() => void loadAttempt(false)}>
                    {t('retry')}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </Container>
      </section>
    );
  }

  if (attempt.status === 'passed' || attempt.status === 'failed' || attempt.status === 'expired') {
    const passed = attempt.status === 'passed';
    const expired = attempt.status === 'expired';
    const percent =
      attempt.score === null ? null : Math.round((attempt.score / attempt.total) * 100);
    return (
      <section className="py-10 md:py-20">
        <Container size="narrow">
          <Card className="overflow-hidden border-2">
            <CardContent className="space-y-6 p-5 text-center md:p-10">
              <span
                className={`mx-auto grid size-20 place-items-center rounded-full ${passed ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]' : expired ? 'bg-[var(--color-accent-amber-soft)] text-[var(--color-accent-amber)]' : 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'}`}
              >
                {passed ? (
                  <CheckCircle size={44} weight="fill" />
                ) : (
                  <XCircle size={44} weight="fill" />
                )}
              </span>
              <div>
                <h1 className="font-display text-3xl font-black">
                  {passed
                    ? t('result.passedTitle')
                    : expired
                      ? t('result.expiredTitle')
                      : t('result.failedTitle')}
                </h1>
                <p className="mt-2 text-[var(--color-text-muted)]">{title}</p>
              </div>
              {passed ? (
                <>
                  <div className="border-y border-dashed border-[var(--color-border)] py-5">
                    <strong className="text-5xl tabular-nums">
                      {attempt.score}/{attempt.total}
                    </strong>
                    <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                      {t('result.correctPercent', { percent: percent ?? 0 })}
                    </p>
                  </div>
                  <Progress value={percent ?? 0} className="h-3" />
                  {!attempt.certificateId ? (
                    <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-accent-amber-soft)] p-4 text-left">
                      <p className="font-bold">
                        {attempt.certificatePendingVerification
                          ? t('result.pendingVerification')
                          : t('result.readyForCertificate')}
                      </p>
                      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                        {t('result.certificateAdminIssue')}
                      </p>
                    </div>
                  ) : null}
                  <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 text-left text-sm leading-6 text-[var(--color-text-muted)]">
                    {t('result.savedNoAnswers')}
                  </p>
                </>
              ) : expired ? (
                <div className="space-y-2 border-y border-dashed border-[var(--color-border)] py-5">
                  <strong className="text-lg">{t('result.expiredServer')}</strong>
                  <p className="text-sm text-[var(--color-text-muted)]">
                    {t('result.expiredDescription', { minutes: attempt.durationMinutes })}
                  </p>
                </div>
              ) : (
                <div className="space-y-3 border-y border-dashed border-[var(--color-border)] py-5">
                  <strong className="text-5xl tabular-nums">
                    {attempt.score ?? 0}/{attempt.total}
                  </strong>
                  <p className="text-sm text-[var(--color-text-muted)]">
                    {t('result.failedDescription')}
                  </p>
                  <Progress value={percent ?? 0} className="h-3" />
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-[var(--color-danger)]">
                  {error}
                </p>
              )}
              <div className="flex flex-col justify-center gap-3 min-[360px]:flex-row">
                <Button variant="outline" onClick={() => void loadAttempt(true)}>
                  <ArrowCounterClockwise size={18} />
                  {expired ? t('newAttempt') : passed ? t('improveResult') : t('retake')}
                </Button>
                {attempt.certificateId ? (
                  <CertificateDownloadButton certificateId={attempt.certificateId} size="md">
                    {t('certificate')}
                  </CertificateDownloadButton>
                ) : null}
                <Button onClick={() => router.push(localizePathname('/profile', locale))}>
                  {t('openAccount')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </Container>
      </section>
    );
  }

  const timerText = remainingSeconds === null ? '--:--' : formatDeadlineSeconds(remainingSeconds);
  const allAnswered = answers.length === attempt.questions.length;
  const progress = attempt.questions.length ? (answers.length / attempt.questions.length) * 100 : 0;
  const timerUrgent =
    remainingSeconds !== null && remainingSeconds > 0 && remainingSeconds <= 5 * 60;
  const timerExpired = remainingSeconds === 0;
  const timerAriaLabel = t(timerUrgent ? 'timerUrgentAria' : 'timerAria', { time: timerText });
  if (reviewing) {
    return (
      <section className="py-8 md:py-16">
        <Container size="narrow">
          <Card className="border-2">
            <CardContent className="space-y-6 p-4 min-[320px]:p-5 md:p-8">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-[var(--color-primary)]">
                    {t('review.eyebrow')}
                  </p>
                  <AttemptTimer
                    timerText={timerText}
                    urgent={timerUrgent}
                    expired={timerExpired}
                    ariaLabel={timerAriaLabel}
                  />
                </div>
                <h1 className="font-display mt-1 text-2xl font-black">{t('review.title')}</h1>
                <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                  {t('review.description')}
                </p>
                <Progress
                  value={progress}
                  aria-label={t('progressAria', {
                    completed: answers.length,
                    total: attempt.questions.length,
                  })}
                  className="mt-4 h-2.5"
                />
              </div>
              {remainingSeconds === 0 && (
                <div
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-warning)]/45 bg-[var(--color-surface-muted)] px-3 py-2 text-sm"
                >
                  <span>{t('review.expired')}</span>
                  <button
                    type="button"
                    className="min-h-11 font-bold text-[var(--color-primary)]"
                    disabled={checkingExpiry}
                    onClick={() => void refreshAttemptStatus(attempt.attemptId)}
                  >
                    {checkingExpiry ? t('checking') : t('check')}
                  </button>
                </div>
              )}
              <ol className="space-y-3">
                {attempt.questions.map((question, index) => {
                  const answer = answers.find((item) => item.questionId === question.id);
                  const selected = question.options.find(
                    (option) => option.id === answer?.optionId,
                  );
                  return (
                    <li
                      key={question.id}
                      className="rounded-xl border border-[var(--color-border)] p-4"
                    >
                      <p className="font-bold">
                        {index + 1}. {question.text}
                      </p>
                      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                        {selected
                          ? t('review.selected', { answer: selected.text })
                          : t('review.notSelected')}
                      </p>
                      <button
                        type="button"
                        disabled={submissionLocked || submitting}
                        className="mt-2 min-h-11 text-sm font-bold text-[var(--color-primary)]"
                        onClick={() => navigateToQuestion(index)}
                      >
                        {t('review.change')}
                      </button>
                    </li>
                  );
                })}
              </ol>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-[var(--color-surface-muted)] p-4 text-sm font-semibold">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5 accent-[var(--color-primary)]"
                  checked={reviewConfirmed}
                  disabled={submissionLocked || submitting}
                  onChange={(event) => setReviewConfirmed(event.target.checked)}
                />
                {t('review.confirmation')}
              </label>
              {error && (
                <p role="alert" className="text-sm text-[var(--color-danger)]">
                  {error}
                </p>
              )}
              <div className="flex flex-col-reverse justify-between gap-3 min-[420px]:flex-row">
                <Button
                  variant="outline"
                  onClick={() => navigateToQuestion(currentIndexRef.current)}
                  disabled={submissionLocked || submitting}
                >
                  <ArrowLeft size={18} />
                  {t('back')}
                </Button>
                <Button
                  onClick={() => void submitAttempt()}
                  disabled={!allAnswered || !reviewConfirmed || submitting}
                >
                  {submitting
                    ? t('submitting')
                    : submissionLocked
                      ? t('retrySubmit')
                      : t('confirmSubmit')}
                  <CheckCircle size={18} />
                </Button>
              </div>
            </CardContent>
          </Card>
        </Container>
      </section>
    );
  }

  if (attempt.status === 'started' && !startedQuiz && answers.length === 0) {
    return (
      <section className="py-10 md:py-20">
        <Container size="narrow">
          <Card className="overflow-hidden border-2">
            <CardContent className="space-y-6 p-6 sm:p-10 text-center">
              <span className="mx-auto grid size-16 place-items-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <ListChecks size={36} weight="duotone" />
              </span>
              <div className="space-y-2">
                <h1 className="font-display text-2xl sm:text-3xl font-bold">{title}</h1>
                <p className="text-sm text-[var(--color-text-muted)]">
                  {t('rules.subtitle')}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 rounded-xl bg-[var(--color-surface-muted)] p-4 border border-[var(--color-border)] text-left">
                <div className="space-y-1">
                  <p className="text-xs text-[var(--color-text-muted)]">{t('rules.questions')}</p>
                  <p className="font-bold text-base sm:text-lg tabular-nums">{attempt.questions.length}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-[var(--color-text-muted)]">{t('rules.time')}</p>
                  <p className="font-bold text-base sm:text-lg tabular-nums">{t('rules.timeValue')}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-[var(--color-text-muted)]">{t('rules.passScore')}</p>
                  <p className="font-bold text-base sm:text-lg tabular-nums">{t('rules.passScoreValue')}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-[var(--color-text-muted)]">{t('rules.attempts')}</p>
                  <p className="font-bold text-base sm:text-lg tabular-nums">{t('rules.attemptsValue')}</p>
                </div>
              </div>

              <div className="flex justify-center gap-3">
                <Button size="lg" className="w-full sm:w-auto min-w-[12rem]" onClick={() => setStartedQuiz(true)}>
                  {t('rules.start')}
                  <ArrowRight size={18} />
                </Button>
              </div>
            </CardContent>
          </Card>
        </Container>
      </section>
    );
  }

  const currentQuestion = attempt.questions[currentIndex];
  if (!currentQuestion) return null;
  const selectedOptionId = answers.find(
    (answer) => answer.questionId === currentQuestion.id,
  )?.optionId;
  const saveLabel =
    saveState === 'saved' ? t('draftSaved') : saveState === 'error' ? saveError : '';

  return (
    <section className="py-8 md:py-16">
      <Container size="narrow">
        <div className="mb-5 flex items-center justify-between gap-3">
          <Link
            href={localizePathname(`/topics/${slug}`, locale)}
            onClick={(event) => {
              if (localBackupFailedRef.current && !window.confirm(t('leaveWithoutDraft'))) {
                event.preventDefault();
              }
            }}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-[var(--color-text-muted)]"
          >
            <CaretLeft size={16} /> {t('toCourse')}
          </Link>
          <div className="flex items-center gap-2">
            <AttemptTimer
              timerText={timerText}
              urgent={timerUrgent}
              expired={timerExpired}
              ariaLabel={timerAriaLabel}
            />
            <span className="text-xs font-bold">
              {currentIndex + 1} / {attempt.questions.length}
            </span>
          </div>
        </div>
        {remainingSeconds === 0 && (
          <div
            role="status"
            className="mb-4 flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-warning)]/45 bg-[var(--color-surface-muted)] px-3 py-2 text-sm"
          >
            <span>{t('timerExpired')}</span>
            <button
              type="button"
              className="min-h-11 shrink-0 font-bold text-[var(--color-primary)]"
              disabled={checkingExpiry}
              onClick={() => void refreshAttemptStatus(attempt.attemptId)}
            >
              {checkingExpiry ? t('checking') : t('check')}
            </button>
          </div>
        )}
        <Progress
          value={progress}
          aria-label={t('progressAria', {
            completed: answers.length,
            total: attempt.questions.length,
          })}
          className="mb-4 h-2.5"
        />
        <nav aria-label={t('questionsAria')} className="mb-7 flex justify-center gap-2">
          {attempt.questions.map((question, index) => {
            const answered = answers.some((answer) => answer.questionId === question.id);
            const current = index === currentIndex;
            return (
              <button
                key={question.id}
                type="button"
                aria-label={
                  answered
                    ? t('questionAnsweredAria', { number: index + 1 })
                    : t('questionAria', { number: index + 1 })
                }
                aria-current={current ? 'step' : undefined}
                onClick={() => navigateToQuestion(index)}
                className={`grid size-11 place-items-center rounded-full border-2 text-sm font-black transition-colors ${
                  current
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
                    : answered
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                }`}
              >
                {index + 1}
              </button>
            );
          })}
        </nav>
        <Card className="border-2">
          <CardContent className="space-y-6 p-4 min-[320px]:p-5 md:p-8">
            <h1 className="font-display text-xl leading-tight font-bold">{currentQuestion.text}</h1>
            <fieldset className="space-y-3">
              <legend className="sr-only">{t('chooseAnswer')}</legend>
              {currentQuestion.options.map((option) => {
                const selected = selectedOptionId === option.id;
                return (
                  <label
                    key={option.id}
                    className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl border-2 p-3 text-left text-sm font-semibold transition-colors ${selected ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]' : 'border-[var(--color-border)] hover:border-[var(--color-primary)]'}`}
                  >
                    <input
                      type="radio"
                      name={`question-${currentQuestion.id}`}
                      value={option.id}
                      checked={selected}
                      onChange={() => selectOption(currentQuestion.id, option.id)}
                      className="sr-only"
                    />
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded-full border text-xs ${selected ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white' : 'border-[var(--color-border)]'}`}
                    >
                      {String.fromCharCode(64 + option.position)}
                    </span>
                    {option.text}
                  </label>
                );
              })}
            </fieldset>
            {saveLabel && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p
                  role="status"
                  className={`text-xs ${saveState === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}
                >
                  {saveLabel}
                </p>
                {saveState === 'error' && answers.length > 0 && (
                  <button
                    type="button"
                    className="min-h-11 text-xs font-bold text-[var(--color-primary)]"
                    onClick={() => {
                      const saved = persistDraft(attempt.attemptId);
                      setSaveState(saved ? 'saved' : 'error');
                      if (saved) setSaveError('');
                    }}
                  >
                    {t('retryLocalSave')}
                  </button>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {error}
              </p>
            )}
            <div className="flex justify-between gap-3">
              <Button
                variant="outline"
                onClick={() => navigateToQuestion(currentIndex - 1)}
                disabled={currentIndex === 0}
              >
                <ArrowLeft size={18} />
                {t('previous')}
              </Button>
              {currentIndex === attempt.questions.length - 1 ? (
                <div className="flex flex-col items-end gap-1">
                  <Button
                    onClick={() => {
                      if (!allAnswered) {
                        const unansweredIdx = attempt.questions.findIndex(
                          (q) => !answers.some((a) => a.questionId === q.id),
                        );
                        if (unansweredIdx !== -1) {
                          setError(t('rules.answerFirst'));
                          navigateToQuestion(unansweredIdx);
                        }
                        return;
                      }
                      openReview();
                    }}
                  >
                    {t('reviewAnswers')}
                    <CheckCircle size={18} />
                  </Button>
                  {!allAnswered ? (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {t('rules.answered', {
                        completed: answers.length,
                        total: attempt.questions.length,
                      })}
                    </span>
                  ) : null}
                </div>
              ) : (
                <Button
                  onClick={() => navigateToQuestion(currentIndex + 1)}
                  disabled={!selectedOptionId}
                >
                  {t('next')}
                  <ArrowRight size={18} />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
