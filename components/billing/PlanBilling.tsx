import Link from "next/link";

import type { PlanId, UsageLimits } from "@/lib/billing/plans";
import { PLANS } from "@/lib/billing/plans";
import type { BillingOverview } from "@/services/billing/account";

import { ManageBillingButton } from "./ManageBillingButton";

const date = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const number = new Intl.NumberFormat("en");

function every(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : minutes === 60 ? "hour" : `${minutes / 60} hours`;
}

function statusLine(billing: BillingOverview): string {
  const { plan, subscription } = billing;
  const label = (id: PlanId | null) => (id ? PLANS[id].label : "your plan");
  if (plan === "internal") return "Internal account: limits are set for development and never billed.";
  if (!subscription) return plan === "free" ? "You're on the Free plan." : `You're on ${PLANS[plan].label}.`;

  const ends = subscription.currentPeriodEndsAt && date.format(subscription.currentPeriodEndsAt);
  if (subscription.scheduledChange?.action === "cancel") {
    return `${label(subscription.plan)} ends ${date.format(subscription.scheduledChange.effectiveAt)}, then you'll be on Free.`;
  }
  switch (subscription.status) {
    case "past_due":
      return `Your last payment failed. Update your payment method to keep ${label(subscription.plan)}.`;
    case "paused":
      return "Your subscription is paused. You're on the Free plan until it resumes.";
    case "trialing":
      return ends ? `Trial ends ${ends}.` : "Trial active.";
    default:
      return ends ? `Renews ${ends}.` : "Active.";
  }
}

export function PlanBilling({
  billing,
  limits,
  usage,
}: {
  billing: BillingOverview;
  limits: UsageLimits;
  usage: { xPostReads: number; activeAccounts: number };
}) {
  const plan = PLANS[billing.plan];
  const paid = billing.subscription !== null;

  return (
    <section className="profile-form" aria-labelledby="plan-title">
      <div className="form-intro">
        <p className="eyebrow">Plan &amp; billing</p>
        <h2 id="plan-title">{plan.label}</h2>
        <p>{statusLine(billing)}</p>
      </div>

      <div className="plan-billing">
        <dl className="plan-usage">
          <div>
            <dt>Watched accounts</dt>
            <dd>
              {usage.activeAccounts} / {limits.maxActiveWatchlist}
            </dd>
          </div>
          <div>
            <dt>X posts read this month</dt>
            <dd>
              {number.format(usage.xPostReads)} / {number.format(limits.monthlyXPostReads)}
            </dd>
          </div>
          <div>
            <dt>Automatic scans</dt>
            <dd>as often as every {every(Math.min(...plan.autoScan.intervalsMinutes))}</dd>
          </div>
        </dl>
        <p className="memory-note">Monthly usage resets on the 1st (UTC).</p>

        <div className="calibration-actions">
          <Link href="/pricing" className={paid ? "secondary-button" : "primary-button"}>
            {paid ? "Change plan" : "See plans"}
          </Link>
          {billing.hasBillingAccount && <ManageBillingButton />}
        </div>
        {billing.hasBillingAccount && (
          <p className="memory-note">Manage billing opens Paddle: cancel, payment method and invoices.</p>
        )}
      </div>
    </section>
  );
}
