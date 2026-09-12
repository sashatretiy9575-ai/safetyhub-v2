import { apiError } from '@/features/auth/api-error';
import { getSiteUrl, requireCapability } from '@/features/auth/server';
import {
  CERTIFICATE_METADATA_MAX_BYTES,
  createBoundedCertificateMetadataResponse,
} from '@/features/certificates/metadata-response';
import { loadCertificateBranding } from '@/features/certificates/settings';
import {
  certificateVerificationUrl,
  createCertificateVerificationToken,
} from '@/lib/certificates/verification';
import { certificateFilename } from '@/lib/pdf/certificate';
import {
  CERTIFICATE_CLIENT_SCHEMA_VERSION,
  type CertificateRenderMetadata,
} from '@/lib/pdf/certificate-client-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A certificate for a fictitious person, drawn with the settings as they are
 * saved now, so the administrator can see the booklet before issuing anyone's.
 * The verification link points at a token that verifies nothing.
 */
export async function GET() {
  try {
    await requireCapability('site.settings.manage');
    const branding = await loadCertificateBranding();
    const issuedAt = new Date();
    const metadata: CertificateRenderMetadata = {
      schemaVersion: CERTIFICATE_CLIENT_SCHEMA_VERSION,
      certificateId: '00000000-0000-4000-8000-000000000000',
      filename: certificateFilename('SH-ОБРАЗЕЦ', 'Образец удостоверения'),
      locale: 'ru',
      templateVersion: 1,
      titleSnapshot: 'Безопасность и охрана труда',
      templateUrl: '/certificates/template-v1.pdf',
      fontUrl: '/certificate-assets/font?locale=ru&v=1',
      fullName: 'Иванов Иван Иванович',
      position: 'Инженер по охране труда',
      organization: 'ТОО «Пример»',
      score: 10,
      total: 10,
      passScore: 7,
      certificateNumber: 'SH-2026-000000000000',
      completedAt: issuedAt.toISOString(),
      issuedAt: issuedAt.toISOString(),
      // A real-looking link to a certificate that does not exist.
      verificationUrl: certificateVerificationUrl(
        getSiteUrl(),
        createCertificateVerificationToken('00000000-0000-4000-8000-000000000000'),
      ),
      branding,
    };
    return createBoundedCertificateMetadataResponse(metadata, CERTIFICATE_METADATA_MAX_BYTES);
  } catch (error) {
    return apiError(error);
  }
}
