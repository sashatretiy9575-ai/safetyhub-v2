import 'server-only';

import { CERTIFICATE_IMAGE_MAX_BYTES } from '@/server/certificates/settings';
import { normalizeFacsimile } from './facsimile-normalize.ts';

// The pipeline itself lives in a file plain Node can import; routes keep importing this one.
export {
  DOCUMENT_ASSET_MAX_BYTES,
  FACSIMILE_UPLOAD_MAX_BYTES,
  normalizeFacsimile,
} from './facsimile-normalize.ts';

/** An image of the settings row: it is stored inline, so it keeps the legacy 400 KB. */
export function normalizeFacsimilePng(bytes: Uint8Array): Promise<Uint8Array | null> {
  return normalizeFacsimile(bytes, { maxBytes: CERTIFICATE_IMAGE_MAX_BYTES });
}
