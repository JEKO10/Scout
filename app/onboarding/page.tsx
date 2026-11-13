import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { saveOnboardingAnswersAction } from "@/actions/onboarding";
import { AboutForm } from "@/components/onboarding/AboutForm";
import { BuildBrainStep } from "@/components/onboarding/BuildBrainStep";
import { CompleteSetupButton } from "@/components/onboarding/CompleteSetupButton";
import { ConnectXStep } from "@/components/onboarding/ConnectXStep";
import { FirstScan, type FirstScanState } from "@/components/onboarding/FirstScan";
import { SuggestedWatchlist } from "@/components/onboarding/SuggestedWatchlist";
import { VoiceCalibration } from "@/components/onboarding/VoiceCalibration";
import { OpportunityCard } from "@/components/opportunities/OpportunityCard";
import { toDrafts } from "@/components/opportunities/toDrafts";
import { AddWatchlistAccountForm } from "@/components/watchlist/AddWatchlistAccountForm";
import { WatchlistList } from "@/components/watchlist/WatchlistList";
import { getOpportunities } from "@/db/queries/opportunities";
import { getCurrentReplies, getLastReplyStyles } from "@/db/queries/replies";
import { getActiveScoutRun, getRecentScoutRuns, getRunGate } from "@/db/queries/scoutRuns";
import { getVoiceSamples } from "@/db/queries/voiceSamples";
import { getWatchlist } from "@/db/queries/watchlist";
import type { Profile } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { pickCalibrationPosts } from "@/lib/onboarding/calibrationPosts";
import {
  explainScore,
  ONBOARDING_STAGES,
  ONBOARDING_STEPS,
  onboardingEntry,
  type OnboardingMode,
  type OnboardingStep,
  stageOf,
} from "@/lib/onboarding/progress";
import { suggestAccounts } from "@/lib/onboarding/suggestedAccounts";
import { getScoutLimits } from "@/lib/scout/testLimits";
import { BUDGET_MESSAGES, getUsageBudget, maxActiveWatchlist, scanBlockedBy } from "@/services/billing/budget";
import { ENOUGH_POSTS, getOnboardingFacts } from "@/services/onboarding/facts";
import { autoScanInterval } from "@/services/scheduler/tick";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { isUnverified, WATCHLIST_LIMIT } from "@/services/watchlist/addAccount";

const headings: Record<OnboardingStep, { title: string; lede: string }> = {
  welcome: { title: "Find conversations worth joining.", lede: "" },
  connect: {
    title: "Do you post on X?",
    lede: "If you do, Scout learns your voice and topics from your posts. If not, you can start from scratch.",
  },
  answers: { title: "Tell Scout about you.", lede: "Your answers shape every match. Most of it is a few clicks." },
  voice: { title: "Show Scout how you write.", lede: "Three short replies teach Scout your voice better than any description." },
  brain: { title: "Build your Scout Brain.", lede: "Who you are, what you know and what you want, in one place." },
  accounts: {
    title: "Choose accounts to watch.",
    lede: "Choose people whose conversations you want Scout to monitor. You can change this anytime.",
  },
  scan: { title: "Find your first opportunities.", lede: "" },
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
        <span>Setup</span>
      </div>
      <div className="onboarding-shell enter-content">
        <Suspense fallback={<div className="skeleton skeleton-settings" />}>
          <Onboarding searchParams={props.searchParams} />
        </Suspense>
      </div>
    </main>
  );
}

async function Onboarding({ searchParams }: { searchParams: PageProps<"/onboarding">["searchParams"] }) {
  const { profile } = await requireProfile();
  const params = await searchParams;
  const requestedMode = params.mode === "posts" || params.mode === "scratch" ? params.mode : undefined;
  const facts = await getOnboardingFacts(profile, { mode: requestedMode });
  // Progress comes from what is saved: finished users go to the dashboard,
  // everyone else resumes where they left off and can't skip ahead
  const entry = onboardingEntry(facts, typeof params.step === "string" ? params.step : null);
  if ("redirect" in entry) redirect(entry.redirect);

  const step = entry.step;
  const mode: OnboardingMode = facts.mode;
  const steps = ONBOARDING_STEPS[mode];
  const href = (next: OnboardingStep) => `/onboarding?step=${next}&mode=${mode}`;
  const previous = steps[steps.indexOf(step) - 1];
  const heading = headings[step];
  const stage = stageOf(step);

  return (
    <>
      {stage !== null && (
        <ol className="onboarding-progress" aria-label="Setup progress">
          {ONBOARDING_STAGES.map((label, index) => (
            <li key={label} data-state={index < stage ? "done" : index === stage ? "current" : undefined}>
              <span aria-hidden="true">{index < stage ? "✓" : index + 1}</span>
              {label}
              {index === stage && <span className="sr-only"> (current step)</span>}
            </li>
          ))}
        </ol>
      )}

      {step === "welcome" ? (
        <Welcome nextHref={href("connect")} />
      ) : (
        <>
          <div className="onboarding-heading">
            <h1>{heading.title}</h1>
            {heading.lede && <p>{heading.lede}</p>}
          </div>
          {step === "connect" && (
            <ConnectXStep handle={profile.xHandle} postCount={facts.usablePosts} enoughPosts={ENOUGH_POSTS} />
          )}
          {step === "answers" && (
            <AboutForm profile={profile} action={saveOnboardingAnswersAction.bind(null, mode)} />
          )}
          {step === "voice" && <VoiceStep profile={profile} nextHref={href("brain")} />}
          {step === "brain" && <BrainStep profile={profile} mode={mode} nextHref={href("accounts")} />}
          {step === "accounts" && <AccountsStep profile={profile} />}
          {step === "scan" && <ScanStep profile={profile} />}
          {previous && previous !== "welcome" && step !== "scan" && (
            <Link href={href(previous)} className="text-link onboarding-back">
              <span aria-hidden="true">←</span> Back
            </Link>
          )}
        </>
      )}
    </>
  );
}

function Welcome({ nextHref }: { nextHref: string }) {
  return (
    <section className="onboarding-welcome">
      <p className="eyebrow">Welcome to Scout</p>
      <h1>Find conversations worth joining.</h1>
      <p className="lede">
        Scout watches the people and topics that matter to you, finds relevant conversations, and helps you
        write thoughtful replies that sound like you.
      </p>
      <ol className="welcome-benefits">
        <li>
          <strong>Discover relevant conversations</strong>
          <span>From the accounts you choose, scored against what you know.</span>
        </li>
        <li>
          <strong>Understand why they&apos;re worth joining</strong>
          <span>Every match comes with a score and a reason.</span>
        </li>
        <li>
          <strong>Write personalized replies faster</strong>
          <span>Drafts in your voice. You edit and post them yourself on X.</span>
        </li>
      </ol>
      <Link href={nextHref} className="primary-button">
        Set up my Scout
      </Link>
      <p className="memory-note">Takes about 5 minutes.</p>
    </section>
  );
}

async function VoiceStep({ profile, nextHref }: { profile: Profile; nextHref: string }) {
  const profileText = [profile.topics, profile.knownFor, profile.occupation, profile.targetAudience, profile.primaryGoal].join(" ");
  const posts = pickCalibrationPosts(profileText);
  const existing = await getVoiceSamples(profile.id);
  const initialReplies = posts.map(
    (post) => existing.find((sample) => sample.promptPost === post.text)?.userReply ?? "",
  );
  return <VoiceCalibration posts={posts} initialReplies={initialReplies} nextHref={nextHref} />;
}

async function BrainStep({ profile, mode, nextHref }: { profile: Profile; mode: OnboardingMode; nextHref: string }) {
  const sources =
    mode === "posts"
      ? ["Your X posts (voice, topics, opinions)", "Your answers (goals, audience)"]
      : [
          "Your answers (topics, goals, audience, tone)",
          `${(await getVoiceSamples(profile.id)).filter((sample) => sample.source === "onboarding").length} calibration replies you wrote`,
        ];
  return <BuildBrainStep mode={mode} sources={sources} nextHref={nextHref} />;
}

async function AccountsStep({ profile }: { profile: Profile }) {
  const accounts = await getWatchlist(profile.id);
  const active = accounts.filter((account) => account.isActive).length;
  const maxActive = maxActiveWatchlist(profile);
  const brain = resolveScoutBrain(profile);
  const interestText = [
    profile.topics,
    profile.knownFor,
    profile.occupation,
    profile.targetAudience,
    ...(brain?.interests.topics.map((topic) => topic.label) ?? []),
    ...(brain?.goals.targetAudience.map((audience) => audience.label) ?? []),
  ].join(" ");
  const suggestions = suggestAccounts(interestText, {
    exclude: new Set(accounts.map((account) => account.handle.toLowerCase())),
    avoidText: profile.avoidTopics ?? "",
  });

  return (
    <div className="calibration onboarding-accounts">
      <p className="memory-note">
        Think of founders in your space, experts you learn from, creators your audience follows, and people
        who could become customers. Start with 5–15.
      </p>
      <p className="eyebrow">
        {active} selected
        {maxActive !== null && ` · your plan scans up to ${maxActive}`} · {accounts.length}/{WATCHLIST_LIMIT} on
        your list
      </p>
      <WatchlistList accounts={accounts.map((account) => ({ ...account, unverified: isUnverified(account) }))} />
      {accounts.length < WATCHLIST_LIMIT && <AddWatchlistAccountForm />}
      <SuggestedWatchlist accounts={suggestions} />
      <CompleteSetupButton ready={active > 0} />
    </div>
  );
}

async function ScanStep({ profile }: { profile: Profile }) {
  const [activeRun, runs, gate, budget, accounts] = await Promise.all([
    getActiveScoutRun(profile.id),
    getRecentScoutRuns(profile.id, 1),
    getRunGate(profile.id, getScoutLimits()),
    getUsageBudget(profile),
    getWatchlist(profile.id),
  ]);
  const activeAccounts = accounts.filter((account) => account.isActive).length;
  const latest = runs[0];

  // Why a scan can't start right now, said plainly instead of a broken spinner
  const blockedBy = scanBlockedBy(budget);
  const limits = getScoutLimits();
  const blocked =
    activeAccounts === 0
      ? "Add at least one active account to watch first."
      : blockedBy
        ? BUDGET_MESSAGES[blockedBy]
        : gate.blockedBy === "daily_limit" || gate.blockedBy === "min_gap"
          ? `Your current limit allows ${limits.maxRunsPerDay ?? "a limited number of"} scans per 24 hours` +
            (limits.minMinutesBetweenRuns ? `, ${limits.minMinutesBetweenRuns} minutes apart` : "") +
            `. Next scan ${gate.nextEligibleAt ? formatRelative(gate.nextEligibleAt) : "soon"}.`
          : null;

  let state: FirstScanState;
  if (activeRun) {
    state = { kind: "running", startedLabel: formatRelative(activeRun.startedAt ?? activeRun.createdAt) };
  } else if (latest?.status === "completed") {
    state = {
      kind: "completed",
      analyzed: latest.stats?.scoring?.scored ?? 0,
      opportunities: latest.opportunitiesFound,
      whenLabel: formatRelative(latest.completedAt ?? latest.createdAt),
    };
  } else if (latest?.status === "failed") {
    state = {
      kind: "failed",
      error: latest.error ?? "unknown error",
      canRetry: !blocked,
      blockedMessage: blocked ?? undefined,
    };
  } else {
    state = blocked ? { kind: "blocked", message: blocked } : { kind: "ready" };
  }

  const automatic = profile.autoScanEnabled
    ? `Automatic Scout is on: it scans every ${autoScanInterval(profile) / 60} hours within your plan's limits.`
    : "Scout scans when you run it. Turn on Automatic Scout in Settings to have it keep checking on its own.";

  // The best open opportunity, with its reply tools, and the score in plain English
  let best = null;
  if (state.kind === "completed") {
    const [top] = await getOpportunities(profile.id, "new");
    if (top) {
      const [replies, lastStyles] = await Promise.all([
        getCurrentReplies(profile.id, [top.id]),
        getLastReplyStyles(profile.id),
      ]);
      best = (
        <div className="first-opportunity">
          <p className="eyebrow">Your best match so far</p>
          <p className="memory-note">
            {explainScore(top.score ?? 0, top.scoreBreakdown)} Pick a style and click Generate Reply for drafts
            in your voice, edit one, then Reply on X: you post it yourself.
          </p>
          <OpportunityCard
            opportunity={top}
            replies={toDrafts(replies.get(top.id))}
            defaultStyles={lastStyles ?? undefined}
          />
        </div>
      );
    }
  }

  return (
    <FirstScan state={state} activeAccounts={activeAccounts} automatic={automatic}>
      {best}
    </FirstScan>
  );
}
