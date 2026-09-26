import { requireUser } from '@/server/auth/session';
import {
  CERTIFICATE_IMAGE_KINDS,
  certificateImageDataUrl,
  decodeCertificateImage,
  readCertificateImagesCached,
  withImagesSchema,
} from '@/server/certificates/settings';
import { readArchivedDocumentSettings } from '@/server/certificates/document-profiles';
import { createAdminClient } from '@/server/supabase/admin';
import { createApiResponse } from '@/lib/security/api-response';
import type { AdminCapability } from '@/lib/security/capabilities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Capabilities whose holders render or configure other people's documents. */
const DOCUMENT_CAPABILITIES: readonly AdminCapability[] = ['site.settings.manage', 'certificate.read', 'certificate.issue'];

function notFound() {
  return createApiResponse(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
}

/**
 * Whether a learner holds a certificate drawn with this settings version. A
 * certificate carries the version it was issued under in its snapshot; one
 * issued before snapshots existed is drawn with the current settings.
 */
async function ownsCertificateWithVersion(userId: string, version: number, isCurrent: boolean) {
  const client = createAdminClient();
  const [snapshotted, legacy] = await Promise.all([
    client
      .from('certificates')
      .select('id')
      .eq('user_id', userId)
      .contains('document_snapshot', { settings: { version } })
      .limit(1),
    isCurrent
      ? client.from('certificates').select('id').eq('user_id', userId).is('document_snapshot', null).limit(1)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);
  if (snapshotted.error || legacy.error) return false;
  return Boolean(snapshotted.data?.length || legacy.data?.length);
}

/**
 * The stamp and signature PNGs the administrator uploaded, drawn onto every
 * certificate. Sign-up is open, so a session alone is not enough: an
 * administrator who works with documents reads any version, and a learner
 * reads only the version printed on a certificate of their own — which is
 * exactly what rendering that certificate in the browser needs. `v` is the
 * settings version, so a browser never reuses an image from before the
 * administrator replaced it.
 */
export async function GET(request: Request) {
  let auth;
  try {
    auth = await requireUser({ enforceLegal: false });
  } catch {
    return createApiResponse(null, {
      status: 401,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  const url = new URL(request.url);
  const kind = CERTIFICATE_IMAGE_KINDS.find((value) => value === url.searchParams.get('kind'));
  const version = url.searchParams.get('v') ?? '';
  if (!kind || !/^[0-9]{1,12}$/u.test(version)) return notFound();
  try {
    const currentSettings = await readCertificateImagesCached();
    const isCurrent = String(currentSettings.version) === version;
    const privileged = DOCUMENT_CAPABILITIES.some((capability) =>
      auth.capabilities.includes(capability),
    );
    if (!privileged && !(await ownsCertificateWithVersion(auth.user.id, Number(version), isCurrent))) {
      return notFound();
    }
    const archived = isCurrent ? currentSettings : await readArchivedDocumentSettings(Number(version));
    const parsed = withImagesSchema.safeParse(archived);
    if (!parsed.success) return notFound();
    const bytes = decodeCertificateImage(certificateImageDataUrl(parsed.data, kind));
    if (!bytes) return notFound();
    // Archived versions resolve their own bytes. Never serve a newer signature
    // under an earlier version's immutable URL.
    return createApiResponse(Buffer.from(bytes), {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.byteLength),
        // Under its own version the bytes never change.
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return createApiResponse(null, { status: 503, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
