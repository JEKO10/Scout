import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { readPaddleConfig } from "@/lib/paddle/config";

export const metadata: Metadata = { title: "Payment received" };

/**
 * Shown after the browser reports a completed checkout. It changes nothing:
 * anyone can open this URL, so plans are activated only by verified Paddle
 * webhooks (next step).
 */
export default function CheckoutSuccessPage({ searchParams }: PageProps<"/checkout/success">) {
  return (
    <main className="landing-page">
      <nav className="landing-nav shell" aria-label="Main navigation">
        <Link href="/" className="brand" aria-label="Scout home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Scout</span>
        </Link>
      </nav>
      <section className="shell checkout-page enter-content">
        <p className="eyebrow">Checkout complete</p>
        <h1>Payment received.</h1>
        <Suspense fallback={null}>
          <Details searchParams={searchParams} />
        </Suspense>
        <p>
          Your plan will be upgraded once Paddle confirms the subscription. Until then your current
          limits stay as they are.
        </p>
        <div className="checkout-actions">
          <Link href="/dashboard" className="primary-button">
            Go to my dashboard
          </Link>
          <Link href="/pricing" className="secondary-button">
            Back to pricing
          </Link>
        </div>
      </section>
    </main>
  );
}

async function Details({ searchParams }: { searchParams: PageProps<"/checkout/success">["searchParams"] }) {
  const { transaction } = await searchParams;
  const paddle = readPaddleConfig();
  const sandbox = paddle.ok && paddle.config.environment === "sandbox";
  const id = typeof transaction === "string" && /^txn_[a-z0-9]+$/.test(transaction) ? transaction : null;
  return (
    <>
      {sandbox && (
        <p className="pricing-test-note checkout-detail">
          This was a Paddle Sandbox (test) payment. No real money was charged.
        </p>
      )}
      {id && (
        <p className="checkout-detail">
          Transaction <code>{id}</code>
        </p>
      )}
    </>
  );
}
