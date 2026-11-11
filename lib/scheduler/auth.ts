import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Scheduler requests carry `Authorization: Bearer <CRON_SECRET>`; Vercel Cron
 * sends exactly that when CRON_SECRET is set. The secret lives only in server
 * env vars. Without it the endpoint stays closed.
 */
export function isAuthorizedSchedulerRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  // Hashes have equal length, so the comparison takes the same time either way
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
