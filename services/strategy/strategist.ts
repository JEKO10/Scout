import "server-only";

import { createHash } from "node:crypto";

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { countAiCallsSince } from "@/db/queries/aiUsage";
import { getProfileTimeZone } from "@/db/queries/content";
import { getPeerSuggestions } from "@/db/queries/peers";
import {
  completeStrategyGeneration,
  failStrategyGeneration,
  getActiveStrategy,
  getExperiments,
  getPlanTasks,
  getStrategy,
  getStrategyHistory,
  getStrategyModuleCounts,
  getTaskCompletion,
  startStrategyGeneration,
} from "@/db/queries/strategy";
import type { GrowthExperiment, Profile } from "@/db/schema";
import { isMissingSchemaError, missingSchemaMessage } from "@/db/schemaErrors";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import { estimateCostUsd } from "@/lib/ai/pricing";
import { effectiveLimits } from "@/lib/billing/plans";
import { isValidTimeZone, zonedParts } from "@/lib/content/calendar";
import type { GrowthPost } from "@/lib/growth/analyze";
import { buildEvidence, experimentResult, maxMinutesPerDay, planDays, type RawStrategy, validateStrategy } from "@/lib/strategy/plan";
import type { PeerMode } from "@/lib/strategy/types";
import {
  EXPERIMENT_DIMENSIONS,
  EXPERIMENT_METRICS,
  type ExperimentResult,
  MEASURABLE_VARIANTS,
  MODULE_LINK,
  OBJECTIVE_LABEL,
  STRATEGY_MODULES,
  type StrategyEvidence,
  type StrategyObjective,
} from "@/lib/strategy/types";
import { recordAiUsage } from "@/services/ai/usage";
import { currentPeriodStart, getUsageBudget } from "@/services/billing/budget";
import { buildGrowthReport } from "@/services/growth/report";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { isPeerRefreshEnabled, loadPeers, strategyPeerEvidence, userTopics } from "@/services/strategy/peers";

// Day 34 Growth Strategist. Scout computes the evidence from data it already
// stores (no X call); one AI call turns it into priorities, a 7-day plan and
// experiments; Scout validates every item against the evidence before
// saving. Generated only when the user asks, cached until the evidence or
// their settings change, capped per month, paid from the scoring budget.

/** Conservative estimate per generation (gpt-5.5, ~4k tokens in, ~3k out with reasoning) */
export const STRATEGY_USD = 0.12;
const MAX_OUTPUT_TOKENS = 6_000;

export type StrategyPreferences = { objective: StrategyObjective; weeklyMinutes: number; peerMode?: PeerMode };

async function timeZone(profileId: string): Promise<string> {
  const saved = await getProfileTimeZone(profileId);
  return saved && isValidTimeZone(saved) ? saved : "UTC";
}

/**
 * The evidence for one profile right now, from stored data only: Growth
 * (90 days for patterns, 30 for the overview), conversations, trends, leads
 * and content. No X or AI call.
 */
export async function collectStrategyInputs(profile: Profile, now = new Date(), peerMode: PeerMode = "recommended") {
  const tz = await timeZone(profile.id);
  const [report90, report30, counts, active] = await Promise.all([
    buildGrowthReport(profile, { range: 90, tz, now }),
    buildGrowthReport(profile, { range: 30, tz, now }),
    getStrategyModuleCounts(profile.id, now),
    getActiveStrategy(profile.id),
  ]);
  const has90 = "posts" in report90 && report90.account;
  const has30 = "posts" in report30 && report30.account;
  const posts: GrowthPost[] = has90 ? report90.posts : [];
  const spanOf = (list: GrowthPost[]) => {
    if (list.length === 0) return null;
    const times = list.map((post) => post.publishedAt.getTime());
    return { first: new Date(Math.min(...times)), last: new Date(Math.max(...times)) };
  };
  // What patterns rest on: original posts with impressions (as Growth's findings)
  const analyzed = posts.filter((post) => post.kind !== "reply" && post.impressions !== null);

  // Day 35: peers (stored data only), who the user is, who they could engage with
  const userFollowers = has30 ? report30.overview.followers.current : null;
  // Peer tables missing (database behind the code): the strategy still
  // works, says so, and the error is logged; any other error is thrown
  let peers: Awaited<ReturnType<typeof loadPeers>> = [];
  let peersUnavailable = false;
  try {
    peers = await loadPeers(profile, userFollowers, now);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
    console.error(missingSchemaMessage("Peer intelligence", "20261118002427_peer_intelligence"));
    peersUnavailable = true;
  }
  const peerData = peersUnavailable
    ? { items: [], missing: ["Peer intelligence isn't available right now: the database needs an update."], used: [] }
    : strategyPeerEvidence(peers, peerMode);
  const brain = resolveScoutBrain(profile);
  const list = (values: (string | null | undefined)[]) => values.filter((v): v is string => Boolean(v && v.trim())).slice(0, 6).join(", ");
  const who = list([profile.occupation, ...(brain?.goals.knownFor.map((k) => k.label) ?? [profile.knownFor])]);
  const audience = list(brain?.goals.targetAudience.map((a) => a.label) ?? [profile.targetAudience]);
  const topics = list(userTopics(profile));
  const profileContext = [
    who && `From your profile: ${who}.`,
    (audience || profile.leadProfile?.product) &&
      `From your profile: audience ${audience || "not set"}${profile.leadProfile?.product ? `; you offer ${profile.leadProfile.product}` : ""}.`,
    topics && `From your profile: topics you care about: ${topics}.`,
  ].filter((line): line is string => Boolean(line));

  const evidence = buildEvidence({
    hasAccount: Boolean(has30),
    handle: has30 ? report30.account.handle : null,
    findings: has90 ? report90.findings : [],
    postsWithImpressions90: analyzed.length,
    span90: spanOf(analyzed),
    span30: has30 ? spanOf(report30.posts) : null,
    overview30: has30 ? report30.overview : null,
    posts30: has30 ? report30.posts.length : 0,
    postsPrevious30: has30 && report30.overview.previousComplete ? (report30.overview.posts.previous ?? 0) : null,
    replyActivity30: report30.replyActivity,
    privateMetrics: has30 ? report30.privateMetrics : null,
    xConnected: report30.xConnection?.status === "active",
    trends: counts.trends,
    leads: counts.leads,
    content: counts.content,
    previousSnapshot: active?.evidence.snapshot ?? null,
    peerItems: peerData.items,
    peerMissing: peerData.missing,
    profileContext,
    engagementTargets: counts.watchedHandles.length
      ? `Accounts you watch in Scout: ${counts.watchedHandles.map((h) => `@${h}`).join(", ")}. Their conversations appear in Opportunities.`
      : null,
  });
  return { tz, evidence, posts, active, peers, peersUsed: peerData.used, peersUnavailable };
}

/** Same evidence and settings → same key: nothing new to plan from */
export function evidenceKey(evidence: StrategyEvidence, prefs: StrategyPreferences): string {
  const basis = JSON.stringify({
    prefs: { ...prefs, peerMode: prefs.peerMode ?? "recommended" },
    mode: evidence.mode,
    items: evidence.items.map((item) => item.text),
    missing: evidence.missing,
  });
  return createHash("sha256").update(basis).digest("base64url").slice(0, 32);
}

/** Today in the user's time zone: the plan's first day */
export function localToday(tz: string, now = new Date()): string {
  return zonedParts(now, tz).date;
}

// ---- AI --------------------------------------------------------------------------

const txt = (max: number) => z.string().describe(`At most ${max} characters`);
const ids = z.array(z.string()).describe("IDs of the evidence items (E1, E2…) this relies on");

const strategySchema = z.object({
  summary: txt(500).describe("2-3 sentences: where this account stands for the user's objective, citing what the evidence shows (and what is unknown)"),
  priorities: z
    .array(z.object({ title: txt(100), why: txt(350), evidenceIds: ids }))
    .describe("Exactly 3 growth priorities for this week, most important first"),
  doMore: z
    .array(z.object({ text: txt(250), evidenceIds: ids }))
    .describe("0-4 things to do more of, each backed by a non-limited pattern or an activity/trend/lead/content observation; name the metric"),
  toTest: z
    .array(z.object({ text: txt(250), evidenceIds: ids }))
    .describe("0-3 hypotheses worth testing: positive patterns with limited confidence. Phrase as something to try, not a proven result"),
  doLess: z
    .array(z.object({ text: txt(250), evidenceIds: ids }))
    .describe("0-3 things to do less of; ONLY when an evidence item marked supportsReduction backs it"),
  tasks: z
    .array(
      z.object({
        day: z.number().int().describe("0 = the first day of the plan … 6 = the last"),
        title: txt(100).describe("A specific action, e.g. 'Draft a thread on onboarding mistakes'"),
        objective: txt(160),
        activity: txt(350).describe("What exactly to do, concretely"),
        reason: txt(250).describe("Why, referring to the evidence or the objective"),
        effortMinutes: z.number().int(),
        module: z.enum(STRATEGY_MODULES),
        evidenceIds: ids,
      }),
    )
    .describe("The 7-day plan: 0-2 small tasks per day, at most limits.maxMinutesPerDay a day and limits.weeklyMinutes in total, spread across the week; rest days are fine"),
  experiments: z
    .array(
      z.object({
        title: txt(100),
        hypothesis: txt(250),
        dimension: z.enum(EXPERIMENT_DIMENSIONS),
        variantA: txt(60),
        variantB: txt(60),
        metric: z.enum(EXPERIMENT_METRICS),
        durationDays: z.number().int(),
        actions: z.array(txt(160)),
      }),
    )
    .describe("0-2 new experiments to propose"),
  experimentReviews: z
    .array(z.object({ experimentId: z.string(), recommendation: z.enum(["continue", "modify", "stop"]), reason: txt(250) }))
    .describe("For each running experiment given: continue, modify or stop, from its result"),
  roadmap: z
    .array(
      z.object({
        week: z.number().int(),
        objective: txt(120),
        activities: z.array(txt(180)).describe("2-3 concrete activities"),
        milestone: txt(160).describe("What the user will have learned or done; never a follower number or growth rate"),
        modules: z.array(z.enum(STRATEGY_MODULES)),
        measure: z.array(txt(140)).describe("What to look at, e.g. replies per post"),
      }),
    )
    .describe("Exactly 4 weeks of direction for stages starting and learning; empty for stage evidence"),
});

const INSTRUCTIONS = `You are Scout's growth strategist for one person on X. Turn the evidence Scout computed into a practical plan for the next 7 days.
Rules:
- Use ONLY the evidence items, missing-data notes and profile given. Never invent numbers, results, followers, trends, leads or experiences. Do not write any number that isn't in the evidence.
- Cite evidence IDs for every priority, "do more", "to test" and "do less" item. A pattern is an association, not proof of cause: say "posts on X did better", never "X causes".
- Name the metric each pattern measured (impressions per post, replies per post or engagement rate) and recommend only what that metric shows. Impressions and replies are not follower growth: never claim posts grew followers or the audience unless a follower observation shows it.
- Confidence: "limited" patterns are hypotheses. Put them in toTest (or an experiment), never in doMore. Each evidence item states the real period its posts cover; respect it (a few days of posts is not a sustained trend).
- "Do less" only when an evidence item with supportsReduction=true backs it. Never recommend dropping something based on a few posts.
- If mode is "starter", there isn't enough history: say so in the summary, make priorities about building a baseline and testing, and propose experiments. Don't present guesses as findings.
- Evidence types: own_analytics (the user's own results: the only basis for "do more" and "do less"), peer_observation (what other accounts' posts show, each compared with itself: only ideas to test, never proof it will work for this user; never a reason to "do less"), scout_activity (conversations, trends, leads, content Scout found), profile_context (what the user told Scout; not a measurement).
- Stage: "starting" (no own data), "learning" (some, not enough), "evidence". In starting/learning, answer concretely: who to engage with (accounts and conversations from the evidence), what to post first (tied to their offer and audience), which topics to test, how often to post within their time, what to measure, and how to adjust after week 1. No generic advice like "post consistently" without the concrete action.
- Peers: say which accounts an idea comes from (by handle, as in the evidence), describe what they did, and phrase it as something to adapt and test. Never copy their posts, never imply their results will repeat for this user. If the evidence says the user's selected accounts lack data, say so plainly; don't substitute other accounts. When an observation says it's not consistent across accounts, present both sides and suggest testing them rather than picking one.
- Refer to accounts by handle or as "the account" / "their posts"; never guess anyone's gender (no he/his/she/her for accounts or people).
- Roadmap (stages starting and learning): 4 weeks, each with an objective, 2-3 activities, a learning milestone, modules and what to measure. No follower targets, no growth rates, no guarantees.
- Serve the user's objective (customers, leads, authority, audience or conversations), not follower count by default. Use their work, audience, expertise and offer.
- Tasks: small and realistic, at most 2 a day and limits.maxMinutesPerDay minutes a day, total within limits.weeklyMinutes, spread over the week (don't pack the first days). Each links to one Scout module: studio (write posts), calendar (plan content), trends (explore trends), opportunities (reply to conversations), leads (review leads in CRM), growth (review analytics), discovery (search topics).
- Experiments: at least 14 days (5+ posts per variant need time). Dimension length/hook/time only with the listed variant keys (Scout measures those from posts); otherwise dimension "custom" with short variant names. Don't promise significance.
- Running experiments: recommend continue, modify or stop from their result; "collecting" means not enough posts yet, so usually continue.
- Plain, specific language. No hashtags, no hype.`;

export type GenerateResult = { ok: true; cached: boolean; message: string } | { ok: false; message: string };

function experimentForAi(experiment: GrowthExperiment, result: ExperimentResult) {
  return {
    id: experiment.id,
    title: experiment.title,
    hypothesis: experiment.hypothesis,
    variants: [experiment.variantA, experiment.variantB],
    metric: experiment.metric,
    startedAt: experiment.startedAt?.toISOString().slice(0, 10) ?? null,
    result:
      result.status === "directional"
        ? { status: "directional", postsA: result.aN, postsB: result.bN, medianA: result.aMedian, medianB: result.bMedian, confidence: result.confidence }
        : result,
    observations: experiment.observations.slice(-3).map((o) => o.text),
  };
}

/**
 * Generates (or returns the cached) weekly strategy for the user's settings.
 * Order: evidence → cache → monthly allowance → budget → one-at-a-time lock
 * → one AI call → validation → save.
 */
export async function generateStrategy(profile: Profile, prefs: StrategyPreferences, now = new Date()): Promise<GenerateResult> {
  const peerMode: PeerMode = prefs.peerMode ?? "recommended";
  const { tz, evidence, posts, active } = await collectStrategyInputs(profile, now, peerMode);
  const key = evidenceKey(evidence, prefs);
  if (active && active.evidenceKey === key && now.getTime() - active.createdAt.getTime() < 7 * 86_400_000) {
    return { ok: true, cached: true, message: "Your plan is still current: nothing in your data or settings changed since it was made." };
  }

  const cap = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxStrategyGenerationsPerMonth;
  if ((await countAiCallsSince(profile.id, "growth_strategy", currentPeriodStart(now))) >= cap) {
    return { ok: false, message: `Your plan includes ${cap} strategy ${cap === 1 ? "update" : "updates"} a month. You can keep working with your current plan and experiments.` };
  }
  if ((await getUsageBudget(profile, now)).remaining.scoringUsd < STRATEGY_USD) {
    return { ok: false, message: "Today's AI budget is used up. More becomes available tomorrow." };
  }

  const weekStart = localToday(tz, now);
  const generating = await startStrategyGeneration(
    profile.id,
    {
      mode: evidence.mode,
      stage: evidence.stage ?? null,
      peerMode,
      objective: prefs.objective,
      weeklyMinutes: prefs.weeklyMinutes,
      weekStart,
      evidence,
      evidenceKey: key,
    },
    now,
  );
  if (!generating) return { ok: false, message: "Your strategy is already being written. Refresh in a moment." };

  try {
    const experiments = (await getExperiments(profile.id)).filter((e) => e.status === "active");
    const completion = active ? await getTaskCompletion(profile.id, active.id) : null;
    const brain = resolveScoutBrain(profile);
    const days = planDays(weekStart);
    const input = {
      user: {
        objective: OBJECTIVE_LABEL[prefs.objective],
        weeklyMinutes: prefs.weeklyMinutes,
        occupation: profile.occupation,
        primaryGoal: profile.primaryGoal,
        audience: brain?.goals.targetAudience.map((item) => item.label) ?? profile.targetAudience,
        knownFor: brain?.goals.knownFor.map((item) => item.label) ?? profile.knownFor,
        topics: brain?.interests.topics.map((item) => item.label).slice(0, 8) ?? profile.topics,
        expertise: brain?.interests.expertise.map((item) => item.area).slice(0, 6) ?? null,
        offers: profile.leadProfile?.product ?? null,
        voice: brain?.voice.summary ?? profile.voiceDescription,
      },
      mode: evidence.mode,
      stage: evidence.stage,
      peerMode: peerMode === "selected" ? "the user's selected accounts only" : "Scout's most comparable saved peers",
      // Handles are already in the peer observation texts
      evidence: evidence.items,
      missingData: evidence.missing,
      changesSinceLastPlan: evidence.changes,
      previousPlan: active?.content
        ? {
            priorities: active.content.priorities.map((p) => p.title),
            tasks: completion,
          }
        : null,
      runningExperiments: experiments.map((e) => experimentForAi(e, experimentResult(e, posts, { tz, now }))),
      measurableVariants: MEASURABLE_VARIANTS,
      modules: Object.fromEntries(STRATEGY_MODULES.map((m) => [m, MODULE_LINK[m].label])),
      planDays: days.map((day, index) => ({ day: index, date: day })),
      limits: { weeklyMinutes: prefs.weeklyMinutes, maxMinutesPerDay: maxMinutesPerDay(prefs.weeklyMinutes), maxTasksPerDay: 2, minExperimentDays: 14 },
    };

    const response = await getOpenAI().responses.parse({
      model: AI_MODELS.scoring,
      instructions: INSTRUCTIONS,
      input: JSON.stringify(input),
      reasoning: { effort: "low" },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      text: { format: zodTextFormat(strategySchema, "growth_strategy") },
    });
    await recordAiUsage({ profileId: profile.id, operation: "growth_strategy" }, response);
    const usage = response.usage;
    const costUsd = usage
      ? estimateCostUsd(response.model, {
          inputTokens: usage.input_tokens,
          cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: usage.output_tokens,
        })
      : null;
    const parsed = strategySchema.safeParse(response.output_parsed);
    const valid =
      parsed.success &&
      validateStrategy(parsed.data as RawStrategy, {
        evidence,
        weeklyMinutes: prefs.weeklyMinutes,
        activeExperiments: experiments,
        objective: prefs.objective,
      });
    if (!valid) {
      await failStrategyGeneration(generating.id, parsed.success ? "no recommendation passed validation" : "malformed output");
      return { ok: false, message: "Couldn't put together a plan this time. Try again later." };
    }

    await completeStrategyGeneration(profile.id, generating.id, {
      ...valid,
      days,
      model: response.model,
      costUsd,
    });
    return { ok: true, cached: false, message: evidence.mode === "starter" ? "Starter plan ready." : "Your weekly strategy is ready." };
  } catch (error) {
    await failStrategyGeneration(generating.id, error instanceof Error ? error.message : String(error));
    console.error("Growth strategy generation failed", error);
    return { ok: false, message: "Couldn't reach the AI right now. Try again later." };
  }
}

// ---- Page --------------------------------------------------------------------------

/** A sensible first objective from what the profile already says */
function defaultObjective(profile: Profile): StrategyObjective {
  if (profile.leadProfile) return "find_customers";
  const goal = (profile.primaryGoal ?? "").toLowerCase();
  if (/customer|client|sale|sell/.test(goal)) return "find_customers";
  if (/lead/.test(goal)) return "generate_leads";
  if (/follower|audience|grow/.test(goal)) return "grow_audience";
  if (/conversation|network|engage|communit/.test(goal)) return "meaningful_engagement";
  return "build_authority";
}

/**
 * Everything the Growth Strategy page shows. Reads stored data only; the
 * current evidence is recomputed (database only) so the overview is live
 * even between strategy updates.
 */
export async function loadStrategyView(profile: Profile, strategyId: string | null, now = new Date(), peerModeOverride?: PeerMode) {
  const current = await getActiveStrategy(profile.id);
  const peerMode: PeerMode = peerModeOverride ?? current?.peerMode ?? "recommended";
  const { tz, evidence, posts, active, peers, peersUsed, peersUnavailable } = await collectStrategyInputs(profile, now, peerMode);
  const selected = strategyId ? await getStrategy(profile.id, strategyId) : active;
  const [tasks, experiments, history, used] = await Promise.all([
    selected ? getPlanTasks(profile.id, selected.id) : Promise.resolve([]),
    getExperiments(profile.id),
    getStrategyHistory(profile.id),
    countAiCallsSince(profile.id, "growth_strategy", currentPeriodStart(now)),
  ]);
  const cap = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxStrategyGenerationsPerMonth;
  const prefs: StrategyPreferences = active
    ? { objective: active.objective as StrategyObjective, weeklyMinutes: active.weeklyMinutes, peerMode }
    : { objective: defaultObjective(profile), weeklyMinutes: 120, peerMode };
  const suggestions = peersUnavailable ? [] : await getPeerSuggestions(
    profile.id,
    peers.map((p) => p.peer.platformUserId),
    now,
  );
  return {
    tz,
    today: localToday(tz, now),
    evidence,
    strategy: selected ?? null,
    isHistory: Boolean(selected && active && selected.id !== active.id) || selected?.status === "archived",
    tasks,
    experiments: experiments.map((experiment) => ({ experiment, result: experimentResult(experiment, posts, { tz, now }) })),
    history,
    prefs,
    allowance: { used, cap },
    upToDate: Boolean(active && active.evidenceKey === evidenceKey(evidence, prefs)),
    peers,
    peersUnavailable,
    peersUsed: peersUsed.map((p) => p.peer.id),
    suggestions,
    peerLimit: effectiveLimits(profile.plan, profile.usageLimitOverrides).maxSavedPeers,
    peerRefreshEnabled: isPeerRefreshEnabled(),
  };
}
