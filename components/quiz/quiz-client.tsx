'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowRight,
  CaretLeft,
  CheckCircle,
  XCircle,
} from '@phosphor-icons/react';
import Link from 'next/link';
import type { AttemptPayload } from '@/features/learning/types';
import {
  deadlineAnchorFromServer,
  formatDeadlineSeconds,
  remainingDeadlineSeconds,
} from '@/lib/attempt-deadline';
import {
  ClientRequestError,
  clientRequest,
  clientRequestMessage,
  readClientResponseJson,
} from '@/lib/client-request';
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

type AttemptErrorPayload = {
  error?: string;
  retryAt?: string;
  attempt?: AttemptPayload;
};
type SaveState = 'idle' | 'saved' | 'error';

function retryDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function policyMessage(payload: AttemptErrorPayload, status: number) {
  switch (payload.error) {
    case 'PROFILE_ONBOARDING_REQUIRED':
      return 'Перед первым тестом заполните имя, должность и компанию, затем добавьте фотографию.';
    case 'AVATAR_REQUIRED':
      return 'Перед прохождением теста загрузите обязательную фотографию профиля.';
    case 'ATTEMPT_ROLLING_LIMIT': {
      const availableAt = retryDate(payload.retryAt);
      return availableAt
        ? `Повторное прохождение будет доступно ${availableAt}.`
        : 'Дата следующего прохождения временно недоступна. Попробуйте открыть тест позже.';
    }
    case 'ATTEMPT_DAILY_LIMIT': {
      const availableAt = retryDate(payload.retryAt);
      return availableAt
        ? `Лимит новых попыток исчерпан. Следующая попытка будет доступна ${availableAt}.`
        : 'Сегодня использованы все 8 попыток по этому курсу. Попробуйте после полуночи.';
    }
    case 'ATTEMPT_NOT_FOUND':
      return 'Эта попытка больше не существует. Начните новую попытку.';
    case 'ATTEMPT_VARIANT_INVALID':
      return 'Вариант теста недоступен. Начните новую попытку или обратитесь к администратору.';
    case 'COURSE_CATALOG_MAINTENANCE':
      return 'Каталог курсов временно обновляется. Уже начатые тесты можно продолжить; новую попытку начните чуть позже.';
    case 'ATTEMPT_ALREADY_COMPLETED':
      return 'Попытка уже завершена. Обновите страницу, чтобы увидеть результат.';
    case 'ATTEMPT_EXPIRED':
      return 'Время теста истекло. Сервер завершил попытку без результата.';
    default:
      return status === 401
        ? 'Войдите, чтобы пройти тест.'
        : 'Не удалось открыть тест. Попробуйте позже.';
  }
}

async function readAttemptError(response: Response) {
  return (await readClientResponseJson<AttemptErrorPayload>(response)) ?? {};
}

function transportMessage(error: ConstructorParameters<typeof ClientRequestError>[0]) {
  return clientRequestMessage(
    new ClientRequestError(error),
    'Не удалось связаться с сервером. Ответы сохранены на устройстве.',
  );
}

export function QuizClient({ slug, title }: { slug: string; title: string }) {
  const router = useRouter();
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
        router.replace('/onboarding');
      }
    },
    [applyTerminalAttempt, router],
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
        setError(
          clientRequestMessage(
            requestError,
            'Не удалось подтвердить срок на сервере. Повторите проверку.',
          ),
        );
      } finally {
        checkingExpiryRef.current = false;
        if (mountedRef.current) setCheckingExpiry(false);
      }
    },
    [applyResponseError, applyTerminalAttempt],
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
          body: JSON.stringify({ testSlug: slug, startNew }),
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
        setError(
          clientRequestMessage(requestError, 'Не удалось загрузить тест. Попробуйте снова.'),
        );
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [applyResponseError, persistDraft, slug],
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
      setError('Сервер не вернул корректный срок теста. Обновите страницу.');
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
  }, [attempt, refreshAttemptStatus]);

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
      setSaveError(
        'Браузер не разрешил локальное сохранение. Не закрывайте страницу до отправки теста.',
      );
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
      setError(
        clientRequestMessage(
          requestError,
          'Не удалось отправить тест. Ответы сохранены; безопасно повторите отправку.',
        ),
      );
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  if (loading)
    return (
      <section className="py-16">
        <Container size="narrow">
          <p role="status" className="text-center text-sm text-[var(--color-text-muted)]">
            Загружаем тест…
          </p>
        </Container>
      </section>
    );

  if (!attempt) {
    const onboardingAction = errorCode === 'PROFILE_ONBOARDING_REQUIRED';
    return (
      <section className="py-16">
        <Container size="narrow">
          <Card>
            <CardContent className="space-y-4 p-6 text-center">
              <p role="alert">{error}</p>
              <div className="flex flex-wrap justify-center gap-3">
                {errorCode === 'UNAUTHENTICATED' ? (
                  <Button asChild>
                    <Link href="/auth/login">Войти</Link>
                  </Button>
                ) : onboardingAction ? (
                  <Button onClick={() => router.push('/onboarding')}>Заполнить профиль</Button>
                ) : errorCode === 'ATTEMPT_NOT_FOUND' ? (
                  <Button onClick={() => void loadAttempt(true)}>Начать новую попытку</Button>
                ) : (
                  <Button variant="outline" onClick={() => void loadAttempt(false)}>
                    Повторить
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
                    ? 'Тест пройден'
                    : expired
                      ? 'Время теста истекло'
                      : 'Порог пока не достигнут'}
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
                      {percent}% правильных ответов
                    </p>
                  </div>
                  <Progress value={percent ?? 0} className="h-3" />
                  {!attempt.certificateId ? (
                    <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-accent-amber-soft)] p-4 text-left">
                      <p className="font-bold">
                        {attempt.certificatePendingVerification
                          ? 'Результат ожидает проверки данных'
                          : 'Результат готов к выдаче сертификата'}
                      </p>
                      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                        Первая выдача выполняется администратором явно. Результат уже сохранён, а
                        повторное прохождение можно использовать, чтобы улучшить балл.
                      </p>
                    </div>
                  ) : null}
                  <div className="space-y-3 text-left">
                    <h2 className="font-display text-xl font-bold">Разбор ответов</h2>
                    {attempt.review.map((item, index) => {
                      const question = attempt.questions.find(
                        (candidate) => candidate.id === item.questionId,
                      );
                      const selected = question?.options.find(
                        (option) => option.id === item.selectedOptionId,
                      );
                      const correct = question?.options.find(
                        (option) => option.id === item.correctOptionId,
                      );
                      if (!question || !selected || !correct) return null;
                      return (
                        <article
                          key={item.questionId}
                          className="rounded-xl border border-[var(--color-border)] p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <h3 className="font-bold">
                              {index + 1}. {question.text}
                            </h3>
                            <span
                              className={`shrink-0 text-xs font-bold ${item.isCorrect ? 'text-[var(--color-primary)]' : 'text-[var(--color-danger)]'}`}
                            >
                              {item.isCorrect ? 'Верно' : 'Ошибка'}
                            </span>
                          </div>
                          <p className="mt-2 text-sm">
                            Ваш ответ: <strong>{selected.text}</strong>
                          </p>
                          {!item.isCorrect && (
                            <p className="mt-1 text-sm">
                              Правильный ответ: <strong>{correct.text}</strong>
                            </p>
                          )}
                          {item.explanation ? (
                            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                              {item.explanation}
                            </p>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </>
              ) : expired ? (
                <div className="space-y-2 border-y border-dashed border-[var(--color-border)] py-5">
                  <strong className="text-lg">Попытка завершена сервером</strong>
                  <p className="text-sm text-[var(--color-text-muted)]">
                    Отведённые {attempt.durationMinutes} мин. закончились. Балл и правильные
                    варианты не рассчитывались и не раскрываются.
                  </p>
                </div>
              ) : (
                <div className="space-y-3 border-y border-dashed border-[var(--color-border)] py-5">
                  <strong className="text-5xl tabular-nums">
                    {attempt.score ?? 0}/{attempt.total}
                  </strong>
                  <p className="text-sm text-[var(--color-text-muted)]">
                    Лучший балл сохранён в личном кабинете. Повторите материал курса перед новым
                    прохождением.
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
                  {expired
                    ? 'Начать новую попытку'
                    : passed
                      ? 'Улучшить результат'
                      : 'Пройти снова'}
                </Button>
                {attempt.certificateId ? (
                  <CertificateDownloadButton certificateId={attempt.certificateId} size="md">
                    Сертификат
                  </CertificateDownloadButton>
                ) : null}
                <Button onClick={() => router.push('/profile')}>Открыть аккаунт</Button>
              </div>
            </CardContent>
          </Card>
        </Container>
      </section>
    );
  }

  const timerText = remainingSeconds === null ? '--:--' : formatDeadlineSeconds(remainingSeconds);
  const allAnswered = answers.length === attempt.questions.length;
  if (reviewing) {
    return (
      <section className="py-8 md:py-16">
        <Container size="narrow">
          <Card className="border-2">
            <CardContent className="space-y-6 p-4 min-[320px]:p-5 md:p-8">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-[var(--color-primary)]">Перед отправкой</p>
                  <span
                    role="timer"
                    aria-label={`Осталось времени ${timerText}`}
                    className="rounded-full bg-[var(--color-surface-muted)] px-3 py-1 text-sm font-black tabular-nums"
                  >
                    {timerText}
                  </span>
                </div>
                <h1 className="font-display mt-1 text-2xl font-black">Проверьте ответы</h1>
                <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                  После подтверждения попытка будет завершена. Пока можно изменить любой выбор.
                </p>
              </div>
              {remainingSeconds === 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--color-accent-amber-soft)] p-3 text-sm">
                  <span>Время закончилось. Сервер должен подтвердить итоговый статус.</span>
                  <button
                    type="button"
                    className="min-h-11 font-bold text-[var(--color-primary)]"
                    disabled={checkingExpiry}
                    onClick={() => void refreshAttemptStatus(attempt.attemptId)}
                  >
                    {checkingExpiry ? 'Проверяем…' : 'Проверить'}
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
                        {selected ? `Выбрано: ${selected.text}` : 'Ответ не выбран'}
                      </p>
                      <button
                        type="button"
                        disabled={submissionLocked || submitting}
                        className="mt-2 min-h-11 text-sm font-bold text-[var(--color-primary)]"
                        onClick={() => navigateToQuestion(index)}
                      >
                        Изменить ответ
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
                Я проверил ответы и подтверждаю окончательную отправку.
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
                  Вернуться
                </Button>
                <Button
                  onClick={() => void submitAttempt()}
                  disabled={!allAnswered || !reviewConfirmed || submitting}
                >
                  {submitting
                    ? 'Отправляем…'
                    : submissionLocked
                      ? 'Повторить отправку'
                      : 'Подтвердить отправку'}
                  <CheckCircle size={18} />
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
  const progress = (answers.length / attempt.questions.length) * 100;
  const saveLabel =
    saveState === 'saved'
      ? 'Черновик сохранён на этом устройстве'
      : saveState === 'error'
        ? saveError
        : '';

  return (
    <section className="py-8 md:py-16">
      <Container size="narrow">
        <div className="mb-5 flex items-center justify-between gap-3">
          <Link
            href={`/topics/${slug}`}
            onClick={(event) => {
              if (
                localBackupFailedRef.current &&
                !window.confirm('Локальный черновик недоступен. Всё равно выйти?')
              ) {
                event.preventDefault();
              }
            }}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-[var(--color-text-muted)]"
          >
            <CaretLeft size={16} />К теме
          </Link>
          <div className="flex items-center gap-2">
            <span
              role="timer"
              aria-label={`Осталось времени ${timerText}`}
              className="rounded-full bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-black tabular-nums"
            >
              {timerText}
            </span>
            <span className="text-xs font-bold">
              {currentIndex + 1} / {attempt.questions.length}
            </span>
          </div>
        </div>
        {remainingSeconds === 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-[var(--color-accent-amber-soft)] p-3 text-sm">
            <span>Время на клиентском таймере закончилось. Подтверждаем статус на сервере.</span>
            <button
              type="button"
              className="min-h-11 shrink-0 font-bold text-[var(--color-primary)]"
              disabled={checkingExpiry}
              onClick={() => void refreshAttemptStatus(attempt.attemptId)}
            >
              {checkingExpiry ? 'Проверяем…' : 'Проверить'}
            </button>
          </div>
        )}
        <Progress value={progress} className="mb-4 h-3" />
        <nav aria-label="Вопросы теста" className="mb-7 flex justify-center gap-2">
          {attempt.questions.map((question, index) => {
            const answered = answers.some((answer) => answer.questionId === question.id);
            const current = index === currentIndex;
            return (
              <button
                key={question.id}
                type="button"
                aria-label={`Вопрос ${index + 1}${answered ? ', ответ выбран' : ''}`}
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
              <legend className="sr-only">Выберите ответ</legend>
              {currentQuestion.options.map((option) => {
                const selected = selectedOptionId === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectOption(currentQuestion.id, option.id)}
                    className={`flex min-h-12 w-full items-center gap-3 rounded-xl border-2 p-3 text-left text-sm font-semibold transition-colors ${selected ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]' : 'border-[var(--color-border)] hover:border-[var(--color-primary)]'}`}
                  >
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded-full border text-xs ${selected ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white' : 'border-[var(--color-border)]'}`}
                    >
                      {String.fromCharCode(64 + option.position)}
                    </span>
                    {option.text}
                  </button>
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
                    Повторить локальное сохранение
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
                Назад
              </Button>
              {currentIndex === attempt.questions.length - 1 ? (
                <Button onClick={openReview} disabled={!allAnswered}>
                  Проверить ответы
                  <CheckCircle size={18} />
                </Button>
              ) : (
                <Button
                  onClick={() => navigateToQuestion(currentIndex + 1)}
                  disabled={!selectedOptionId}
                >
                  Далее
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
