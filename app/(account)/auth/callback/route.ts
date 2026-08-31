// Keep this retired endpoint under `/auth` so every installed service-worker
// version bypasses it. Its shared handler discards old callback state without
// exchanging an Auth code or creating a session.
export { GET } from '../../callback/route';
