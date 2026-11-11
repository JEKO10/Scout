import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { requireProfile } from "@/lib/auth/session";
import { PLANS } from "@/lib/billing/plans";
import { isScoutTestMode } from "@/lib/scout/testLimits";
import { X_PRICING } from "@/lib/x/pricing";
import { getRunAnalytics, type RunAnalytics } from "@/services/analytics/runAnalytics";

// Development-only: what each Scout run read, found and cost.

const usd = (value: number) => (value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`);
const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const value = (number: number | null) => (number === null ? "–" : number.toLocaleString("en"));

export default function RunAnalyticsPage() {
  return (
    <div className="app-page">
      <AppHeader />
      <Suspense
        fallback={
          <main className="workspace shell" aria-busy="true">
            <div className="skeleton skeleton-title" />
          </main>
        }
      >
        <RunAnalyticsView />
      </Suspense>
    </div>
  );
}

async function RunAnalyticsView() {
  const { profile } = await requireProfile();
  if (process.env.NODE_ENV === "production" && !isScoutTestMode()) notFound();
  if (!profile.onboardingCompleted) redirect("/onboarding");

  const { runs, budget, autoScout } = await getRunAnalytics(profile);
  const autoRuns = runs.filter((run) => run.trigger === "auto");
  const autoTotals = autoRuns.reduce(
    (sum, run) => ({
      postReads: sum.postReads + (run.postResources ?? 0),
      aiUsd: sum.aiUsd + run.scoringUsd + run.replyUsd,
      opportunities: sum.opportunities + run.opportunities,
    }),
    { postReads: 0, aiUsd: 0, opportunities: 0 },
  );
  const totals = runs.reduce(
    (sum, run) => ({
      totalUsd: sum.totalUsd + run.totalUsd,
      opportunities: sum.opportunities + run.opportunities,
    }),
    { totalUsd: 0, opportunities: 0 },
  );

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Development · last {runs.length} runs</p>
          <h1>Run analytics</h1>
          <p className="lede">
            What every scan read, found and cost. X cost is the real X usage the run caused,
            estimated at ${X_PRICING.postRead} per post and ${X_PRICING.userRead} per account
            lookup; a run that reused the shared cache costs nothing on X. Plan reads are what
            your plan is charged: posts delivered to you, whoever fetched them. AI cost comes from
            recorded token usage. Your X and OpenAI bills are the truth.
          </p>
        </div>
      </section>

      <section className="metrics-strip" aria-label="This month">
        <Metric
          value={`${budget.used.xPostReads.toLocaleString("en")} / ${budget.limits.monthlyXPostReads.toLocaleString("en")}`}
          label="X post reads this month"
        />
        <Metric
          value={`${usd(budget.used.scoringUsd)} / ${usd(budget.limits.monthlyScoringUsd)}`}
          label="AI scoring this month"
        />
        <Metric
          value={`${usd(budget.used.replyUsd)} / ${usd(budget.limits.monthlyReplyUsd)}`}
          label="Reply generation this month"
        />
        <Metric
          value={totals.opportunities ? usd(totals.totalUsd / totals.opportunities) : "–"}
          label="Avg. cost per opportunity"
        />
      </section>
      <p className="memory-note">
        Plan: {PLANS[budget.plan].label} · up to {budget.limits.maxActiveWatchlist} active accounts ·{" "}
        {budget.limits.maxCandidatesPerRun} candidates scored per run · scoring ≈{" "}
        {usd(budget.scoringUsdPerCandidate)} per candidate.
      </p>

      <section className="memory-section" aria-labelledby="auto-title">
        <p className="eyebrow">Last 7 days</p>
        <h2 id="auto-title">Automatic Scout</h2>
        <section className="metrics-strip" aria-label="Automatic Scout">
          <Metric value={String(autoScout.started)} label="Jobs started" />
          <Metric value={String(autoScout.completed)} label="Completed" />
          <Metric value={String(autoScout.failed)} label="Failed" />
          <Metric value={String(autoScout.skippedForBudget)} label="Skipped: budget" />
          <Metric value={String(autoScout.busyAccounts)} label="Accounts skipped: locked" />
          <Metric
            value={autoScout.avgDurationMs === null ? "–" : `${Math.round(autoScout.avgDurationMs / 1000)} s`}
            label="Avg. scan duration"
          />
        </section>
        <p className="memory-note">
          Automatic runs below: {autoTotals.postReads.toLocaleString("en")} X post reads ·{" "}
          {usd(autoTotals.aiUsd)} OpenAI · {autoTotals.opportunities} opportunities.
          {autoScout.jobs.some((row) => row.status === "skipped") &&
            ` Skips: ${autoScout.jobs
              .filter((row) => row.status === "skipped")
              .map((row) => `${row.skipReason} ${row.jobs}`)
              .join(", ")}.`}
        </p>
      </section>

      {runs.length ? (
        <div className="analytics-table-wrap">
          <table className="analytics-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Trigger</th>
                <th>Accounts</th>
                <th title="Timeline requests (and account lookups)">X requests</th>
                <th title="Post resources X returned and billed">Post reads</th>
                <th title="Of post reads: quoted posts read for context">Quoted</th>
                <th title="Shared cache: accounts refreshed from X / reused as fresh">Cache</th>
                <th title="Posts delivered to you from the shared cache: what your plan is charged">
                  Plan reads
                </th>
                <th>Candidates</th>
                <th>Opps</th>
                <th>X cost</th>
                <th>Scoring</th>
                <th title="Replies generated for this run's opportunities">Replies</th>
                <th>Total</th>
                <th>Per opp</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="memory-note">No runs yet.</p>
      )}
    </main>
  );
}

function RunRow({ run }: { run: RunAnalytics }) {
  return (
    <tr data-status={run.status}>
      <td>
        {dateFormat.format(run.startedAt)}
        {run.status !== "completed" && <span className="analytics-status"> · {run.status}</span>}
        {run.note && <small>{run.note}</small>}
      </td>
      <td>{run.trigger}</td>
      <td>{run.accounts}</td>
      <td>
        {value(run.xRequests)}
        {run.userLookups ? ` (+${run.userLookups})` : ""}
      </td>
      <td>{value(run.postResources)}</td>
      <td>{value(run.quotedReads)}</td>
      <td>{run.cache ? `${run.cache.fetched} / ${run.cache.reused}` : "–"}</td>
      <td>{value(run.planReads)}</td>
      <td>
        {value(run.candidates)}
        {run.scored !== null && run.candidates !== null && run.scored !== run.candidates
          ? ` (${run.scored} scored)`
          : ""}
      </td>
      <td>{run.opportunities}</td>
      <td>{usd(run.xUsd)}</td>
      <td>{usd(run.scoringUsd)}</td>
      <td>{usd(run.replyUsd)}</td>
      <td>
        <strong>{usd(run.totalUsd)}</strong>
      </td>
      <td>{run.costPerOpportunity === null ? "–" : usd(run.costPerOpportunity)}</td>
    </tr>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
