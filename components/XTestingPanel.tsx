import { formatRelative } from "@/lib/format";
import type { ScoutTestStatus } from "@/services/scout/testStatus";

const of = (value: number, max: number | null) =>
  max === null ? `${value}` : `${value} / ${max}`;

/** Dashboard: X API Testing Mode limits and where they stand. */
export function XTestingPanel({ status }: { status: ScoutTestStatus }) {
  const { lastRun } = status;
  const stopped = lastRun?.stats?.xApi?.stoppedReason;

  return (
    <div className="aside-section scout-run-summary x-testing">
      <div className="aside-heading">
        <p className="eyebrow">X API Testing Mode</p>
        <span
          className="watchlist-status"
          data-active={status.enabled || undefined}
        >
          {status.enabled ? "On" : "Off"}
        </span>
      </div>
      <dl>
        <div>
          <dt>Scout runs (24 h)</dt>
          <dd>{of(status.runsUsed, status.maxRuns)}</dd>
        </div>
        <div>
          <dt title="Attempted requests across Scout today (UTC), failed ones and retries included. An estimate, not X billing.">
            X API requests today
          </dt>
          <dd>{of(status.requestsToday, status.maxRequests)}</dd>
        </div>
        <div>
          <dt>Active watchlist</dt>
          <dd>{of(status.activeAccounts, status.maxActiveAccounts)}</dd>
        </div>
        <div>
          <dt>Last successful scan</dt>
          <dd>
            {status.lastSuccessfulScanAt
              ? formatRelative(status.lastSuccessfulScanAt)
              : "Never"}
          </dd>
        </div>
        <div>
          <dt>Next scan</dt>
          <dd>
            {status.nextEligibleAt
              ? formatRelative(status.nextEligibleAt)
              : "Available now"}
          </dd>
        </div>
        {lastRun && (
          <div>
            <dt>Last scan</dt>
            <dd>
              {lastRun.status === "completed" && lastRun.stats
                ? `${lastRun.stats.accountsScanned}/${lastRun.stats.accountsTotal} accounts · ${lastRun.opportunitiesFound} found`
                : lastRun.status}
            </dd>
          </div>
        )}
      </dl>
      {stopped && (
        <p className="scout-run-error">X stopped on the last scan: {stopped}</p>
      )}
      {lastRun?.status === "failed" && lastRun.error && (
        <p className="scout-run-error">{lastRun.error}</p>
      )}
      <p className="scout-run-note">
        Request counts estimate usage; they are not your X bill.
      </p>
    </div>
  );
}
