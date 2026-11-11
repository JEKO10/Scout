import type { ScoutRun } from "@/db/schema";
import type { CandidateFilterReason } from "@/lib/scout/types";
import type { ScoutTestStatus } from "@/services/scout/testStatus";

// Keys from older runs (e.g. low_context_reply) stay readable
const filterLabels: Record<CandidateFilterReason | "low_context_reply", string> = {
  already_seen: "already seen",
  repost: "reposts",
  empty: "empty / link only",
  too_old: "too old",
  reply: "replies",
  quote_without_context: "quotes without context",
  low_context_reply: "short replies",
};

const sourceLabels: Record<string, string> = {
  x_api: "X API",
  import: "imports",
};

const of = (value: number, max: number | null) => (max === null ? `${value}` : `${value} / ${max}`);

export function ScoutRunSummary({
  run,
  testing,
  aiCostUsd,
}: {
  run: ScoutRun;
  /** Estimated OpenAI cost of this run's scoring */
  aiCostUsd?: number;
  /** Daily totals, shown while testing mode is on */
  testing?: ScoutTestStatus;
}) {
  const { stats } = run;
  if (!stats) {
    return run.error ? <p className="scout-run-error">{run.error}</p> : null;
  }

  const filteredTotal = Object.values(stats.filtered).reduce((a, b) => a + b, 0);
  const filteredDetail = (Object.entries(stats.filtered) as [keyof typeof filterLabels, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${filterLabels[reason]}`)
    .join(", ");
  const repliesAndReposts = (stats.filtered.reply ?? 0) + (stats.filtered.repost ?? 0);
  const partial = run.status === "completed" && stats.accountsFailed > 0;

  return (
    <div className="scout-run-summary">
      <p className="eyebrow">
        {run.status !== "completed"
          ? "Scout run failed"
          : partial
            ? "Scout run partly complete"
            : "Scout run complete"}
      </p>
      <dl>
        <div>
          <dt>Accounts scanned</dt>
          <dd>
            {stats.accountsScanned} / {stats.accountsTotal}
          </dd>
        </div>
        {stats.xApi && (
          <div>
            <dt>X API requests</dt>
            <dd title={`${stats.xApi.failed} failed, ${stats.xApi.retried} retried`}>
              {stats.xApi.requests}
            </dd>
          </div>
        )}
        <div>
          <dt>Posts fetched</dt>
          <dd>{stats.postsFetched}</dd>
        </div>
        <div>
          <dt>Duplicates removed</dt>
          <dd>{stats.duplicates}</dd>
        </div>
        <div>
          <dt>Replies/reposts filtered</dt>
          <dd>{repliesAndReposts}</dd>
        </div>
        <div>
          <dt>Other filtered</dt>
          <dd title={filteredDetail}>{filteredTotal - repliesAndReposts}</dd>
        </div>
        <div>
          <dt>Valid candidates</dt>
          <dd>{stats.candidates}</dd>
        </div>
        {stats.scoring && (
          <>
            <div>
              <dt>Scored by AI</dt>
              <dd>{stats.scoring.scored}</dd>
            </div>
            <div className="scout-run-total">
              <dt>Opportunities found</dt>
              <dd>{stats.scoring.surfaced}</dd>
            </div>
          </>
        )}
        {aiCostUsd !== undefined && (
          <div>
            <dt>AI cost (estimated)</dt>
            <dd>{aiCostUsd > 0 && aiCostUsd < 0.01 ? "<$0.01" : `$${aiCostUsd.toFixed(2)}`}</dd>
          </div>
        )}
        {testing?.enabled && (
          <>
            <div>
              <dt>Daily API requests</dt>
              <dd>{of(testing.requestsToday, testing.maxRequests)}</dd>
            </div>
            <div>
              <dt>Scout runs (24 h)</dt>
              <dd>{of(testing.runsUsed, testing.maxRuns)}</dd>
            </div>
          </>
        )}
      </dl>
      {stats.xApi?.stoppedReason && (
        <p className="scout-run-error">
          X stopped: {stats.xApi.stoppedReason} Accounts after that used imported posts.
        </p>
      )}
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
