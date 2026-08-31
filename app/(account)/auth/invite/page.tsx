'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';

type InviteCredentials = {
  ticket: string;
  accessToken: string;
  refreshToken: string;
};

export default function InvitePasswordPage() {
  const router = useRouter();
  const credentials = useRef<InviteCredentials | null>(null);
  const started = useRef(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [canRetry, setCanRetry] = useState(false);

  const activate = useCallback(async () => {
    if (!credentials.current) {
      setBusy(false);
      setCanRetry(false);
      setError('Ссылка приглашения неполная или устарела.');
      return;
    }
    setBusy(true);
    setError('');
    setCanRetry(false);
    try {
      const result = await clientRequest('/api/auth/password/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials.current),
      });
      const payload = await readClientResponseJson<{ error?: string }>(result.response);
      if (!result.ok) {
        setError(
          result.error.kind === 'http' && !result.error.retryable
            ? 'Ссылка приглашения уже использована или устарела.'
            : clientRequestMessage(result.error, 'Не удалось проверить приглашение.'),
        );
        if (payload?.error === 'INVITE_CONTEXT_INVALID') {
          credentials.current = null;
        } else {
          setCanRetry(true);
        }
        return;
      }
      router.replace('/auth/update-password');
      router.refresh();
    } catch (requestError) {
      setCanRetry(true);
      setError(clientRequestMessage(requestError, 'Не удалось проверить приглашение.'));
    } finally {
      setBusy(false);
    }
  }, [router]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const query = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const ticket = query.get('ticket');
    const accessToken = fragment.get('access_token');
    const refreshToken = fragment.get('refresh_token');
    window.history.replaceState(window.history.state, '', '/auth/invite');
    if (ticket && accessToken && refreshToken) {
      credentials.current = { ticket, accessToken, refreshToken };
    }
    void activate();
  }, [activate]);

  return (
    <section className="py-10 md:py-20">
      <Container size="narrow">
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-5 p-4 min-[320px]:p-6 md:p-8">
            <h1 className="font-display text-2xl font-bold">Приглашение SafetyHub</h1>
            {busy ? (
              <p role="status" className="text-sm text-[var(--color-text-muted)]">
                Проверяем одноразовое приглашение...
              </p>
            ) : error ? (
              <div className="space-y-4">
                <p role="alert" className="text-sm text-[var(--color-danger)]">
                  {error}
                </p>
                {canRetry ? (
                  <Button type="button" onClick={() => void activate()}>
                    Повторить проверку
                  </Button>
                ) : (
                  <Button asChild variant="outline">
                    <Link href="/auth/login">Вернуться ко входу</Link>
                  </Button>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
