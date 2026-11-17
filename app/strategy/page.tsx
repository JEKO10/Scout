import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { EmptyState } from "@/components/EmptyState";
import { InfoHint, TitleWithHint } from "@/components/InfoHint";
import {
  ActiveExperimentControls,
  PresetButton,
  ProposedExperimentControls,
  StrategyForm,
  TaskControls,
} from "@/components/strategy/StrategyControls";
import type { GrowthExperiment, GrowthPlanTask } from "@/db/schema";
import { requireProfile } from "@/lib/auth/session";
import { CONFIDENCE_LABEL } from "@/lib/growth/analyze";
import { planDays } from "@/lib/strategy/plan";
import {
  type EvidenceItem,
  EXPERIMENT_PRESETS,
  type ExperimentResult,
  MEASURABLE_VARIANTS,
  MODULE_LINK,
  OBJECTIVE_LABEL,
  type StrategyModule,
  type StrategyObjective,
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
  const view = await loadStrategyView(profile, requested);
  await track("growth_strategy_viewed", { profileId: profile.id });

  const { evidence, strategy, today } = view;
  const s = evidence.snapshot;
  const items = new Map(evidence.items.map((item) => [item.id, item]));
  const works = evidence.items.filter((item) => item.kind === "works");
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
            initial={view.prefs}
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

      {(strategy?.mode ?? evidence.mode) === "starter" && (
        <div className="strategy-banner" data-kind="starter">
          <strong>Starter plan:</strong> there isn&apos;t enough history yet for evidence-based recommendations. This plan builds a
          baseline and tests ideas; treat its suggestions as hypotheses, not findings.
        </div>
      )}

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
                  <p>{p.why}</p>
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
                      <Evidence ids={r.evidenceIds} items={items} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="memory-note">Nothing has enough evidence yet. Your experiments will tell.</p>
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

      {strategy && content && (
        <section className="dash-card" aria-labelledby="plan-title">
          <div className="dash-card-head">
            <h2 id="plan-title">Weekly plan</h2>
            <span className="strategy-pill">
              {doneCount} of {view.tasks.length} done
            </span>
          </div>
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
