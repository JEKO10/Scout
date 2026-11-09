import type { XScanCursor } from "@/lib/scout/types";

// Incremental X reads by post ID. X returns a timeline newest first, so when
// more new posts exist than one scan reads, the older ones form a gap between
// the cursor and the oldest post read. The next scans fill that gap before
// moving on, so no post is skipped and none is read twice.

/** X post IDs are increasing 64-bit numbers; compare them as such. */
function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x > y ? 1 : x < y ? -1 : 0;
}

/** What to ask X for on this scan. Null cursor: first scan. */
export function cursorQuery(cursor: XScanCursor | null): {
  sinceId?: string;
  untilId?: string;
} {
  if (!cursor) return {};
  return { sinceId: cursor.sinceId, untilId: cursor.untilId };
}

/**
 * The cursor after a scan read `ids` (and X said whether more matched). Only
 * saved once the scan's candidates are stored, so a failed scan rereads.
 */
export function nextCursor(
  cursor: XScanCursor | null,
  ids: string[],
  hasMore: boolean,
): XScanCursor | null {
  const sorted = [...ids].sort(compareIds);
  const oldest = sorted[0];
  const newest = sorted.at(-1);

  // First scan: its limit is deliberate, older history is never fetched
  if (!cursor) return newest ? { sinceId: newest } : null;

  if (cursor.untilId) {
    // Filling a gap: keep going down, or close it once X has nothing more
    if (hasMore && oldest) return { ...cursor, untilId: oldest };
    return { sinceId: cursor.newestId ?? cursor.sinceId };
  }

  if (!newest) return cursor;
  // More new posts than one scan reads: the rest becomes a gap
  if (hasMore)
    return { sinceId: cursor.sinceId, untilId: oldest, newestId: newest };
  return { sinceId: newest };
}
