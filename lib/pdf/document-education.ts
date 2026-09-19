import type { DocumentFamily } from './document-profile';

/** Product requirement for a new issuance; never a condition for learning or historical downloads. */
export function requiresDocumentEducation(family: DocumentFamily | null | undefined): boolean {
  return family == null || family === 'general' || family === 'industrial';
}
