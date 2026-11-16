// Day 26 Smart Discovery: turning a topic's plain keywords into an X recent
// search query. Users never write X operators; anything that looks like one
// is stripped, so a keyword can only ever be a word or phrase to match.

export const MAX_KEYWORDS = 8;
export const MAX_EXCLUDED = 8;
export const MAX_KEYWORD_LENGTH = 40;
/** X's limit for a recent search query on pay-per-use access */
export const MAX_QUERY_LENGTH = 512;

/** A keyword as X will see it: letters, numbers, spaces and a few symbols; no operators */
export function cleanKeyword(raw: string): string {
  return raw
    .replace(/[^\p{L}\p{N}\s#$@&'._-]/gu, " ") // quotes, colons, brackets: operator syntax
    .replace(/^[-\s]+/, "") // a leading minus would exclude instead of match
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(or|and)$/i, "") // bare boolean words
    .slice(0, MAX_KEYWORD_LENGTH)
    .trim();
}

/** Cleaned, de-duplicated (case-insensitive), at most `max` */
export function cleanKeywords(list: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const keyword = cleanKeyword(raw);
    const key = keyword.toLowerCase();
    if (!keyword || seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length === max) break;
  }
  return out;
}

const term = (keyword: string) => (/\s/.test(keyword) ? `"${keyword}"` : keyword);

/** X language codes for the languages a Scout Brain may list */
const LANGUAGE_CODES: Record<string, string> = {
  english: "en",
  spanish: "es",
  german: "de",
  french: "fr",
  portuguese: "pt",
  italian: "it",
  dutch: "nl",
  serbian: "sr",
  croatian: "hr",
};

export function languageCode(languages: string[] | undefined): string | null {
  // Only with exactly one known language: otherwise search everything
  if (!languages || languages.length !== 1) return null;
  return LANGUAGE_CODES[languages[0].toLowerCase()] ?? null;
}

/**
 * Original posts (no reposts, replies or quotes: X bills every post it
 * returns, and those would be turned down by the candidate filters anyway)
 * matching any keyword and none of the excluded ones.
 */
export function buildSearchQuery(
  topic: { keywords: string[]; excludedKeywords: string[] },
  { language = null }: { language?: string | null } = {},
): string | null {
  const keywords = cleanKeywords(topic.keywords, MAX_KEYWORDS);
  if (keywords.length === 0) return null;
  const excluded = cleanKeywords(topic.excludedKeywords, MAX_EXCLUDED);
  const suffix = [
    ...excluded.map((keyword) => `-${term(keyword)}`),
    "-is:retweet",
    "-is:reply",
    "-is:quote",
    ...(language ? [`lang:${language}`] : []),
  ].join(" ");

  // Drop keywords from the end until the query fits X's limit
  for (let n = keywords.length; n > 0; n--) {
    const query = `(${keywords.slice(0, n).map(term).join(" OR ")}) ${suffix}`;
    if (query.length <= MAX_QUERY_LENGTH) return query;
  }
  return null;
}
