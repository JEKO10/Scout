// Day 31 Content Studio: options, limits and X character counting. Pure.

export const CONTENT_GOALS = ["grow_audience", "build_authority", "generate_leads", "start_conversations", "educate", "promote_product"] as const;
export type ContentGoal = (typeof CONTENT_GOALS)[number];
export const GOAL_LABEL: Record<ContentGoal, string> = {
  grow_audience: "Grow audience",
  build_authority: "Build authority",
  generate_leads: "Generate leads",
  start_conversations: "Start conversations",
  educate: "Educate audience",
  promote_product: "Promote product",
};

export const CONTENT_FORMATS = ["post", "thread"] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const CONTENT_TONES = ["professional", "conversational", "bold", "educational"] as const;
export type ContentTone = (typeof CONTENT_TONES)[number];

export const CONTENT_LENGTHS = ["short", "medium", "long"] as const;
export type ContentLength = (typeof CONTENT_LENGTHS)[number];

export const DRAFT_STATUSES = ["draft", "ready"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Edits that rewrite one post only, never the whole draft */
export const SECTION_ACTIONS = ["hook", "shorten", "expand", "clarity", "alternative", "tone"] as const;
export type SectionAction = (typeof SECTION_ACTIONS)[number];

export const X_POST_LIMIT = 280;
export const MAX_THREAD_POSTS = 15;
/** Stored text per post: generous for X Premium long posts, bounded for storage */
export const MAX_POST_CHARS = 4000;

const URL = /https?:\/\/\S+/g;

/**
 * Characters as X counts them for the 280 limit: every link counts as 23,
 * and most emoji and CJK characters count as 2.
 */
export function countXChars(text: string): number {
  let count = 0;
  const withoutUrls = text.replace(URL, () => {
    count += 23;
    return "";
  });
  for (const char of withoutUrls) {
    const code = char.codePointAt(0)!;
    // Latin, punctuation and common symbols weigh 1; everything else 2 (X's weighted counting)
    count += code <= 0x10ff || (code >= 0x2000 && code <= 0x200d) || (code >= 0x2010 && code <= 0x201f) || (code >= 0x2032 && code <= 0x2037) ? 1 : 2;
  }
  return count;
}

export type IdeaSuggestion = {
  hook: string;
  description: string;
  format: ContentFormat;
  audience: string;
  why: string;
};

export type ContentReview = {
  assessment: string;
  improvements: string[];
  revised: string[] | null;
};

/** X's own composer, prefilled; the user still has to post */
export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
