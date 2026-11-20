// Day 40: the pure parts of X publishing, shared by the service, the UI and
// the tests. No I/O.

import { X_PRICING } from "./pricing";

/**
 * Whether X will treat a post as containing a URL (billed at the link rate).
 * Deliberately generous: a bare domain X would link ("scout.ai") counts too,
 * so Scout never reserves less than X may charge.
 */
export function containsUrl(text: string): boolean {
  return /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|co|app|dev|me|xyz|so|gg|ly|to|tv|us|uk|eu|de|rs|info|biz|link|site|page)\b/i.test(text);
}

/** What X charges to publish this text: the amount reserved before the call */
export function publishCostUsd(text: string): number {
  return containsUrl(text) ? X_PRICING.postCreateWithUrl : X_PRICING.postCreate;
}

/**
 * Text as X may store it: links shortened to t.co, &, < and > escaped,
 * whitespace collapsed. Used to recognise our own post on the user's
 * timeline after X didn't answer.
 */
export function comparableText(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/https?:\/\/\S+/g, "<link>")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where to send the user back after granting publishing: Scout pages only, never an outside URL */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return /^\/(?:dashboard|calendar|account\/settings|studio(?:\/[0-9a-f-]{36})?)$/i.test(raw) ? raw : null;
}

export type PublicationStatus = "approved" | "scheduled" | "publishing" | "published" | "failed" | "unknown" | "cancelled";

/** What the user reads for each state (never "Published" before X confirmed it) */
export const PUBLICATION_LABEL: Record<PublicationStatus, string> = {
  approved: "Ready to publish",
  scheduled: "Scheduled",
  publishing: "Publishing…",
  published: "Published on X",
  failed: "Didn't publish",
  unknown: "Checking with X",
  cancelled: "Cancelled",
};

/** Scheduling bounds: not in the past, not further than X's tokens and plans sensibly reach */
export const SCHEDULE_LIMITS = { minAheadMinutes: 2, maxAheadDays: 60 } as const;

/** A scheduled post more than this late (publishing was paused, X was down) isn't published silently */
export const MAX_LATE_HOURS = 6;
