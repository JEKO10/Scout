import type { Post, Profile } from "@/db/schema";

export const SCOUT_BRAIN_INSTRUCTIONS = `You are building a "Scout Brain": a factual profile of one person, used later to find conversations on X they should join and to write replies that sound exactly like them.

You receive the person's onboarding answers and their recent X posts. Produce three parts:
- voice: how they write.
- interests: what they have something to say about.
- goals: what they are trying to achieve, mostly from onboarding.

Rules:
1. Separate evidence from assumption. Every topic and expertise item has an evidence label:
   - "observed": clearly visible in several posts.
   - "stated": comes from onboarding answers, not supported (yet) by posts.
   - "inferred": only hinted at. Use sparingly and with low confidence.
2. Do not inflate. One post about a subject is not an interest, and talking about a subject is not expertise. A single mention belongs in lowConfidenceTopics. Expertise needs specific depth, first-hand experience or results.
3. A "core" topic must be a main subject of the posts (roughly 15%+ of posts or clearly dominant). Everything else that recurs is "secondary".
4. Base voice only on the posts. Quote signature phrases exactly, in the original language. Never translate quotes.
5. Write all descriptions in English, even if the posts are in another language, and record the posting languages.
6. Only reference post IDs that appear in the provided list.
7. Be specific and concrete. Avoid generic filler like "engaging", "authentic", "insightful".
8. If there are few posts, say so through lower confidence instead of guessing.
9. Scout uses this brain to write replies in other people's conversations. Keep promotion apart from voice: calls to action, link pointers and subscription or sales boilerplate go in promotionalPatterns, never in signaturePhrases.
10. Operational posts (customer support, shipping, billing, checkout help, access announcements) inform replyStyle and promotionalPatterns only. They are not topics, opinions or expertise.
11. Judge low confidence at the level of subject areas, not individual items. If "military history" is a topic, a single post about Frederick the Great supports that topic; it is not a low-confidence topic.
12. Record perspective: whether the account speaks as a person ("I") or as an organization ("we").`;

const URL_PATTERN = /https?:\/\/\S+/g;

/** Posts that are nothing but a link carry no voice or interest signal. */
export function hasTextBeyondLinks(content: string): boolean {
  return content.replace(URL_PATTERN, "").trim().length > 0;
}

type PostForPrompt = Pick<Post, "platformPostId" | "content" | "publishedAt" | "metrics">;

export function buildScoutBrainInput(
  profile: Profile,
  posts: PostForPrompt[],
): string {
  const onboarding = {
    occupation: profile.occupation,
    bio: profile.bio,
    targetAudience: profile.targetAudience,
    primaryGoal: profile.primaryGoal,
    knownFor: profile.knownFor,
  };

  const postLines = posts.map((post) =>
    JSON.stringify({
      id: post.platformPostId,
      date: post.publishedAt.toISOString().slice(0, 10),
      type: post.content.trimStart().startsWith("@") ? "reply" : "post",
      likes: post.metrics?.likes ?? 0,
      text: post.content,
    }),
  );

  return [
    "## Onboarding answers",
    JSON.stringify(onboarding, null, 2),
    "",
    `## X posts (${posts.length}, newest first, one JSON object per line)`,
    ...postLines,
  ].join("\n");
}
