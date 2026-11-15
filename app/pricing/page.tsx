import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";

import { TrackView } from "@/components/analytics/Track";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { PricingPlans } from "@/components/pricing/PricingPlans";
import { getProfileByUserId } from "@/db/queries/profiles";
import { getOptionalUser } from "@/lib/auth/session";
import { isPaidTier, PRICING_TIERS,type PricingAccount } from "@/lib/billing/pricing";
import { countryFromHeader, isCheckoutOpen, readPaddleConfig } from "@/lib/paddle/config";
import { ACCESS_STATUSES } from "@/lib/paddle/webhook";
import { getBillingOverview } from "@/services/billing/account";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Scout is free during the beta. Starter and Pro plans with more accounts and more frequent scans are coming soon.",
  alternates: { canonical: "/pricing" },
};

// Public: the Subscribe buttons ask for sign-in, the page itself doesn't
export default function PricingPage({ searchParams }: PageProps<"/pricing">) {
  return (
    <main className="landing-page pricing-page">
      <TrackView name="pricing_view" />
      <nav className="landing-nav shell" aria-label="Main navigation">
        <Link href="/" className="brand" aria-label="Scout home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Scout</span>
        </Link>
        <div>
          <Link href="/dashboard" className="nav-text-link">Dashboard</Link>
        </div>
      </nav>

      <section className="shell pricing-hero enter-content">
        <p className="eyebrow">Pricing</p>
        <h1>Pick how much Scout watches for you.</h1>
        <p>Start free. Upgrade when you want more accounts and more frequent scans.</p>
      </section>

      <section className="shell">
        <Suspense fallback={<PricingSkeleton />}>
          <Pricing searchParams={searchParams} />
        </Suspense>
      </section>
      <SiteFooter />
    </main>
  );
}

async function Pricing({ searchParams }: { searchParams: PageProps<"/pricing">["searchParams"] }) {
  const [{ plan }, requestHeaders, user] = await Promise.all([searchParams, headers(), getOptionalUser()]);
  const paddle = readPaddleConfig();
  const account = user ? await pricingAccount(user.id) : null;

  return (
    <PricingPlans
      tiers={PRICING_TIERS}
      paddle={paddle}
      country={countryFromHeader(requestHeaders.get("x-vercel-ip-country"))}
      email={user?.email ?? null}
      userId={user?.id ?? null}
      account={account}
      checkoutOpen={isCheckoutOpen(paddle)}
      // A plan picked before sign-in: its checkout opens on return
      resumePlan={isPaidTier(plan) && user && !account?.subscription && account?.currentTier !== plan ? plan : null}
    />
  );
}

/** Read only: a signed-in user without a profile yet is simply on Free */
async function pricingAccount(userId: string): Promise<PricingAccount> {
  const profile = await getProfileByUserId(userId);
  if (!profile) return { currentTier: "free", subscription: null, internal: false };
  const billing = await getBillingOverview(profile);
  const granting = billing.subscription && ACCESS_STATUSES.has(billing.subscription.status) ? billing.subscription : null;
  const subscriptionTier = granting?.plan && isPaidTier(granting.plan) ? granting.plan : null;
  return {
    currentTier: subscriptionTier ?? (profile.plan === "internal" ? null : profile.plan),
    subscription: granting && { plan: subscriptionTier, changeBlockedBy: granting.changeBlockedBy },
    internal: profile.plan === "internal",
  };
}

function PricingSkeleton() {
  return (
    <div className="pricing-grid" aria-hidden="true">
      {PRICING_TIERS.map((tier) => (
        <div key={tier.id} className="pricing-card skeleton" />
      ))}
    </div>
  );
}
