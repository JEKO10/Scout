import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { CheckoutLanding } from "@/components/checkout/CheckoutLanding";
import { readPaddleConfig } from "@/lib/paddle/config";

export const metadata: Metadata = { title: "Checkout" };

/**
 * Paddle's default payment link. Public: Paddle sends people here with
 * ?_ptxn=txn_… (payment links, emails, "update payment method"), and Paddle.js
 * opens that transaction's checkout itself. Without that context, nothing is
 * started.
 */
export default function CheckoutPage({ searchParams }: PageProps<"/checkout">) {
  return (
    <main className="landing-page">
      <nav className="landing-nav shell" aria-label="Main navigation">
        <Link href="/" className="brand" aria-label="Scout home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>Scout</span>
        </Link>
      </nav>
      <section className="shell checkout-page enter-content">
        <Suspense fallback={<p>Loading checkout…</p>}>
          <Checkout searchParams={searchParams} />
        </Suspense>
      </section>
    </main>
  );
}

async function Checkout({ searchParams }: { searchParams: PageProps<"/checkout">["searchParams"] }) {
  const { _ptxn } = await searchParams;
  const transactionId = typeof _ptxn === "string" && /^txn_[a-z0-9]+$/.test(_ptxn) ? _ptxn : null;
  return <CheckoutLanding paddle={readPaddleConfig()} transactionId={transactionId} />;
}
