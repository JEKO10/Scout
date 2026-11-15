import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";

import { PricingPlans } from "@/components/pricing/PricingPlans";
import { getOptionalUser } from "@/lib/auth/session";
import { isPaidTier, PRICING_TIERS } from "@/lib/billing/pricing";
import { countryFromHeader, readPaddleConfig } from "@/lib/paddle/config";

export const metadata: Metadata = { title: "Pricing" };

// Public: the Subscribe buttons ask for sign-in, the page itself doesn't
export default function PricingPage({ searchParams }: PageProps<"/pricing">) {
  return (
    <main className="landing-page pricing-page">
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
    </main>
  );
}

async function Pricing({ searchParams }: { searchParams: PageProps<"/pricing">["searchParams"] }) {
  const [{ plan }, requestHeaders, user] = await Promise.all([searchParams, headers(), getOptionalUser()]);
  const paddle = readPaddleConfig();

  return (
    <PricingPlans
      tiers={PRICING_TIERS}
      paddle={paddle}
      country={countryFromHeader(requestHeaders.get("x-vercel-ip-country"))}
      email={user?.email ?? null}
      userId={user?.id ?? null}
      // A plan picked before sign-in: its checkout opens on return
      resumePlan={isPaidTier(plan) && user ? plan : null}
    />
  );
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
