"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { checkoutStatusAction } from "@/actions/billing";

type State = { kind: "pending" } | { kind: "confirmed"; planLabel: string | null } | { kind: "slow" } | { kind: "signed_out" };

const POLL_MS = 2_500;
/** Paddle usually confirms within seconds; after this, say so instead of spinning */
const GIVE_UP_MS = 90_000;
/** Without a recorded start (another tab, a refresh much later): look this far back */
const FALLBACK_WINDOW_MS = 30 * 60_000;

/**
 * The paid plan is granted only by the verified webhook. This waits for it,
 * then says which plan is active; the checkout redirect itself grants nothing.
 */
export function CheckoutConfirmation() {
  const [state, setState] = useState<State>({ kind: "pending" });

  useEffect(() => {
    let since = new Date(Date.now() - FALLBACK_WINDOW_MS);
    try {
      const started = sessionStorage.getItem("scout-checkout-started");
      // A little earlier than the click: clocks of browser and server differ
      if (started && !Number.isNaN(Date.parse(started))) since = new Date(Date.parse(started) - 5 * 60_000);
    } catch {}

    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();
    const check = async () => {
      const result = await checkoutStatusAction(since.toISOString()).catch(() => ({ status: "pending" as const }));
      if (!active) return;
      if (result.status === "confirmed") {
        setState({ kind: "confirmed", planLabel: result.planLabel });
        try {
          sessionStorage.removeItem("scout-checkout-started");
        } catch {}
        return;
      }
      if (result.status === "signed_out") return setState({ kind: "signed_out" });
      if (Date.now() - startedAt > GIVE_UP_MS) return setState({ kind: "slow" });
      timer = setTimeout(check, POLL_MS);
    };
    check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  return (
    <div aria-live="polite">
      {state.kind === "pending" && (
        <p>
          <span className="x-sync-spinner" aria-hidden="true" /> Confirming your subscription with Paddle. This
          usually takes a few seconds.
        </p>
      )}
      {state.kind === "confirmed" && (
        <p>
          <strong>You&apos;re on {state.planLabel ?? "your new plan"}.</strong> Your new limits are active now.
        </p>
      )}
      {state.kind === "slow" && (
        <p>
          Payment received, but Paddle hasn&apos;t confirmed the subscription yet. Your plan updates automatically as
          soon as it does; check Settings in a few minutes.
        </p>
      )}
      {state.kind === "signed_out" && <p>Sign in to see your plan. It updates automatically once Paddle confirms.</p>}
      <div className="checkout-actions">
        <Link href="/dashboard" className="primary-button">
          Go to my dashboard
        </Link>
        <Link href="/account/settings" className="secondary-button">
          Plan &amp; billing
        </Link>
      </div>
    </div>
  );
}
