import "server-only";

import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import { countActiveWatchlist } from "@/db/queries/watchlist";
import type { Profile } from "@/db/schema";
import { hasRequiredAnswers, type OnboardingFacts, type OnboardingMode } from "@/lib/onboarding/progress";
import { hasTextBeyondLinks } from "@/services/scout-brain/prompt";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

/** Posts needed to offer "Learn from my posts" (analyzeUser itself needs 5) */
export const ENOUGH_POSTS = 20;

/** What the user has saved so far: the only source of onboarding progress. */
export async function getOnboardingFacts(
  profile: Profile,
  { mode }: { mode?: OnboardingMode } = {},
): Promise<OnboardingFacts & { usablePosts: number }> {
  const [posts, samples, activeAccounts] = await Promise.all([
    getRecentPostsForProfile(profile.id, 100),
    getVoiceSamples(profile.id),
    countActiveWatchlist(profile.id),
  ]);
  const usablePosts = posts.filter((post) => hasTextBeyondLinks(post.content)).length;
  return {
    completed: profile.onboardingCompleted,
    started: Boolean(profile.xHandle || profile.occupation || profile.displayName || profile.topics),
    answered: hasRequiredAnswers(profile),
    // The path the user picked (in the URL) wins; otherwise what their data allows
    mode: mode ?? (usablePosts >= ENOUGH_POSTS ? "posts" : "scratch"),
    voiceSamples: samples.filter((sample) => sample.source === "onboarding").length,
    hasBrain: resolveScoutBrain(profile) !== null,
    activeAccounts,
    usablePosts,
  };
}
