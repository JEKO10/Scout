import type { Post } from "@/db/schema";
import type { MeasuredVoice } from "@/lib/ai/schemas/scoutBrain";

export type PhraseFrequency = "rare" | "occasional" | "frequent";

const EMOJI = /\p{Extended_Pictographic}/u;
const LEADING_MENTIONS = /^(\s*@\w+)+\s*/;
const URLS = /https?:\/\/\S+/g;

type Writing = Pick<Post, "content">;

const isReply = (post: Writing) => post.content.trimStart().startsWith("@");
const ownText = (post: Writing) =>
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
export function measureVoice(
  posts: Writing[],
  // Onboarding voice samples are replies even without a leading @mention
  { allReplies = false }: { allReplies?: boolean } = {},
): MeasuredVoice {
  const share = (test: (post: Writing) => boolean) =>
    posts.length ? posts.filter(test).length / posts.length : 0;
  const reply = (post: Writing) => allReplies || isReply(post);
  const replies = posts.filter(reply);
  const originals = posts.filter((post) => !reply(post));

  return {
    postCount: posts.length,
    emojiShare: share((post) => EMOJI.test(post.content)),
    exclamationShare: share((post) => ownText(post).includes("!")),
    lowercaseStartShare: share((post) => /^[a-z]/.test(ownText(post))),
    replyShare: share(reply),
    medianPostLength: median(originals.map((post) => ownText(post).length)) ?? 0,
    medianReplyLength: median(replies.map((post) => ownText(post).length)),
  };
}

/** Same thresholds the Brain schema describes: <10%, 10–30%, >30%. */
export function phraseFrequency(phrase: string, posts: Writing[]): PhraseFrequency {
  if (posts.length === 0) return "rare";
  const needle = phrase.toLowerCase();
  const hits = posts.filter((post) => post.content.toLowerCase().includes(needle));
  const share = hits.length / posts.length;
  return share > 0.3 ? "frequent" : share >= 0.1 ? "occasional" : "rare";
}
