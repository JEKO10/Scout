import { AccountView } from "@neondatabase/auth-ui";
import { accountViewPaths } from "@neondatabase/auth-ui/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { updateProfile } from "@/actions/profile";
import { DeleteAccount } from "@/components/account/DeleteAccount";
import { AccountDataOverview } from "@/components/AccountDataOverview";
import { AppHeader } from "@/components/AppHeader";
import { AutoScoutSettings } from "@/components/AutoScoutSettings";
import { PlanBilling } from "@/components/billing/PlanBilling";
import { InboxSettings } from "@/components/inbox/InboxSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { OpportunitySensitivityForm } from "@/components/OpportunitySensitivityForm";
import { ProfileForm } from "@/components/ProfileForm";
import { ReplyPreferencesForm } from "@/components/ReplyPreferencesForm";
import { XConnectionSettings } from "@/components/XConnectionSettings";
import { getWorkspaceData } from "@/db/queries/opportunities";
import { countActiveWatchlist } from "@/db/queries/watchlist";
import { requireProfile } from "@/lib/auth/session";
import { REPLY_USD_PER_GENERATION } from "@/lib/billing/pricing";
import { formatRelative } from "@/lib/format";
import { detectPreferenceConflicts, normalizeReplyPreferences } from "@/lib/scout/replyPreferences";
import { SCOPE_LABEL } from "@/lib/x/permissions";
import { getBillingOverview } from "@/services/billing/account";
import { BUDGET_MESSAGES, getUsageBudget, maxActiveWatchlist, scanBlockedBy } from "@/services/billing/budget";
import { autoPrepareAvailable, loadPreferences } from "@/services/inbox/inbox";
import { getNotificationOverview } from "@/services/notifications/overview";
import { getAutoScoutStatus } from "@/services/scheduler/autoScoutStatus";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";
import { getXConnectionOverview } from "@/services/x/oauthConnection";
import { getPublishingState } from "@/services/x/publishing";

export function generateStaticParams() {
  return Object.values(accountViewPaths).map((path) => ({ path }));
}

type Params = PageProps<"/account/[path]">["params"];

export default function AccountPage({ params }: PageProps<"/account/[path]">) {
  return (
    <div className="app-page">
      <AppHeader />
      <main className="settings-page shell enter-content">
        <div className="settings-heading">
          <p className="eyebrow">Account</p>
          <h1>Settings</h1>
          <p>Manage your identity, Scout context and connected data.</p>
        </div>
        <Suspense fallback={<div className="skeleton skeleton-settings" />}>
          <AccountContent params={params} />
        </Suspense>
      </main>
    </div>
  );
}

async function AccountContent({ params }: { params: Params }) {
  const { path } = await params;
  if (!(Object.values(accountViewPaths) as string[]).includes(path)) notFound();

  return (
    <div className="settings-content">
      <div className="auth-settings-panel">
        <AccountView path={path} />
      </div>
      {path === accountViewPaths.SETTINGS && <ScoutSettings />}
    </div>
  );
}

async function ScoutSettings() {
  const { profile } = await requireProfile();
  const [data, autoScout, notifications, billing, budget, activeAccounts, xConnection, inboxPrefs, publishing] = await Promise.all([
    getWorkspaceData(profile.id),
    getAutoScoutStatus(profile),
    getNotificationOverview(profile.id),
    getBillingOverview(profile),
    getUsageBudget(profile),
    countActiveWatchlist(profile.id),
    getXConnectionOverview(profile),
    loadPreferences(profile),
    getPublishingState(profile),
  ]);

  const blockedBy = scanBlockedBy(budget);

  // Reply preferences and anything in "avoid" that would also hide what the user wants
  const replyPreferences = normalizeReplyPreferences(profile.replyPreferences);
  const brain = resolveScoutBrain(profile);
  const conflicts = detectPreferenceConflicts({
    positive: [
      ...(brain?.interests.topics.map((topic) => topic.label) ?? []),
      ...(brain?.interests.expertise.map((item) => item.area) ?? []),
      ...replyPreferences.want,
    ],
    avoidTopics: profile.avoidTopics,
    preferences: replyPreferences,
  });

  return (
    <>
      <PlanBilling
        billing={billing}
        limits={budget.limits}
        usage={{
          xPostReads: budget.used.xPostReads,
          activeAccounts,
          maxActiveAccounts: maxActiveWatchlist(profile),
          xReadsNow: budget.remaining.xPostReads,
          scoredPostsNow: Math.floor(budget.remaining.scoringUsd / budget.scoringUsdPerCandidate),
          repliesLeft: Math.floor(budget.remaining.replyUsd / REPLY_USD_PER_GENERATION),
          nextScanNote: blockedBy ? BUDGET_MESSAGES[blockedBy] : null,
        }}
      />
      <AutoScoutSettings
        data={{
          enabled: autoScout.enabled,
          intervalMinutes: autoScout.intervalMinutes,
          intervals: autoScout.intervals,
          lastScanLabel: autoScout.lastAutoScanAt ? formatRelative(autoScout.lastAutoScanAt) : "never",
          nextScanLabel: autoScout.nextScanAt ? formatRelative(autoScout.nextScanAt) : "not scheduled",
          lastJob: autoScout.lastJob && {
            status: autoScout.lastJob.status,
            skipReason: autoScout.lastJob.skipReason,
            error: autoScout.lastJob.error,
          },
        }}
      />
      <InboxSettings
        data={{
          available: autoPrepareAvailable(),
          enabled: profile.autoPrepareEnabled,
          posts: budget.limits.maxAutoPosts,
          replies: budget.limits.maxAutoReplySets,
          window: budget.limits.autoPrepareWindow,
          monthlyCapUsd: budget.limits.maxAutoPrepareUsdPerMonth,
          learned: inboxPrefs.evidence,
        }}
      />
      <XConnectionSettings
        data={{
          enabled: xConnection.enabled,
          profileHandle: profile.xHandle,
          autoEveryHours: xConnection.autoEveryHours,
          importCap: xConnection.importCap,
          publishing: { available: publishing.available, canPublish: publishing.canPublish, planAllows: publishing.planAllows },
          connection: xConnection.connection && {
            handle: xConnection.connection.handle,
            displayName: xConnection.connection.displayName,
            avatarUrl: xConnection.connection.avatarUrl,
            state: xConnection.connection.state ?? "connected",
            status: xConnection.connection.status,
            lastError: xConnection.connection.lastError,
            permissions: xConnection.connection.scopes.map((scope) => SCOPE_LABEL[scope] ?? scope),
            imported: Boolean(xConnection.connection.initialImportAt),
            connectedLabel: formatRelative(xConnection.connection.connectedAt),
            lastCollectedLabel: xConnection.connection.lastCollectedAt ? formatRelative(xConnection.connection.lastCollectedAt) : null,
            nextCollectionLabel: xConnection.connection.nextCollectionAt ? formatRelative(xConnection.connection.nextCollectionAt) : null,
          },
        }}
      />
      <NotificationSettings
        data={{
          ...notifications,
          lastDelivery: notifications.lastDelivery && {
            status: notifications.lastDelivery.status,
            reason: notifications.lastDelivery.reason,
            timeLabel: formatRelative(notifications.lastDelivery.at),
          },
        }}
      />
      <ReplyPreferencesForm initial={replyPreferences} conflicts={conflicts} />
      <OpportunitySensitivityForm initial={profile.opportunitySensitivity} />
      <ProfileForm profile={profile} action={updateProfile} />
      <AccountDataOverview profile={profile} data={data} />
      <DeleteAccount />
    </>
  );
}
