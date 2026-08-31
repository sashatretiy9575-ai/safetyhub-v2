// Keep auth callbacks under `/auth` so every installed service-worker version
// bypasses them. The legacy `/callback` route remains available for links that
// were already sent before this route was introduced.
export { GET } from '../../callback/route';
