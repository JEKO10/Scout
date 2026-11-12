/**
 * Scout's public origin, for links that leave the app (Slack messages, the
 * Slack OAuth redirect). APP_URL wins; on Vercel the production domain is the
 * fallback, locally localhost.
 */
export function appUrl(): string {
  const explicit = process.env.APP_URL?.replace(/\/+$/, "");
  if (explicit) return explicit;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return "http://localhost:3000";
}
