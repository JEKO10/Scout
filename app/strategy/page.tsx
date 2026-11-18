import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { GrowthPlanRemindersButton } from "@/components/automations/AutomationControls";
import { EmptyState } from "@/components/EmptyState";
import { InfoHint, TitleWithHint } from "@/components/InfoHint";
import { AddPeerForm, AddSuggestionButton, PeerRowControls } from "@/components/strategy/PeerControls";
import {
  ActiveExperimentControls,
  PresetButton,
  ProposedExperimentControls,
  StrategyForm,
  TaskControls,
} from "@/components/strategy/StrategyControls";
import { listAutomations } from "@/db/queries/automations";
import type { GrowthExperiment, GrowthPlanTask } from "@/db/schema";
import { isMissingSchemaError, missingSchemaMessage } from "@/db/schemaErrors";
import { requireProfile } from "@/lib/auth/session";
import { CONFIDENCE_LABEL } from "@/lib/growth/analyze";
import { citableEvidence, planDays } from "@/lib/strategy/plan";
import {
  type EvidenceItem,
  EXPERIMENT_PRESETS,
  type ExperimentResult,
  MEASURABLE_VARIANTS,
  MODULE_LINK,
  OBJECTIVE_LABEL,
  PEER_CATEGORY_LABEL,
  PEER_MIN_POSTS,
  PEER_MODE_LABEL,
  type PeerMode,
  SOURCE_LABEL,
  type SourceType,
  STAGE_INFO,
  type StrategyModule,
  type StrategyObjective,
  type StrategyStage,
} from "@/lib/strategy/types";
import { track } from "@/services/analytics/track";
import { loadStrategyView } from "@/services/strategy/strategist";

export const metadata: Metadata = { title: "Growth Strategy" };

const num = (value: number | null) => (value === null ? "—" : Math.round(value).toLocaleString("en-US"));
const pct = (value: number | null, digits = 1) => (value === null ? "—" : `${(value * 100).toFixed(digits)}%`);

export default function StrategyPage({ searchParams }: PageProps<"/strategy">) {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense fallback={<main className="workspace shell"><div className="skeleton skeleton-feed" /></main>}>
        <Strategy searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function dayLabel(day: string, today: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(date);
  return day === today ? `Today · ${name}` : name;
}

/** The evidence a recommendation cites, with sample size and confidence where they exist */
function Evidence({ ids, items }: { ids: string[]; items: Map<string, EvidenceItem> }) {
  const cited = ids.map((id) => items.get(id)).filter((item): item is EvidenceItem => Boolean(item));
  if (cited.length === 0) return null;
  return (
    <details className="strategy-evidence">
      <summary>Based on {cited.length === 1 ? "1 observation" : `${cited.length} observations`}</summary>
      <ul>
        {cited.map((item) => (
          <li key={item.id}>
            {item.text}
            {item.confidence && (
              <small>
                {" "}
                Confidence: {CONFIDENCE_LABEL[item.confidence]}
                {item.sampleSize !== null && ` · ${item.sampleSize} posts`}
              </small>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Which metric a recommendation is about, so it isn't read as follower growth */
function MeasuredBy({ metrics }: { metrics?: string[] }) {
  if (!metrics?.length) return null;
  return <small className="strategy-measured">Measured by {metrics.join(" and ")}</small>;
}

/** Where a recommendation comes from, and which peer accounts influenced it */
function Sources({ sources, influencedBy }: { sources?: SourceType[]; influencedBy?: string[] }) {
  if (!sources?.length && !influencedBy?.length) return null;
  return (
    <small className="strategy-sources">
      {sources?.map((source) => (
        <span key={source} className="strategy-source" data-source={source}>
          {SOURCE_LABEL[source]}
        </span>
      ))}
      {influencedBy?.length ? <span> Influenced by {influencedBy.map((h) => `@${h}`).join(", ")}</span> : null}
    </small>
  );
}

const fmtDate = (date: Date | null) => (date ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date) : "—");

function variantLabel(experiment: GrowthExperiment, variant: string): string {
  if (experiment.dimension === "custom") return variant;
  return MEASURABLE_VARIANTS[experiment.dimension as keyof typeof MEASURABLE_VARIANTS]?.[variant] ?? variant;
}

const METRIC_LABEL: Record<string, string> = { impressions: "median impressions", engagement_rate: "median engagement rate", replies: "median replies" };

function ResultLine({ experiment, result }: { experiment: GrowthExperiment; result: ExperimentResult }) {
  const show = (value: number) => (experiment.metric === "engagement_rate" ? pct(value, 2) : num(value));
  switch (result.status) {
    case "manual":
      return <p className="memory-note">{result.note}</p>;
    case "not_started":
      return null;
    case "collecting":
      return (
        <p className="memory-note">
          Collecting: {result.aN} vs {result.bN} posts so far; Scout compares once both have {result.needed}. Refresh Growth to update your numbers.
        </p>
      );
    case "directional":
      return (
        <p className="strategy-result">
          <strong>
            {variantLabel(experiment, experiment.variantA)}: {show(result.aMedian)} vs {variantLabel(experiment, experiment.variantB)}: {show(result.bMedian)}
          </strong>{" "}
          ({METRIC_LABEL[experiment.metric]}, {result.aN} vs {result.bN} posts
          {result.difference !== null && `, ${result.difference >= 0 ? "+" : ""}${pct(result.difference, 0)}`}). Confidence:{" "}
          {CONFIDENCE_LABEL[result.confidence]}. <span className="memory-note">{result.note}</span>
        </p>
      );
  }
}

function ExperimentCard({
  experiment,
  result,
  review,
}: {
  experiment: GrowthExperiment;
  result: ExperimentResult;
  review?: { recommendation: string; reason: string };
}) {
  return (
    <article className="strategy-experiment" data-status={experiment.status}>
      <div className="strategy-experiment-head">
        <strong>{experiment.title}</strong>
        <span className="strategy-pill">{experiment.status}</span>
      </div>
      <p>{experiment.hypothesis}</p>
      <p className="memory-note">
        {variantLabel(experiment, experiment.variantA)} vs {variantLabel(experiment, experiment.variantB)} · measured by {METRIC_LABEL[experiment.metric]} ·{" "}
        {experiment.durationDays} days · at least {experiment.minPerVariant} posts per variant
        {experiment.endsAt && experiment.status === "active" && ` · ends ${experiment.endsAt.toISOString().slice(0, 10)}`}
      </p>
      {experiment.actions.length > 0 && experiment.status !== "completed" && (
        <ul className="strategy-list">
          {experiment.actions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      )}
      {experiment.status !== "proposed" && <ResultLine experiment={experiment} result={result} />}
      {review && (
        <p className="strategy-review" data-recommendation={review.recommendation}>
          Strategist: <strong>{review.recommendation}</strong>. {review.reason}
        </p>
      )}
      {experiment.observations.length > 0 && (
        <ul className="strategy-observations">
          {[...experiment.observations].reverse().map((o) => (
            <li key={o.at}>
              <small>{o.at.slice(0, 10)}</small> {o.text}
            </li>
          ))}
        </ul>
      )}
      {experiment.conclusion && <p className="strategy-conclusion">Conclusion: {experiment.conclusion}</p>}
      {experiment.status === "proposed" && <ProposedExperimentControls experimentId={experiment.id} />}
      {experiment.status === "active" && <ActiveExperimentControls experimentId={experiment.id} />}
    </article>
  );
}

function TaskCard({ task, days }: { task: GrowthPlanTask; days: { value: string; label: string }[] }) {
  const link = MODULE_LINK[task.module as StrategyModule];
  return (
    <li className="strategy-task" data-status={task.status}>
      <div className="strategy-task-main">
        <strong>{task.title}</strong>
        <p>{task.activity}</p>
        <p className="memory-note">
          Goal: {task.objective} · Why: {task.reason}
        </p>
        <div className="strategy-task-meta">
          <span className="strategy-pill">~{task.effortMinutes} min</span>
          {link && (
            <Link href={link.href} className="text-link">
              Open {link.label} <span aria-hidden="true">→</span>
            </Link>
          )}
          {task.status !== "todo" && <span className="strategy-pill">{task.status === "done" ? "Done" : "Skipped"}</span>}
        </div>
      </div>
      <TaskControls taskId={task.id} status={task.status} day={task.day} days={days} />
    </li>
  );
}

async function Strategy({ searchParams }: { searchParams: PageProps<"/strategy">["searchParams"] }) {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");
  const params = await searchParams;
  const requested = typeof params.strategy === "string" && /^[0-9a-f-]{36}$/i.test(params.strategy) ? params.strategy : null;
  let view: Awaited<ReturnType<typeof loadStrategyView>>;
  try {
    view = await loadStrategyView(profile, requested);
  } catch (error) {
    // The database is behind the code: say so instead of a crash (logged)
    if (!isMissingSchemaError(error)) throw error;
    console.error(missingSchemaMessage("Growth Strategy", "20261118002427_peer_intelligence"));
    return (
      <main className="workspace shell enter-content">
        <EmptyState
          title="Growth Strategy needs a database update."
          description="This version of Scout expects database changes that haven't been applied yet. Your data is safe; the page works again once the update runs."
        />
      </main>
    );
  }
  await track("growth_strategy_viewed", { profileId: profile.id });
  // Day 36: are reminders for the plan's tasks on? (no reminder UI before the migration)
  let planReminders: boolean | null = null;
  try {
    planReminders = (await listAutomations(profile.id)).some((a) => a.templateKey === "growth_plan" && a.enabled);
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
  }

  const { evidence, strategy, today } = view;
  const stage: StrategyStage = (strategy?.stage as StrategyStage | null) ?? evidence.stage ?? (evidence.mode === "starter" ? "starting" : "evidence");
  const peerMode: PeerMode = view.prefs.peerMode ?? "recommended";
  const s = evidence.snapshot;
  // A plan's citations point into the evidence it was made from (IDs and
  // numbers as they were then), not into today's recomputed evidence
  const items = new Map(citableEvidence(strategy, evidence).map((item) => [item.id, item]));
  // Comparisons (two sides of one pattern) are shown once, with what works
  const works = evidence.items.filter((item) => item.kind === "works" || item.kind === "comparison");
  const weak = evidence.items.filter((item) => item.kind === "weak");
  const content = strategy?.content ?? null;
  const days = strategy ? planDays(strategy.weekStart) : [];
  const dayOptions = days.map((day) => ({ value: day, label: dayLabel(day, today) }));
  const reviews = new Map(content?.experimentReviews.map((r) => [r.experimentId, r]) ?? []);
  const active = view.experiments.filter(({ experiment }) => experiment.status === "active");
  const proposed = view.experiments.filter(({ experiment }) => experiment.status === "proposed");
  const finished = view.experiments.filter(({ experiment }) => experiment.status === "completed" || experiment.status === "stopped").slice(0, 5);
  const runningPresetDims = new Set(active.map(({ experiment }) => `${experiment.dimension}:${experiment.variantA}:${experiment.variantB}`));
  const presets = EXPERIMENT_PRESETS.filter((p) => !runningPresetDims.has(`${p.dimension}:${p.variantA}:${p.variantB}`));
  const doneCount = view.tasks.filter((task) => task.status === "done").length;

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <TitleWithHint
            title="Growth Strategy"
            hint={
              <>
                Scout turns your Growth numbers, conversations, trends, leads and content into a weekly plan. Every number comes from your
                stored data; the AI only writes the plan and must cite that data. Patterns show what went together, not what caused it.
                Updating the plan uses no X reads.
              </>
            }
          />
          <p className="lede">What to do this week, and why.</p>
        </div>
        {!view.isHistory && (
          <StrategyForm
            initial={{ ...view.prefs, peerMode }}
            hasStrategy={Boolean(strategy)}
            upToDate={view.upToDate}
            allowance={view.allowance}
          />
        )}
      </section>

      {view.isHistory && strategy && (
        <p className="strategy-banner">
          Viewing the plan from {strategy.weekStart} (history). <Link href="/strategy" className="text-link">Back to the current plan</Link>
        </p>
      )}

      <section className="strategy-stage" data-stage={stage} aria-label="Growth stage">
        <ol className="strategy-stage-steps">
          {(["starting", "learning", "evidence"] as StrategyStage[]).map((step) => (
            <li key={step} aria-current={step === stage ? "step" : undefined}>
              {STAGE_INFO[step].label}
            </li>
          ))}
        </ol>
        <p>
          <strong>{STAGE_INFO[stage].label}.</strong> {STAGE_INFO[stage].focus}
        </p>
        <InfoHint label="Where recommendations come from">
          <ul className="strategy-list">
            <li><strong>Your analytics</strong>: your own posts and their numbers. The only basis for &ldquo;Do more&rdquo; and &ldquo;Do less&rdquo;.</li>
            <li><strong>Peer observations</strong>: what other accounts&apos; posts show, each compared only with itself. Ideas to test, never proof it will work for you.</li>
            <li><strong>Scout activity</strong>: conversations, trends, leads and drafts Scout found for you.</li>
            <li><strong>Your profile</strong> and <strong>initial hypotheses</strong>: what you told Scout and reasonable first steps, not measurements.</li>
          </ul>
        </InfoHint>
      </section>

      <section className="stat-cards" aria-label="Growth overview">
        <div className="stat-card">
          <span className="stat-card-label">Posts, last 30 days</span>
          <strong>{s.postsLast30}</strong>
          <small>{s.postsPrevious30 === null ? "No full previous period" : `${s.postsPrevious30} the 30 days before`}</small>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Median impressions</span>
          <strong>{num(s.medianImpressions)}</strong>
          <small>{s.medianImpressions === null ? "No impressions reported" : "per post, last 30 days"}</small>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Engagement rate</span>
          <strong>{pct(s.engagementRate, 2)}</strong>
          <small>{s.engagementRate === null ? "Needs impressions" : "last 30 days"}</small>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Replies opened on X</span>
          <strong>{s.repliesOpened}</strong>
          <small>{s.followers === null ? "Followers unknown" : `${num(s.followers)} followers`}</small>
        </div>
      </section>

      {evidence.changes.length > 0 && !view.isHistory && (
        <section className="dash-card" aria-labelledby="changes-title">
          <div className="dash-card-head">
            <h2 id="changes-title">Since your last plan</h2>
          </div>
          <ul className="strategy-list">
            {evidence.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </section>
      )}

      {!content ? (
        <EmptyState
          title="No plan yet."
          description={`Choose your goal and how much time you have, then create your plan. Scout uses what it already knows: ${evidence.items.length} observations from your data${evidence.missing.length ? `, and it will tell you what's missing` : ""}.`}
        />
      ) : (
        <>
          <section className="dash-card" aria-labelledby="priorities-title">
            <div className="dash-card-head">
              <h2 id="priorities-title">Top priorities</h2>
              <span className="strategy-pill">{OBJECTIVE_LABEL[strategy!.objective as StrategyObjective] ?? strategy!.objective}</span>
            </div>
            <p className="strategy-summary">{content.summary}</p>
            <ol className="strategy-priorities">
              {content.priorities.map((p) => (
                <li key={p.title}>
                  <strong>{p.title}</strong>
                  {p.basis === "hypothesis" && <span className="strategy-pill strategy-pill-test">Hypothesis to test</span>}
                  <p>{p.why}</p>
                  <MeasuredBy metrics={p.measuredBy} />
                  <Sources sources={p.sources} influencedBy={p.influencedBy} />
                  <Evidence ids={p.evidenceIds} items={items} />
                </li>
              ))}
            </ol>
          </section>

          <div className="strategy-columns">
            <section className="dash-card" aria-labelledby="more-title">
              <div className="dash-card-head">
                <h2 id="more-title">Do more of</h2>
              </div>
              {content.doMore.length ? (
                <ul className="strategy-recs">
                  {content.doMore.map((r) => (
                    <li key={r.text}>
                      {r.text}
                      <MeasuredBy metrics={r.measuredBy} />
                      <Sources sources={r.sources} influencedBy={r.influencedBy} />
                      <Evidence ids={r.evidenceIds} items={items} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="memory-note">Nothing has enough evidence yet. Your experiments will tell.</p>
              )}
              {content.toTest && content.toTest.length > 0 && (
                <>
                  <h3 className="strategy-subhead">
                    Worth testing <span className="strategy-pill strategy-pill-test">Hypotheses</span>
                  </h3>
                  <p className="memory-note">Promising, but limited evidence so far: try these before relying on them.</p>
                  <ul className="strategy-recs">
                    {content.toTest.map((r) => (
                      <li key={r.text}>
                        {r.text}
                        <MeasuredBy metrics={r.measuredBy} />
                      <Sources sources={r.sources} influencedBy={r.influencedBy} />
                        <Evidence ids={r.evidenceIds} items={items} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <section className="dash-card" aria-labelledby="less-title">
              <div className="dash-card-head">
                <h2 id="less-title">Do less of</h2>
                <InfoHint label="About this">
                  Only when a weaker pattern holds over at least 8 posts with more than limited confidence. Scout never suggests dropping
                  something because of one or two posts.
                </InfoHint>
              </div>
              {content.doLess.length ? (
                <ul className="strategy-recs">
                  {content.doLess.map((r) => (
                    <li key={r.text}>
                      {r.text}
                      <MeasuredBy metrics={r.measuredBy} />
                      <Sources sources={r.sources} influencedBy={r.influencedBy} />
                      <Evidence ids={r.evidenceIds} items={items} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="memory-note">Nothing to cut: no weaker pattern has enough posts behind it.</p>
              )}
            </section>
          </div>
        </>
      )}

      <div className="strategy-columns">
        <section className="dash-card" aria-labelledby="works-title">
          <div className="dash-card-head">
            <h2 id="works-title">What works</h2>
          </div>
          {works.length ? (
            <ul className="strategy-recs">
              {works.map((item) => (
                <li key={item.id}>
                  {item.text}
                  {item.confidence && (
                    <small className="memory-note">
                      {" "}
                      Confidence: {CONFIDENCE_LABEL[item.confidence]} · {item.sampleSize} posts
                    </small>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="memory-note">No pattern stands out yet in your posts.</p>
          )}
        </section>
        <section className="dash-card" aria-labelledby="improve-title">
          <div className="dash-card-head">
            <h2 id="improve-title">Needs improvement</h2>
          </div>
          <ul className="strategy-recs">
            {weak.map((item) => (
              <li key={item.id}>
                {item.text}
                {item.confidence && (
                  <small className="memory-note">
                    {" "}
                    Confidence: {CONFIDENCE_LABEL[item.confidence]} · {item.sampleSize} posts
                  </small>
                )}
              </li>
            ))}
            {evidence.missing.map((text) => (
              <li key={text} className="strategy-missing">
                {text}
              </li>
            ))}
          </ul>
          {weak.length === 0 && evidence.missing.length === 0 && <p className="memory-note">Nothing flagged.</p>}
        </section>
      </div>

      {content?.roadmap && content.roadmap.length > 0 && (
        <section className="dash-card" aria-labelledby="roadmap-title">
          <div className="dash-card-head">
            <h2 id="roadmap-title">Four-week roadmap</h2>
            <InfoHint label="About the roadmap">
              Direction for your first month; this week&apos;s plan below is what to do now. No follower targets or growth rates: Scout
              can&apos;t promise those.{content.roadmap[0]?.source === "template" ? " This roadmap is Scout's standard one for your stage." : ""}
            </InfoHint>
          </div>
          <ol className="strategy-roadmap">
            {content.roadmap.map((week) => (
              <li key={week.week}>
                <span className="strategy-pill">Week {week.week}</span>
                <strong>{week.objective}</strong>
                <ul className="strategy-list">
                  {week.activities.map((activity) => (
                    <li key={activity}>{activity}</li>
                  ))}
                </ul>
                <p className="memory-note">
                  Milestone: {week.milestone} · Measure: {week.measure.join(", ")}
                </p>
                <p className="strategy-task-meta">
                  {week.modules.map((module) => (
                    <Link key={module} href={MODULE_LINK[module].href} className="text-link">
                      {MODULE_LINK[module].label}
                    </Link>
                  ))}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {strategy && content && (
        <section className="dash-card" aria-labelledby="plan-title">
          <div className="dash-card-head">
            <h2 id="plan-title">Weekly plan</h2>
            <span className="strategy-pill">
              {doneCount} of {view.tasks.length} done
            </span>
          </div>
          {planReminders !== null && !view.isHistory && <GrowthPlanRemindersButton active={planReminders} />}
          {view.tasks.length === 0 ? (
            <p className="memory-note">No tasks fit this week.</p>
          ) : (
            <div className="strategy-week">
              {days.map((day) => {
                const tasks = view.tasks.filter((task) => task.day === day);
                return (
                  <div key={day} className="strategy-day" data-today={day === today ? "" : undefined}>
                    <h3>{dayLabel(day, today)}</h3>
                    {tasks.length ? (
                      <ul>
                        {tasks.map((task) => (
                          <TaskCard key={task.id} task={task} days={dayOptions} />
                        ))}
                      </ul>
                    ) : (
                      <p className="memory-note">Rest day.</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section className="dash-card" aria-labelledby="peers-title">
        <div className="dash-card-head">
          <h2 id="peers-title">Peer intelligence</h2>
          <span className="strategy-pill">{PEER_MODE_LABEL[peerMode]}</span>
        </div>
        <p className="memory-note">
          Accounts you&apos;d like to learn from. Scout compares each account&apos;s posts with its own other posts (never raw numbers
          across accounts) and turns patterns into ideas to test. {peerMode === "selected"
            ? "My selected accounts: the plan uses exactly the accounts you select, nothing else."
            : "Scout recommended: the plan uses your most comparable accounts, direct peers first."}
        </p>
        {view.peersUnavailable ? (
          <p className="memory-note">Peer intelligence isn&apos;t available right now: the database needs an update.</p>
        ) : view.peers.length === 0 ? (
          <p className="memory-note">No accounts yet.</p>
        ) : (
          <ul className="peer-list">
            {view.peers.map(({ peer, score, stats, findings, sufficient, lastPostAt }) => (
              <li key={peer.id} className="peer-row" data-used={view.peersUsed.includes(peer.id) ? "" : undefined}>
                <div className="peer-main">
                  <strong>@{peer.handle}</strong>
                  <span className="strategy-pill" data-category={score.category}>
                    {PEER_CATEGORY_LABEL[score.category]}
                  </span>
                  {view.peersUsed.includes(peer.id) && <span className="strategy-pill">In this plan</span>}
                  <p className="memory-note">
                    {peer.followers === null ? "Followers unknown" : `${peer.followers.toLocaleString("en-US")} followers`} ·{" "}
                    {stats.length === 0
                      ? "No posts read yet"
                      : `${stats.length} posts read (${fmtDate(stats.reduce((a, b) => (a.postedAt < b.postedAt ? a : b)).postedAt)}–${fmtDate(lastPostAt)})`}{" "}
                    ·{" "}
                    {sufficient
                      ? `${findings.length} ${findings.length === 1 ? "pattern" : "patterns"}`
                      : `needs ${PEER_MIN_POSTS}+ posts to compare`}
                    {peer.lastRefreshedAt && ` · read from X ${fmtDate(peer.lastRefreshedAt)}`}
                  </p>
                  <InfoHint label="Why this category">
                    <ul className="strategy-list">
                      {score.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </InfoHint>
                </div>
                <PeerRowControls peerId={peer.id} handle={peer.handle} selected={peer.selected} refreshEnabled={view.peerRefreshEnabled} />
              </li>
            ))}
          </ul>
        )}
        <AddPeerForm disabled={view.peersUnavailable || view.peers.length >= view.peerLimit} />
        <p className="memory-note">
          {view.peers.length} of {view.peerLimit} accounts. Adding one reads its public profile from X once.{" "}
          {view.peerRefreshEnabled
            ? "You can read a peer's recent posts once a week (uses your plan's X reads)."
            : "Scout analyzes posts it has already read for you: add an account to your watchlist so scans read its posts. Reading peers' posts directly isn't enabled yet."}
        </p>
        {view.suggestions.length > 0 && (
          <details className="more-list">
            <summary>Suggestions from your watchlist and scans ({view.suggestions.length})</summary>
            <ul className="peer-suggestions">
              {view.suggestions.map((suggestion) => (
                <li key={suggestion.platformUserId}>
                  <span>
                    @{suggestion.handle} <small className="memory-note">· suggestion: {suggestion.reason}</small>
                  </span>
                  <AddSuggestionButton handle={suggestion.handle} source={suggestion.source} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="dash-card" aria-labelledby="experiments-title">
        <div className="dash-card-head">
          <h2 id="experiments-title">Experiments</h2>
          <InfoHint label="How experiments are measured">
            Scout splits your own posts published while an experiment runs by length, opening line or time of day, and compares medians
            once each side has enough posts. With small samples the result is only directional. Topics and news change too, so use your
            observations alongside the numbers.
          </InfoHint>
        </div>
        {active.length + proposed.length === 0 && <p className="memory-note">No experiments running.</p>}
        <div className="strategy-experiments">
          {active.map(({ experiment, result }) => (
            <ExperimentCard key={experiment.id} experiment={experiment} result={result} review={reviews.get(experiment.id)} />
          ))}
          {proposed.map(({ experiment, result }) => (
            <ExperimentCard key={experiment.id} experiment={experiment} result={result} />
          ))}
        </div>
        {presets.length > 0 && (
          <details className="more-list">
            <summary>Start a ready-made experiment</summary>
            <ul className="strategy-presets">
              {presets.map((preset) => (
                <li key={preset.key}>
                  <p>
                    <strong>{preset.title}</strong> · {preset.hypothesis}
                  </p>
                  <PresetButton presetKey={preset.key} title={preset.title} />
                </li>
              ))}
            </ul>
          </details>
        )}
        {finished.length > 0 && (
          <details className="more-list">
            <summary>Finished experiments ({finished.length})</summary>
            <div className="strategy-experiments">
              {finished.map(({ experiment, result }) => (
                <ExperimentCard key={experiment.id} experiment={experiment} result={result} />
              ))}
            </div>
          </details>
        )}
      </section>

      {view.history.length > 0 && (
        <section className="dash-card" aria-labelledby="history-title">
          <div className="dash-card-head">
            <h2 id="history-title">Strategy history</h2>
          </div>
          <ul className="strategy-history">
            {view.history.map((item) => (
              <li key={item.id}>
                <Link href={item.status === "active" ? "/strategy" : `/strategy?strategy=${item.id}`} className="text-link">
                  Week of {item.weekStart}
                </Link>{" "}
                · {OBJECTIVE_LABEL[item.objective as StrategyObjective] ?? item.objective} · {item.mode === "starter" ? "starter plan" : "evidence-based"} ·{" "}
                {item.done} of {item.tasks} tasks done{item.status === "active" && " · current"}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
