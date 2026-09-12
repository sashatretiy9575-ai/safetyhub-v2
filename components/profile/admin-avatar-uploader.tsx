'use client';

import { useRouter } from 'next/navigation';
import { AvatarUploader } from '@/components/profile/avatar-uploader';

export function AdminAvatarUploader({
  initialUrl,
  initials,
}: {
  initialUrl: string | null;
  initials: string;
}) {
  const router = useRouter();

  return (
    <AvatarUploader
      initialUrl={initialUrl}
      initials={initials}
      compact
      onUploaded={() => router.refresh()}
    />
  );
}
