// Day 40.1: how long Scout keeps other people's X content, and what is shown
// instead once it's gone. Pure, shared by cleanup, the UI and the tests.

/**
 * Days after a post was published that Scout keeps its text (and AI text
 * written about it). After that, only the post's ID and link remain, which X
 * allows developers to keep. Shorter windows mean less content that can go
 * stale after a deletion on X that Scout doesn't learn about.
 */
export const THIRD_PARTY_RETENTION_DAYS = {
  /** Posts Scout read from watched accounts and searches, per user */
  candidates: 30,
  /** Opportunities (conversations worth joining) */
  opportunities: 30,
  /** Leads: the user's CRM keeps the lead, the post text goes after this */
  leads: 90,
  /** Snippets of posts in automation notifications and review items */
  automationSnippets: 30,
  /** Posts imported from CSV files (testing) */
  imported: 30,
} as const;

/** Product analytics events (no content, pseudonymous profile ID) */
export const ANALYTICS_RETENTION_DAYS = 400;

/** Account deletion records that finished (kept to block re-creation, then dropped) */
export const DELETION_RECORD_DAYS = 30;

/** Rows changed per table per cleanup pass: cleanup never holds a table for long */
export const RETENTION_BATCH = 1_000;

export const REMOVED_POST_TEXT = "This post is no longer stored in Scout.";

/** A stored post's text, or the notice shown once it was removed */
export function storedPostText(text: string | null | undefined): string {
  return text && text.trim() ? text : REMOVED_POST_TEXT;
}
