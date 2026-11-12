// Reply on X (Day 21): the user posts the reply themselves, in X's own
// composer, opened through X's official Web Intent. Scout never posts.
// Documented format: https://x.com/intent/tweet?in_reply_to=<post id>&text=<text>
// (docs.x.com/x-for-websites/post-button/guides/web-intent). Pure: no I/O.

export const X_REPLY_LIMIT = 280;
/** X counts every link as this many characters (t.co wrapping) */
const X_URL_LENGTH = 23;
const URL_PATTERN = /\bhttps?:\/\/[^\s]+/gi;

/** X post IDs are positive integers (snowflakes), sent as strings. */
export function isXPostId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^[1-9]\d{0,19}$/.test(id);
}

/** What gets posted: Unicode-normalized, Windows line breaks unified, trimmed. */
export function normalizeReplyText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

// X's weighting: most Latin and common punctuation count 1, everything else
// (CJK, emoji…) counts 2; a link counts 23 whatever its length.
const LIGHT_RANGES: [number, number][] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function graphemeWeight(grapheme: string): number {
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0) ?? 0;
  return LIGHT_RANGES.some(([from, to]) => code >= from && code <= to) ? 1 : 2;
}

/** Length as X counts it toward the 280 limit. */
export function xWeightedLength(text: string): number {
  const normalized = normalizeReplyText(text);
  let length = 0;
  let rest = normalized;
  for (const url of normalized.match(URL_PATTERN) ?? []) {
    length += X_URL_LENGTH;
    rest = rest.replace(url, "");
  }
  for (const { segment } of segmenter.segment(rest)) length += graphemeWeight(segment);
  return length;
}

export type ReplyCheck = { ok: true; length: number } | { ok: false; length: number; error: string };

export function checkReplyText(text: string): ReplyCheck {
  const length = xWeightedLength(text);
  if (!normalizeReplyText(text)) return { ok: false, length, error: "Write a reply first." };
  if (length > X_REPLY_LIMIT) {
    return { ok: false, length, error: `X allows ${X_REPLY_LIMIT} characters; this is ${length}.` };
  }
  return { ok: true, length };
}

/** The X composer, prefilled with `text` as a reply to `postId`; null when invalid. */
export function replyIntentUrl(postId: string, text: string): string | null {
  if (!isXPostId(postId) || !checkReplyText(text).ok) return null;
  const params = new URLSearchParams({ in_reply_to: postId, text: normalizeReplyText(text) });
  return `https://x.com/intent/tweet?${params.toString()}`;
}
