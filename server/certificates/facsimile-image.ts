import 'server-only';

// The pipeline itself lives in a file plain Node can import; routes keep importing this one.
export {
  DOCUMENT_ASSET_MAX_BYTES,
  FACSIMILE_UPLOAD_MAX_BYTES,
  normalizeFacsimile,
} from './facsimile-normalize.ts';
