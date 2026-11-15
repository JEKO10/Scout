import type { Metadata } from "next";
import Link from "next/link";

import { LegalPage, Placeholder } from "@/components/marketing/LegalPage";

export const metadata: Metadata = {
  title: "Refund Policy",
  description: "How cancellations and refunds work for Scout's paid plans.",
  alternates: { canonical: "/refund-policy" },
};

// DRAFT for review before public launch, and before Paddle Live approval.
export default function RefundPolicyPage() {
  return (
    <LegalPage title="Refund Policy" updated="November 16, 2026">
      <p className="legal-review">
        Draft for review. The refund window in brackets must be decided by the operator and match the terms agreed
        with Paddle.
      </p>

      <h2>Free plan</h2>
      <p>The Free plan costs nothing, so there&apos;s nothing to refund.</p>

      <h2>Paid plans</h2>
      <p>
        Paid plans (Starter and Pro) are monthly subscriptions sold through Paddle, our reseller and Merchant of
        Record. Paid plans aren&apos;t on sale yet; this policy applies once they are.
      </p>
      <ul>
        <li>
          <strong>Cancel anytime:</strong> cancel in Settings → Plan &amp; billing. Your plan stays active until the
          end of the period you paid for and then moves to Free. Your data isn&apos;t deleted.
        </li>
        <li>
          <strong>Refunds:</strong> if you&apos;re not satisfied, ask for a refund within{" "}
          <Placeholder>number of days</Placeholder> days of a charge.
        </li>
        <li>
          <strong>Plan changes:</strong> upgrades charge the prorated difference at once; downgrades credit unused
          time to your next bill.
        </li>
        <li>When a payment is refunded in full, that subscription&apos;s paid plan ends and your account moves to Free.</li>
      </ul>

      <h2>How to ask</h2>
      <p>
        Contact us at <Placeholder>support email</Placeholder> (see <Link href="/contact">Contact</Link>) with the
        email address of your Scout account. You can also contact Paddle about any order they processed.
      </p>
    </LegalPage>
  );
}
