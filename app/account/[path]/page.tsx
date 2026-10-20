import { AccountView } from "@neondatabase/auth-ui";
import { accountViewPaths } from "@neondatabase/auth-ui/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AccountDataOverview } from "@/components/AccountDataOverview";
import { AppHeader } from "@/components/AppHeader";
import { ProfileForm } from "@/components/ProfileForm";
import { getWorkspaceData } from "@/db/queries/opportunities";
import { requireProfile } from "@/lib/auth/session";
import { updateProfile } from "@/lib/profile/actions";

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
  const data = await getWorkspaceData(profile.id);

  return (
    <>
      <ProfileForm profile={profile} action={updateProfile} />
      <AccountDataOverview profile={profile} data={data} />
    </>
  );
}
