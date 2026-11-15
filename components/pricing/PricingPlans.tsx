"use client";

import { CheckoutEventNames } from "@paddle/paddle-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { changePlanAction } from "@/actions/billing";
import type { PaidTierId, PricingAccount, PricingTier } from "@/lib/billing/pricing";
import { closeCheckout, loadPaddle, onPaddleEvent } from "@/lib/paddle/client";
import type { PaddleConfigResult } from "@/lib/paddle/config";

type PaidPrice = { total: string; interval: string | null };

type Prices =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; byTier: Partial<Record<PaidTierId, PaidPrice>> };

const INTERVAL_LABEL = { day: "day", week: "week", month: "month", year: "year" } as const;

export function PricingPlans({
  tiers,
  paddle,
  country,
  email,
  userId,
  account,
  resumePlan,
}: {
  tiers: PricingTier[];
  paddle: PaddleConfigResult;
  /** From the request's geo header; undefined lets Paddle detect it */
  country: string | undefined;
  /** Signed-in user's email (prefilled in checkout); null when signed out */
  email: string | null;
  /** Neon Auth user ID, sent as customData so the webhook knows whose subscription it is */
  userId: string | null;
  /** Signed-in user's plan and subscription; null when signed out */
  account: PricingAccount | null;
  resumePlan: PaidTierId | null;
}) {
  const router = useRouter();
  const config = paddle.ok ? paddle.config : null;
  const [prices, setPrices] = useState<Prices>(
    paddle.ok ? { status: "loading" } : { status: "error", message: "Checkout isn't configured." },
  );
  const [opening, setOpening] = useState<PaidTierId | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // State updates are async; the ref stops a double click opening two checkouts
  const openRef = useRef(false);
  const resumed = useRef(false);
  const [switching, setSwitching] = useState<PaidTierId | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const subscription = account?.subscription ?? null;

  // Localized prices, exactly as Paddle formats them
  useEffect(() => {
    if (!config) return;
    let active = true;
    const { starter, pro } = config.priceIds;
    loadPaddle(config)
      .then((instance) =>
        instance.PricePreview({
          items: [
            { priceId: starter, quantity: 1 },
            { priceId: pro, quantity: 1 },
          ],
          ...(country ? { address: { countryCode: country } } : {}),
        }),
      )
      .then((result) => {
        if (!active) return;
        const byTier: Partial<Record<PaidTierId, PaidPrice>> = {};
        for (const item of result.data.details.lineItems) {
          const tier = item.price.id === starter ? "starter" : item.price.id === pro ? "pro" : null;
          if (!tier) continue;
          const cycle = item.price.billingCycle;
          byTier[tier] = {
            total: item.formattedTotals.total,
            interval: cycle ? (cycle.frequency === 1 ? INTERVAL_LABEL[cycle.interval] : `${cycle.frequency} ${cycle.interval}s`) : null,
          };
        }
        setPrices({ status: "ready", byTier });
      })
      .catch((error: unknown) => {
        console.error("Paddle price preview failed", error);
        if (active) setPrices({ status: "error", message: "Couldn't load prices. Refresh to try again." });
      });
    return () => {
      active = false;
    };
  }, [config, country]);

  // Checkout lifecycle: unlock on close/error, confirmation page on completion.
  // Completion here is only what the browser saw; plans change via webhooks.
  useEffect(
    () =>
      onPaddleEvent((event) => {
        if (event.name === CheckoutEventNames.CHECKOUT_CLOSED) {
          openRef.current = false;
          setOpening(null);
        } else if (event.name === CheckoutEventNames.CHECKOUT_ERROR) {
          console.error("Paddle checkout error", event);
          setCheckoutError(event.detail || "Checkout ran into a problem. Try again.");
        } else if (event.name === CheckoutEventNames.CHECKOUT_COMPLETED) {
          const transaction = event.data?.transaction_id;
          closeCheckout();
          router.push(transaction ? `/checkout/success?transaction=${encodeURIComponent(transaction)}` : "/checkout/success");
        }
      }),
    [router],
  );

  const subscribe = useCallback(
    (tier: PaidTierId) => {
      if (!config) return;
      if (!email || !userId) {
        router.push(`/auth/sign-in?redirectTo=${encodeURIComponent(`/pricing?plan=${tier}`)}`);
        return;
      }
      // One subscription per user: an existing one is switched, never doubled
      if (account?.subscription || account?.currentTier === tier) return;
      if (openRef.current) return;
      openRef.current = true;
      setOpening(tier);
      setCheckoutError(null);
      loadPaddle(config)
        .then((instance) =>
          instance.Checkout.open({
            items: [{ priceId: config.priceIds[tier], quantity: 1 }],
            customer: { email },
            customData: { userId },
            settings: { displayMode: "overlay", variant: "one-page" },
          }),
        )
        .catch((error: unknown) => {
          console.error("Paddle checkout failed to open", error);
          openRef.current = false;
          setOpening(null);
          setCheckoutError("Couldn't open checkout. Try again in a moment.");
        });
    },
    [config, email, userId, account, router],
  );

  async function switchTo(tier: PaidTierId) {
    const name = tier === "pro" ? "Pro" : "Starter";
    const confirmed = window.confirm(
      tier === "pro"
        ? `Switch to ${name} now? Paddle charges the prorated difference for the rest of this billing period to your saved payment method.`
        : `Switch to ${name} now? Your limits change right away and the unused part of this period is credited to your next bill.`,
    );
    if (!confirmed) return;
    setSwitching(tier);
    setNotice(null);
    const result = await changePlanAction(tier);
    setSwitching(null);
    setNotice({ ok: result.ok, text: result.message ?? (result.ok ? "Plan changed." : "Something went wrong.") });
    if (result.ok) router.refresh();
  }

  // Back from sign-in with a plan picked: open its checkout once prices show
  useEffect(() => {
    if (!resumePlan || resumed.current || prices.status !== "ready" || !prices.byTier[resumePlan]) return;
    resumed.current = true;
    // Plain history update: a router navigation would re-render the server page
    window.history.replaceState(null, "", "/pricing");
    subscribe(resumePlan);
  }, [resumePlan, prices, subscribe]);

  return (
    <>
      {!paddle.ok && (
        <div className="form-message pricing-alert" data-status="error" role="alert">
          <strong>Paid plans are unavailable: checkout isn&apos;t configured.</strong>
          <ul>
            {paddle.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {paddle.ok && paddle.config.environment === "sandbox" && (
        <p className="pricing-test-note">Test environment: payments use Paddle Sandbox and no real money is charged.</p>
      )}
      {notice && (
        <p className="form-message pricing-alert" data-status={notice.ok ? "success" : "error"} role="status">
          {notice.text}
        </p>
      )}
      {checkoutError && (
        <p className="form-message pricing-alert" data-status="error" role="alert">
          {checkoutError}
        </p>
      )}

      <div className="pricing-grid">
        {tiers.map((tier) => (
          <article key={tier.id} className="pricing-card" data-recommended={tier.recommended || undefined}>
            <header>
              <div className="pricing-card-title">
                <h2>{tier.name}</h2>
                {tier.recommended && <span className="pricing-badge">Recommended</span>}
              </div>
              <p>{tier.description}</p>
            </header>

            <div className="pricing-price" aria-live="polite">
              {tier.id === "free" ? (
                <>
                  <strong>$0</strong>
                  <span>/month</span>
                </>
              ) : (
                <PaidPriceView prices={prices} tier={tier.id} />
              )}
            </div>

            {account?.currentTier === tier.id ? (
              <span className="pricing-current pricing-cta">Your plan</span>
            ) : tier.id === "free" ? (
              subscription ? (
                <>
                  <Link href="/account/settings" className="secondary-button pricing-cta">
                    Cancel in Settings
                  </Link>
                  <p className="pricing-card-note">Plan &amp; billing → Manage billing.</p>
                </>
              ) : (
                <Link href={email ? "/dashboard" : "/auth/sign-up"} className="secondary-button pricing-cta">
                  {email ? "Open dashboard" : "Start free"}
                </Link>
              )
            ) : subscription ? (
              <>
                <button
                  type="button"
                  className={`${tier.recommended ? "primary-button" : "secondary-button"} pricing-cta`}
                  disabled={switching !== null || subscription.changeBlockedBy !== null}
                  onClick={() => switchTo(tier.id as PaidTierId)}
                >
                  {switching === tier.id ? "Switching…" : `Switch to ${tier.name}`}
                </button>
                {subscription.changeBlockedBy && <p className="pricing-card-note">{subscription.changeBlockedBy}</p>}
              </>
            ) : (
              <button
                type="button"
                className={`${tier.recommended ? "primary-button" : "secondary-button"} pricing-cta`}
                disabled={prices.status !== "ready" || !prices.byTier[tier.id] || opening !== null}
                onClick={() => subscribe(tier.id as PaidTierId)}
              >
                {opening === tier.id ? "Opening checkout…" : email ? "Subscribe" : "Sign in to subscribe"}
              </button>
            )}

            <ul className="pricing-features">
              {tier.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </>
  );
}

function PaidPriceView({ prices, tier }: { prices: Prices; tier: PaidTierId }) {
  if (prices.status === "loading") return <span className="pricing-price-loading">Loading price…</span>;
  const price = prices.status === "ready" ? prices.byTier[tier] : undefined;
  if (!price) return <span className="pricing-price-error">{prices.status === "error" ? prices.message : "Price unavailable"}</span>;
  return (
    <>
      <strong>{price.total}</strong>
      {price.interval && <span>/{price.interval}</span>}
    </>
  );
}
