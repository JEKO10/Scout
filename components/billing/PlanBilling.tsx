import Link from "next/link";

import type { PlanId, UsageLimits } from "@/lib/billing/plans";
import { PLANS } from "@/lib/billing/plans";
import type { BillingOverview, SubscriptionSummary } from "@/services/billing/account";

import { ManageBillingButton } from "./ManageBillingButton";
import { SubscriptionActions } from "./SubscriptionActions";

const date = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const number = new Intl.NumberFormat("en");

function scanFrequency(intervals: number[]): string {
  const minutes = Math.min(...intervals);
  if (minutes >= 1440) return "once a day";
  return minutes < 60 ? `up to every ${minutes} min` : `up to every ${minutes / 60} h`;
}

/** Paddle reports amounts in minor units ("2400" USD = $24.00) */
function formatPrice(unitPrice: SubscriptionSummary["unitPrice"]): string | null {
  if (!unitPrice) return null;
  try {
    const format = new Intl.NumberFormat("en", { style: "currency", currency: unitPrice.currencyCode });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(Number(unitPrice.amount) / 10 ** digits);
  } catch {
    return null;
  }
}

function statusLine(billing: BillingOverview): string {
  const { plan, subscription } = billing;
  const label = (id: PlanId | null) => (id ? PLANS[id].label : "your plan");
  if (plan === "internal") return "Internal account: limits are set for development and never billed.";
  if (!subscription) return plan === "free" ? "You're on the Free plan." : `You're on ${PLANS[plan].label}.`;

  const ends = subscription.currentPeriodEndsAt && date.format(subscription.currentPeriodEndsAt);
  const change = subscription.scheduledChange;
  if (change?.action === "cancel") {
    return `Canceled: ${label(subscription.plan)} stays active until ${date.format(change.effectiveAt)}, then you move to Free.`;
  }
  if (change?.action === "pause") {
    return `Your subscription pauses on ${date.format(change.effectiveAt)}; you'll be on Free while it's paused.`;
  }
  if (change?.action === "resume") return `Your subscription resumes on ${date.format(change.effectiveAt)}.`;
  switch (subscription.status) {
    case "past_due":
      return `Your last payment failed. Paddle retries it; update your payment method in Manage billing to keep ${label(subscription.plan)}.`;
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
  usage: {
    xPostReads: number;
    activeAccounts: number;
    /** Plan limit, lowered in testing mode */
    maxActiveAccounts: number;
    /** Available now (paced): X reads and roughly how many posts the AI can still score */
    xReadsNow: number;
    scoredPostsNow: number;
    repliesLeft: number;
    /** When scanning can continue, if it can't now */
    nextScanNote: string | null;
  };
}) {
  const plan = PLANS[billing.plan];
  const subscription = billing.subscription;
  const price = subscription && formatPrice(subscription.unitPrice);
  const granting = subscription && ["active", "trialing", "past_due"].includes(subscription.status);
  const scheduledEnd =
    subscription?.scheduledChange?.action === "cancel" ? date.format(subscription.scheduledChange.effectiveAt) : null;

  return (
    <section className="profile-form" aria-labelledby="plan-title">
      <div className="form-intro">
        <p className="eyebrow">Plan &amp; billing</p>
        <h2 id="plan-title">
          {plan.label}
          {price && <span className="plan-price"> · {price}/month</span>}
        </h2>
        <p>{statusLine(billing)}</p>
      </div>

      <div className="plan-billing">
        <dl className="plan-usage">
          <div>
            <dt>Watched accounts</dt>
            <dd>
              {usage.activeAccounts} / {usage.maxActiveAccounts}
            </dd>
          </div>
          <div>
            <dt>X posts this month</dt>
            <dd>
              {number.format(usage.xPostReads)} / {number.format(limits.monthlyXPostReads)}
            </dd>
          </div>
          <div>
            <dt>Available now</dt>
            <dd>
              {number.format(usage.xReadsNow)} posts · ~{number.format(usage.scoredPostsNow)} scored
            </dd>
          </div>
          <div>
            <dt>Reply drafts left</dt>
            <dd>~{number.format(usage.repliesLeft)} this month</dd>
          </div>
          <div>
            <dt>Automatic scans</dt>
            <dd>{scanFrequency(plan.autoScan.intervalsMinutes)}</dd>
          </div>
        </dl>
        {usage.activeAccounts > usage.maxActiveAccounts && (
          <p className="form-message" data-status="error" role="status">
            You have {usage.activeAccounts} active accounts; your plan scans {usage.maxActiveAccounts}. Pause some on the{" "}
            <Link href="/watchlist">watchlist</Link> or change plan. Nothing is deleted.
          </p>
        )}
        {usage.nextScanNote && <p className="memory-note">{usage.nextScanNote}</p>}
        <p className="memory-note">
          {limits.dailyPacing
            ? "Your budget is paced: a share is available on the 1st, the rest a little each day (00:00 UTC). Unused days carry over until the month ends."
            : "Monthly usage resets on the 1st (UTC)."}
        </p>

        <div className="calibration-actions">
          <Link href="/pricing" className={subscription ? "secondary-button" : "primary-button"}>
            {subscription ? "Change plan" : "See plans"}
          </Link>
          {billing.hasBillingAccount && <ManageBillingButton />}
        </div>
        {granting && subscription.plan && (
          <div className="plan-subscription-actions">
            <SubscriptionActions
              planLabel={PLANS[subscription.plan].label}
              scheduledEndLabel={scheduledEnd}
              periodEndLabel={subscription.currentPeriodEndsAt ? date.format(subscription.currentPeriodEndsAt) : null}
              canCancel={subscription.status !== "past_due"}
            />
          </div>
        )}
        {billing.hasBillingAccount && (
          <p className="memory-note">Manage billing opens Paddle: payment method, invoices and receipts.</p>
        )}
      </div>
    </section>
  );
}
