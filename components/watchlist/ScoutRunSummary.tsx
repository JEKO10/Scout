import type { ScoutRun } from "@/db/schema";
import type { CandidateFilterReason } from "@/lib/scout/types";

// Keys from older runs (e.g. low_context_reply) stay readable
const filterLabels: Record<CandidateFilterReason | "low_context_reply", string> = {
  already_seen: "already seen",
  repost: "reposts",
  empty: "empty / link only",
  too_old: "too old",
  reply: "replies",
  low_context_reply: "short replies",
};

const sourceLabels: Record<string, string> = {
  x_api: "X API",
  import: "imports",
};

export function ScoutRunSummary({ run }: { run: ScoutRun }) {
  const { stats } = run;
  if (!stats) {
    return run.error ? <p className="scout-run-error">{run.error}</p> : null;
  }

  const filteredTotal = Object.values(stats.filtered).reduce((a, b) => a + b, 0);
  const filteredDetail = (Object.entries(stats.filtered) as [keyof typeof filterLabels, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${filterLabels[reason]}`)
    .join(", ");

  return (
    <div className="scout-run-summary">
      <p className="eyebrow">
        {run.status === "completed" ? "Scout run complete" : "Scout run failed"}
      </p>
      <dl>
        <div>
          <dt>Accounts scanned</dt>
          <dd>
            {stats.accountsScanned} / {stats.accountsTotal}
          </dd>
        </div>
        <div>
          <dt>Posts fetched</dt>
          <dd>{stats.postsFetched}</dd>
        </div>
        <div>
          <dt>Duplicates</dt>
          <dd>{stats.duplicates}</dd>
        </div>
        <div>
          <dt>Filtered</dt>
          <dd title={filteredDetail}>{filteredTotal}</dd>
        </div>
        <div>
          <dt>Candidates</dt>
          <dd>{stats.candidates}</dd>
        </div>
        {stats.scoring && (
          <>
            <div>
              <dt>Scored by AI</dt>
              <dd>{stats.scoring.scored}</dd>
            </div>
            <div className="scout-run-total">
              <dt>Opportunities</dt>
              <dd>{stats.scoring.surfaced}</dd>
            </div>
          </>
        )}
      </dl>
      {stats.scoring?.skippedReason && (
        <p className="scout-run-note">{stats.scoring.skippedReason}</p>
      )}
      {(stats.scoring?.unscored ?? 0) > 0 && !stats.scoring?.skippedReason && (
        <p className="scout-run-note">
          {stats.scoring?.unscored} candidates weren&apos;t scored; the next run retries them.
        </p>
      )}
      {filteredDetail && <p className="scout-run-note">Filtered: {filteredDetail}.</p>}
      {Object.keys(stats.sources).length > 0 && (
        <p className="scout-run-note">
          Sources:{" "}
          {Object.entries(stats.sources)
            .map(([source, count]) => `${sourceLabels[source] ?? source} (${count})`)
            .join(", ")}
        </p>
      )}
      {stats.failures.length > 0 && (
        <ul className="scout-run-failures">
          {stats.failures.map((failure) => (
            <li key={failure.handle}>
              ⚠️ @{failure.handle}: {failure.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
