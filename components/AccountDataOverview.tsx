import Link from "next/link";

import type { WorkspaceData } from "@/db/queries/opportunities";
import type { Profile } from "@/db/schema";

const dateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function AccountDataOverview({
  profile,
  data,
}: {
  profile: Profile;
  data: WorkspaceData;
}) {
  return (
    <section className="data-overview" aria-labelledby="data-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Your data</p>
          <h2 id="data-title">What Scout knows</h2>
          <p>
            A transparent view of the sources and intelligence connected to your
            profile.
          </p>
        </div>
        <Link href="/dashboard" className="secondary-button">
          View dashboard
        </Link>
      </div>

      <div className="record-strip" aria-label="Database record counts">
        <RecordCount label="Social accounts" value={data.socialAccounts.length} />
        <RecordCount label="Posts" value={data.posts.length} />
        <RecordCount label="Watchlist" value={data.watchlist.length} />
        <RecordCount label="Opportunities" value={data.opportunities.length} />
        <RecordCount label="Replies" value={data.replies.length} />
      </div>

      <div className="data-section">
        <div className="data-section-heading">
          <h3>Profile intelligence</h3>
          <p>Generated context used to rank and write in your voice.</p>
        </div>
        <div className="brain-grid">
          <Brain title="Voice brain" value={profile.voiceBrain} />
          <Brain title="Interest brain" value={profile.interestBrain} />
          <Brain title="Goal brain" value={profile.goalBrain} />
        </div>
      </div>

      <div className="data-split">
        <DataList
          title="Connected accounts"
          description="Your own accounts and sync status."
          empty="No social accounts connected."
        >
          {data.socialAccounts.map((account) => (
            <li key={account.id} className="data-row">
              <span className="platform-mark">{account.platform.charAt(0).toUpperCase()}</span>
              <div>
                <strong>@{account.handle}</strong>
                <span>{account.displayName ?? humanize(account.platform)}</span>
              </div>
              <time>{formatDate(account.lastSyncedAt)}</time>
            </li>
          ))}
        </DataList>

        <DataList
          title="Watchlist"
          description="Accounts Scout monitors for opportunities."
          empty="No accounts in your watchlist."
        >
          {data.watchlist.map((account) => (
            <li key={account.id} className="data-row">
              <span className="platform-mark">{account.handle.charAt(0).toUpperCase()}</span>
              <div>
                <strong>@{account.handle}</strong>
                <span>{account.notes ?? humanize(account.platform)}</span>
              </div>
              <span className="subtle-state">
                {account.isActive ? "Active" : "Paused"}
              </span>
            </li>
          ))}
        </DataList>
      </div>

      <div className="data-split">
        <DataList
          title="Scout runs"
          description="Every scan stored for this profile."
          empty="Scout has not run yet."
        >
          {data.scoutRuns.map((run) => (
            <li key={run.id} className="data-row run-row">
              <span className="run-state" data-status={run.status} />
              <div>
                <strong>{humanize(run.status)}</strong>
                <span>{run.opportunitiesFound} opportunities found</span>
              </div>
              <time>{formatDate(run.completedAt ?? run.createdAt)}</time>
            </li>
          ))}
        </DataList>

        <DataList
          title="Generated replies"
          description="Drafts and replies associated with your opportunities."
          empty="No replies generated yet."
        >
          {data.replies.map(({ reply, opportunity }) => (
            <li key={reply.id} className="reply-data-row">
              <div>
                <span className="subtle-state">{humanize(reply.status)}</span>
                <span>@{opportunity.authorHandle ?? "unknown"}</span>
              </div>
              <p>{reply.content}</p>
            </li>
          ))}
        </DataList>
      </div>

      <p className="data-footnote">
        Profile created {formatDate(profile.createdAt)} · Last updated {formatDate(profile.updatedAt)}
      </p>
    </section>
  );
}

function Brain({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown> | null;
}) {
  return (
    <div className="brain-column">
      <h4>{title}</h4>
      {value && Object.keys(value).length ? (
        <dl>
          {Object.entries(value).map(([key, item]) => (
            <div key={key}>
              <dt>{humanize(key)}</dt>
              <dd>{formatBrainValue(item)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>Not generated yet.</p>
      )}
    </div>
  );
}

function DataList({
  title,
  description,
  empty,
  children,
}: {
  title: string;
  description: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);

  return (
    <div className="data-list-block">
      <div className="data-section-heading">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {hasChildren ? <ul>{children}</ul> : <p className="data-empty">{empty}</p>}
    </div>
  );
}

function RecordCount({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function formatBrainValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "—");
}

function formatDate(value: Date | null) {
  return value ? dateFormat.format(value) : "Not synced";
}

function humanize(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
