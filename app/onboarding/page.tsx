import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { type OnboardingMode, saveOnboardingAnswersAction } from "@/actions/onboarding";
import { BuildBrainStep } from "@/components/onboarding/BuildBrainStep";
import { ConnectXStep } from "@/components/onboarding/ConnectXStep";
import { SuggestedWatchlist } from "@/components/onboarding/SuggestedWatchlist";
import { VoiceCalibration } from "@/components/onboarding/VoiceCalibration";
import { ProfileForm } from "@/components/ProfileForm";
import { getRecentPostsForProfile } from "@/db/queries/posts";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import { getWatchlist } from "@/db/queries/watchlist";
import type { Profile } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";
import { pickCalibrationPosts } from "@/lib/onboarding/calibrationPosts";
import { PRESELECTED, suggestAccounts } from "@/lib/onboarding/suggestedAccounts";
import { hasTextBeyondLinks } from "@/services/scout-brain/prompt";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

/** Posts needed to offer "Learn from my posts" (analyzeUser itself needs 5) */
const ENOUGH_POSTS = 20;

type Step = "mode" | "answers" | "voice" | "brain" | "watchlist";

const STEPS: Record<OnboardingMode, Step[]> = {
  posts: ["mode", "answers", "brain", "watchlist"],
  scratch: ["mode", "answers", "voice", "brain", "watchlist"],
};

const headings: Record<Step, { title: string; lede: string }> = {
  mode: { title: "Let's find your posts.", lede: "If you have posts on X, Scout learns from them. If not, you can start from scratch." },
  answers: { title: "Tell Scout about you.", lede: "Your goals and topics shape every match." },
  voice: { title: "Show Scout how you write.", lede: "Three short replies teach Scout your voice better than any description." },
  brain: { title: "Build your Scout Brain.", lede: "Who you are, what you know and what you want." },
  watchlist: { title: "Who should Scout follow?", lede: "Pick a few accounts to start. Scout scans their posts for conversations worth joining." },
};

export default function OnboardingPage(props: PageProps<"/onboarding">) {
  return (
    <main className="onboarding-page">
      <div className="onboarding-nav shell">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>Scout</span>
        </Link>
        <span>Profile setup</span>
      </div>
      <div className="onboarding-shell enter-content">
        <Suspense fallback={<div className="skeleton skeleton-settings" />}>
          <Onboarding searchParams={props.searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function Onboarding({
  searchParams,
}: {
  searchParams: PageProps<"/onboarding">["searchParams"];
}) {
  const { profile } = await requireProfile();
  const params = await searchParams;
  const requestedStep = typeof params.step === "string" ? (params.step as Step) : null;
  // A finished user only sees onboarding when re-running it on purpose (?step=)
  if (profile.onboardingCompleted && !requestedStep) redirect("/dashboard");

  const mode: OnboardingMode = params.mode === "posts" ? "posts" : "scratch";
  const steps = STEPS[mode];
  const step: Step = requestedStep && steps.includes(requestedStep) ? requestedStep : "mode";
  const stepHref = (next: Step) => `/onboarding?step=${next}&mode=${mode}`;
  const heading = headings[step];

  return (
    <>
      <div className="onboarding-heading">
        <p className="eyebrow">
          Step {steps.indexOf(step) + 1} of {steps.length}
        </p>
        <h1>{heading.title}</h1>
        <p>{heading.lede}</p>
      </div>
      {step === "mode" && <ConnectStep profile={profile} />}
      {step === "answers" && (
        <ProfileForm
          profile={profile}
          action={saveOnboardingAnswersAction.bind(null, mode)}
          title="About you"
          description="Scout uses these answers to understand your expertise, audience, goals and voice."
          submitLabel="Continue"
        />
      )}
      {step === "voice" && <VoiceStep profile={profile} nextHref={stepHref("brain")} />}
      {step === "brain" && <BrainStep profile={profile} mode={mode} nextHref={stepHref("watchlist")} />}
      {step === "watchlist" && <WatchlistStep profile={profile} />}
    </>
  );
}

async function ConnectStep({ profile }: { profile: Profile }) {
  const posts = (await getRecentPostsForProfile(profile.id, 100)).filter((post) =>
    hasTextBeyondLinks(post.content),
  );
  return (
    <ConnectXStep
      handle={profile.xHandle}
      postCount={posts.length}
      enoughPosts={ENOUGH_POSTS}
    />
  );
}

async function VoiceStep({ profile, nextHref }: { profile: Profile; nextHref: string }) {
  const profileText = [
    profile.topics,
    profile.knownFor,
    profile.occupation,
    profile.targetAudience,
    profile.primaryGoal,
  ].join(" ");
  const posts = pickCalibrationPosts(profileText);
  const existing = await getVoiceSamples(profile.id);
  const initialReplies = posts.map(
    (post) => existing.find((sample) => sample.promptPost === post.text)?.userReply ?? "",
  );
  return <VoiceCalibration posts={posts} initialReplies={initialReplies} nextHref={nextHref} />;
}

async function BrainStep({
  profile,
  mode,
  nextHref,
}: {
  profile: Profile;
  mode: OnboardingMode;
  nextHref: string;
}) {
  const sources =
    mode === "posts"
      ? ["Your X posts (voice, topics, opinions)", "Your answers (goals, audience)"]
      : [
          "Your answers (topics, goals, audience, tone)",
          `${(await getVoiceSamples(profile.id)).length} calibration replies you wrote`,
        ];
  return <BuildBrainStep mode={mode} sources={sources} nextHref={nextHref} />;
}

async function WatchlistStep({ profile }: { profile: Profile }) {
  const brain = resolveScoutBrain(profile);
  const interestText = [
    profile.topics,
    profile.knownFor,
    profile.occupation,
    profile.targetAudience,
    ...(brain?.interests.topics.map((topic) => topic.label) ?? []),
    ...(brain?.interests.recurringThemes.map((theme) => theme.label) ?? []),
    ...(brain?.goals.targetAudience.map((audience) => audience.label) ?? []),
  ].join(" ");
  const watched = new Set(
    (await getWatchlist(profile.id)).map((account) => account.handle.toLowerCase()),
  );
  const accounts = suggestAccounts(interestText, {
    exclude: watched,
    avoidText: profile.avoidTopics ?? "",
  });
  return <SuggestedWatchlist accounts={accounts} preselected={PRESELECTED} />;
}
