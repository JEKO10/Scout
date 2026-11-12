import { getMissCandidates } from "@/db/queries/missedPosts";
import type { Profile } from "@/db/schema";
import { postExcerpt } from "@/lib/notifications/slackMessage";
import { MISSED_POSTS, selectMissedPosts } from "@/lib/scout/missedPosts";
import { surfaceThreshold } from "@/lib/scout/sensitivity";

import { MissedPostsReview } from "./MissedPostsReview";

/**
 * Dashboard: "Did we miss this?" Up to three posts a day that Scout scored
 * but didn't surface. Renders nothing when there's nothing to ask.
 */
export async function MissedPosts({ profile }: { profile: Pick<Profile, "id" | "opportunitySensitivity"> }) {
  const now = new Date();
  const startOfDay = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const candidates = await getMissCandidates(profile.id, { days: MISSED_POSTS.maxAgeDays, ratedSince: startOfDay });
  const picked = selectMissedPosts(candidates, {
    threshold: surfaceThreshold(profile.opportunitySensitivity),
    seed: profile.id,
    now,
  });
  if (picked.length === 0) return null;

  return (
    <MissedPostsReview
      items={picked.map((post) => ({
        id: post.id,
        author: post.authorHandle,
        // Scores stay hidden: the rating should be the user's own, not anchored on Scout's
        excerpt: postExcerpt(post.content).excerpt,
        url: post.url,
        sample: post.sample,
      }))}
    />
  );
}
