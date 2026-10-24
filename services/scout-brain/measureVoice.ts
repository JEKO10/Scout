import type { Post } from "@/db/schema";
import type { MeasuredVoice } from "@/lib/ai/schemas/scoutBrain";

export type PhraseFrequency = "rare" | "occasional" | "frequent";

const EMOJI = /\p{Extended_Pictographic}/u;
const LEADING_MENTIONS = /^(\s*@\w+)+\s*/;
const URLS = /https?:\/\/\S+/g;

const isReply = (post: Post) => post.content.trimStart().startsWith("@");
const ownText = (post: Post) =>
  post.content.replace(LEADING_MENTIONS, "").replace(URLS, "").trim();

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Style habits counted in code. LLMs are bad at counting ("rare" for an emoji
 * in 13% of posts), and these numbers decide how often replies use each habit.
 */
export function measureVoice(posts: Post[]): MeasuredVoice {
  const share = (test: (post: Post) => boolean) =>
    posts.length ? posts.filter(test).length / posts.length : 0;
  const replies = posts.filter(isReply);
  const originals = posts.filter((post) => !isReply(post));

  return {
    postCount: posts.length,
    emojiShare: share((post) => EMOJI.test(post.content)),
    exclamationShare: share((post) => ownText(post).includes("!")),
    lowercaseStartShare: share((post) => /^[a-z]/.test(ownText(post))),
    replyShare: share(isReply),
    medianPostLength: median(originals.map((post) => ownText(post).length)) ?? 0,
    medianReplyLength: median(replies.map((post) => ownText(post).length)),
  };
}

/** Same thresholds the Brain schema describes: <10%, 10–30%, >30%. */
export function phraseFrequency(phrase: string, posts: Post[]): PhraseFrequency {
  if (posts.length === 0) return "rare";
  const needle = phrase.toLowerCase();
  const hits = posts.filter((post) => post.content.toLowerCase().includes(needle));
  const share = hits.length / posts.length;
  return share > 0.3 ? "frequent" : share >= 0.1 ? "occasional" : "rare";
}
