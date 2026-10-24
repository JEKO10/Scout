import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppHeader } from "@/components/AppHeader";
import { EvalCaseManager } from "@/components/eval/EvalCaseManager";
import { EvalRunner } from "@/components/eval/EvalRunner";
import { EvalScorecardView } from "@/components/eval/EvalScorecardView";
import { RunEvalButton } from "@/components/eval/RunEvalButton";
import { getEvalCases, getEvalRuns } from "@/db/queries/eval";
import { requireProfile } from "@/lib/auth/session";
import { computeScorecard } from "@/services/brain-eval/scorecard";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export default function EvalPage() {
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
        <Eval />
      </Suspense>
    </div>
  );
}

async function Eval() {
  const { profile } = await requireProfile();
  if (!profile.onboardingCompleted) redirect("/onboarding");

  const [cases, runs] = await Promise.all([
    getEvalCases(profile.id),
    getEvalRuns(profile.id),
  ]);
  const brain = resolveScoutBrain(profile);
  const latestRun = runs[0];
  const brainChanged =
    brain && latestRun && latestRun.brainAnalyzedAt.getTime() !== brain.analyzedAt.getTime();

  return (
    <main className="workspace shell enter-content">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Day 6 · Brain eval</p>
          <h1>Would you actually post this?</h1>
          <p className="lede">
            Scout reads {cases.length} posts it has never seen, decides whether you
            should engage, and drafts a reply. You judge every one.
          </p>
        </div>
        {brain && cases.length > 0 && <RunEvalButton hasRun={Boolean(latestRun)} />}
      </section>

      {!brain ? (
        <p className="eval-note">
          Analyze your profile on the dashboard first. The eval tests your Scout Brain.
        </p>
      ) : (
        brainChanged && (
          <p className="eval-note">
            Your Scout Brain was re-analyzed after the latest run. Run the eval again to
            test the new version.
          </p>
        )
      )}

      {latestRun && (
        <>
          <EvalScorecardView
            scorecard={computeScorecard(latestRun.results)}
            caption={`Run of ${dateFormat.format(latestRun.createdAt)} · Brain from ${dateFormat.format(latestRun.brainAnalyzedAt)}`}
          />
          <EvalRunner key={latestRun.id} results={latestRun.results} />
        </>
      )}

      {runs.length > 1 && (
        <section className="eval-section" aria-labelledby="eval-history-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Compare</p>
              <h2 id="eval-history-title">Previous runs</h2>
            </div>
          </div>
          <div className="eval-history">
            {runs.map((run) => {
              const scorecard = computeScorecard(run.results);
              return (
                <div key={run.id} className="eval-history-row">
                  <span>{dateFormat.format(run.createdAt)}</span>
                  {scorecard.criteria.map((criterion) => (
                    <span key={criterion.label}>
                      <small>{criterion.label}</small>
                      {criterion.value}
                    </span>
                  ))}
                  <span>
                    <small>Rated</small>
                    {scorecard.rated}/{scorecard.total}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <EvalCaseManager cases={cases} />
    </main>
  );
}
