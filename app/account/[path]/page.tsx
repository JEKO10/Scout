import { AccountView } from "@neondatabase/auth-ui";
import { accountViewPaths } from "@neondatabase/auth-ui/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { updateProfile } from "@/actions/profile";
import { AccountDataOverview } from "@/components/AccountDataOverview";
import { AppHeader } from "@/components/AppHeader";
import { AutoScoutSettings } from "@/components/AutoScoutSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { OpportunitySensitivityForm } from "@/components/OpportunitySensitivityForm";
import { ProfileForm } from "@/components/ProfileForm";
import { ReplyPreferencesForm } from "@/components/ReplyPreferencesForm";
import { getWorkspaceData } from "@/db/queries/opportunities";
import { requireProfile } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { detectPreferenceConflicts, normalizeReplyPreferences } from "@/lib/scout/replyPreferences";
import { getNotificationOverview } from "@/services/notifications/overview";
import { getAutoScoutStatus } from "@/services/scheduler/autoScoutStatus";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

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
  const [data, autoScout, notifications] = await Promise.all([
    getWorkspaceData(profile.id),
    getAutoScoutStatus(profile),
    getNotificationOverview(profile.id),
  ]);

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
    </>
  );
}
