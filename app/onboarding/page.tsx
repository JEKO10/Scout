import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ProfileForm } from "@/components/ProfileForm";
import { requireProfile } from "@/lib/auth/session";
import { completeOnboarding } from "@/lib/profile/actions";

export default function OnboardingPage() {
  return (
    <main className="onboarding-page">
      <div className="onboarding-nav shell">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Scout</span>
        </Link>
        <span>Profile setup</span>
      </div>
      <div className="onboarding-shell enter-content">
        <div className="onboarding-heading">
          <p className="eyebrow">Step 1 of 1</p>
          <h1>Make Scout sound like you.</h1>
          <p>A little context is enough to improve every match from day one.</p>
        </div>
        <Suspense fallback={<div className="skeleton skeleton-settings" />}>
          <Onboarding />
        </Suspense>
      </div>
    </main>
  );
}

async function Onboarding() {
  const { profile } = await requireProfile();
  if (profile.onboardingCompleted) redirect("/dashboard");

  return (
    <ProfileForm
      profile={profile}
      action={completeOnboarding}
      title="About you"
      description="Scout uses these answers to understand your expertise, audience and goals."
      submitLabel="Open dashboard"
    />
  );
}
