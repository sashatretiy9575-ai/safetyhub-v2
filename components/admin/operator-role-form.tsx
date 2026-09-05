'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from '@phosphor-icons/react/dist/csr/UserPlus';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const FAILURES: Record<string, string> = {
  USER_NOT_FOUND: 'Пользователь с таким адресом не найден. Он должен хотя бы раз войти на сайт.',
  TARGET_REJECTED: 'Заявка этого человека отклонена. Сначала пересмотрите решение в разделе «Заявки».',
  ACCOUNT_UNAVAILABLE: 'Аккаунт заблокирован или удаляется.',
  CANNOT_CHANGE_OWN_ROLE: 'Свои собственные права изменить нельзя.',
  LAST_ACTIVE_ADMIN_PROTECTED: 'Это последний администратор — снять права нельзя.',
  SUPERADMIN_DEMOTION_FORBIDDEN: 'У этого аккаунта основной доступ, снять его отсюда нельзя.',
  AUTH_REALM_INVALID: 'Этот аккаунт входит по логину и паролю, назначить его нельзя.',
  EMAIL_INVALID: 'Проверьте адрес почты.',
  ROLE_REASON_REQUIRED: 'Причина должна быть не короче 10 символов.',
};

export function OperatorRoleForm() {
  const router = useRouter();
  const idempotencyKey = useRef(crypto.randomUUID());
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      const result = await clientRequest('/api/admin/operators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          role: 'admin',
          reason: reason.trim(),
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const payload = await readClientResponseJson<{ error?: string; changed?: boolean }>(
        result.response,
      );
      if (!result.ok || !payload) {
        const known = payload?.error ? FAILURES[payload.error] : undefined;
        setFailed(true);
        setMessage(
          known ??
            (result.ok
              ? 'Сервер вернул неполный ответ.'
              : clientRequestMessage(result.error, 'Не удалось выдать права администратора.')),
        );
        return;
      }
      idempotencyKey.current = crypto.randomUUID();
      setEmail('');
      setReason('');
      setMessage(
        payload.changed === false
          ? 'Этот человек уже администратор.'
          : 'Готово: человек стал администратором.',
      );
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(clientRequestMessage(error, 'Не удалось выдать права администратора.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="operator-email">Почта нового администратора</Label>
        <Input
          id="operator-email"
          type="email"
          autoComplete="off"
          required
          maxLength={254}
          placeholder="ivan@company.kz"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="operator-reason">Причина (в журнал действий)</Label>
        <Textarea
          id="operator-reason"
          required
          minLength={10}
          maxLength={500}
          placeholder="Не менее 10 символов"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          <UserPlus aria-hidden />
          {busy ? 'Назначаем…' : 'Сделать администратором'}
        </Button>
        {message ? (
          <p
            role={failed ? 'alert' : 'status'}
            className={
              failed ? 'text-sm text-[var(--color-danger)]' : 'text-sm text-[var(--color-text-muted)]'
            }
          >
            {message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
