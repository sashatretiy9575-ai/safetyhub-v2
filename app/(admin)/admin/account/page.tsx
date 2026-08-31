export const dynamic = 'force-dynamic';

import { AdminAvatarUploader } from '@/features/profile/admin-avatar-uploader';
import { AccountDeletion } from '@/features/profile/account-deletion';
import { getProfileAvatarUrl } from '@/features/profile/server';
import { ProfileForm } from '@/features/auth/profile-form';
import { requireRole } from '@/features/auth/server';
import { PwaManualInstall } from '@/components/shared/pwa-manual-install';
import { Card, CardContent } from '@/components/ui/card';
import { phoneInputValueFromE164 } from '@/lib/phone';

export default async function AdminAccountPage() {
  const actor = await requireRole(['admin']);
  const avatarUrl = actor.profile.avatar_updated_at
    ? await getProfileAvatarUrl(actor.user.id)
    : null;
  const fullName = `${actor.profile.name} ${actor.profile.surname}`.trim() || 'Администратор';
  const initials = fullName
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Мой аккаунт</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Данные и фотография администратора без перехода в кабинет ученика.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-6 p-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:p-6">
          <AdminAvatarUploader
            initialUrl={avatarUrl}
            initials={initials || 'SH'}
          />
          <div className="min-w-0 space-y-4">
            <div>
              <h2 className="text-xl font-bold break-words">{fullName}</h2>
              <p className="text-sm text-[var(--color-text-muted)]">
                {actor.user.email ?? 'Email не указан'}
              </p>
            </div>
            <ProfileForm
              initial={{
                name: actor.profile.name,
                surname: actor.profile.surname,
                job: actor.profile.job,
                organization: actor.profile.organization,
                phone: phoneInputValueFromE164(
                  actor.profile.phone_country_iso2,
                  actor.profile.phone_e164,
                ),
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 p-5 sm:p-6">
          <div>
            <h2 className="text-xl font-bold">Настройки входа</h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              Вход выполняется одноразовым кодом, который приходит на email. Пароль не используется.
            </p>
          </div>
          <PwaManualInstall />
          <AccountDeletion />
        </CardContent>
      </Card>
    </div>
  );
}
