export type AttemptPayload = {
  attemptId: string;
  courseId: string;
  revisionId: string;
  testSlug: string;
  title: string;
  locale: 'ru' | 'kk' | 'en' | 'zh';
  status: 'started' | 'completed' | 'passed' | 'failed' | 'expired';
  score: number | null;
  total: number;
  passed: boolean | null;
  certificateId: string | null;
  certificatePendingVerification: boolean;
  durationMinutes: number;
  passScore: number;
  startedAt: string;
  expiresAt: string;
  serverNow: string;
  retryAt: string | null;
  questions: Array<{
    id: string;
    text: string;
    position: number;
    selectedOptionId: string | null;
    options: Array<{ id: string; text: string; position: number }>;
  }>;
};
