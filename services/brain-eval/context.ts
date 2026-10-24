import type { Post } from "@/db/schema";
import type {
  BrainItem,
  ResolvedScoutBrain,
} from "@/services/scout-brain/resolveBrain";

const labels = (items: BrainItem[]) => items.map((item) => item.label);
const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * The effective Scout Brain (user edits applied) as compact JSON for prompts.
 * Leaves out post IDs and metadata the model doesn't need.
 */
export function formatBrainForPrompt(brain: ResolvedScoutBrain): string {
  const { voice, interests, goals } = brain;

  return JSON.stringify(
    {
      voice: {
        summary: voice.summary,
        perspective: voice.perspective,
        languages: voice.languages,
        tone: labels(voice.tone),
        sentenceLength: voice.sentenceLength,
        directness: voice.directness,
        humor: voice.humor,
        vocabulary: voice.vocabulary,
        capitalization: voice.capitalization,
        emojiUsage: voice.emojiUsage,
        replyStyle: voice.replyStyle,
        signaturePhrases: voice.signaturePhrases.map((item) => ({
          phrase: item.label,
          frequency: item.detail,
        })),
        neverDo: labels(voice.avoid),
        promotionalPatternsToAvoid: voice.promotionalPatterns,
        // Counted from their posts, not estimated
        measuredHabits: voice.measured && {
          postsWithEmoji: percent(voice.measured.emojiShare),
          postsWithExclamation: percent(voice.measured.exclamationShare),
          postsStartingLowercase: percent(voice.measured.lowercaseStartShare),
          medianReplyLengthChars: voice.measured.medianReplyLength,
          medianPostLengthChars: voice.measured.medianPostLength,
        },
      },
      interests: {
        topics: interests.topics.map((topic) => ({
          name: topic.label,
          evidence: topic.evidence,
          detail: topic.detail,
        })),
        expertise: interests.expertise,
        opinions: interests.opinions.map(({ topic, statement }) => ({ topic, statement })),
        recurringThemes: labels(interests.recurringThemes),
        lowConfidenceTopics: interests.lowConfidenceTopics.map((topic) => topic.name),
      },
      goals: {
        primaryGoal: goals.primaryGoal,
        occupation: goals.occupation,
        targetAudience: labels(goals.targetAudience),
        knownFor: labels(goals.knownFor),
        desiredPositioning: goals.desiredPositioning,
      },
    },
    null,
    2,
  );
}

const EMOJI = /\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️)*/gu;

/** The emoji this person actually uses, most used first. */
export function topEmojis(posts: Post[], count = 3): string[] {
  const tally = new Map<string, number>();
  for (const post of posts) {
    for (const emoji of new Set(post.content.match(EMOJI) ?? [])) {
      tally.set(emoji, (tally.get(emoji) ?? 0) + 1);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([emoji]) => emoji);
}

const STOPWORDS = new Set(
  "about after again also among been before being between both could does doing during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very were what when where which while with would your".split(
    " ",
  ),
);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
  );
}

/**
 * The user's own posts most related to `text`, by shared keywords, as voice
 * examples. Falls back to the best-performing posts when nothing overlaps.
 */
export function pickRelevantPosts(
  posts: Post[],
  text: string,
  count = 4,
): Post[] {
  const target = keywords(text);

  return posts
    .map((post) => {
      let overlap = 0;
      for (const word of keywords(post.content)) if (target.has(word)) overlap++;
      return { post, overlap, likes: post.metrics?.likes ?? 0 };
    })
    .sort((a, b) => b.overlap - a.overlap || b.likes - a.likes)
    .slice(0, count)
    .map(({ post }) => post);
}
