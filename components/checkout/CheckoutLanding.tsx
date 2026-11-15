"use client";

import { CheckoutEventNames } from "@paddle/paddle-js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { closeCheckout, loadPaddle, onPaddleEvent } from "@/lib/paddle/client";
import type { PaddleConfigResult } from "@/lib/paddle/config";

type State = "loading" | "open" | "closed" | "stalled" | "error";

/** If Paddle.js hasn't opened the transaction by itself by then, offer a button */
const AUTO_OPEN_WAIT_MS = 8_000;

export function CheckoutLanding({
  paddle,
  transactionId,
}: {
  paddle: PaddleConfigResult;
  transactionId: string | null;
}) {
  const router = useRouter();
  const config = paddle.ok ? paddle.config : null;
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    if (!config || !transactionId) return;
    let opened = false;
    const unsubscribe = onPaddleEvent((event) => {
      if (event.name === CheckoutEventNames.CHECKOUT_LOADED) {
        opened = true;
        setState("open");
      } else if (event.name === CheckoutEventNames.CHECKOUT_CLOSED) {
        setState("closed");
      } else if (event.name === CheckoutEventNames.CHECKOUT_ERROR) {
        console.error("Paddle checkout error", event);
        setState("error");
      } else if (event.name === CheckoutEventNames.CHECKOUT_COMPLETED) {
        closeCheckout();
        router.push(`/checkout/success?transaction=${encodeURIComponent(event.data?.transaction_id ?? transactionId)}`);
      }
    });
    // Initializing on a page with ?_ptxn= is what opens the checkout
    loadPaddle(config).catch((error: unknown) => {
      console.error("Paddle.js failed to load", error);
      setState("error");
    });
    const timer = setTimeout(() => {
      if (!opened) setState((current) => (current === "loading" ? "stalled" : current));
    }, AUTO_OPEN_WAIT_MS);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [config, transactionId, router]);

  function openAgain() {
    if (!config || !transactionId) return;
    setState("loading");
    loadPaddle(config)
      .then((instance) =>
        instance.Checkout.open({ transactionId, settings: { displayMode: "overlay", variant: "one-page" } }),
      )
      .catch(() => setState("error"));
  }

  if (!paddle.ok) {
    return (
      <>
        <p className="eyebrow">Checkout</p>
        <h1>Checkout isn&apos;t configured.</h1>
        <div className="form-message pricing-alert" data-status="error" role="alert">
          <ul>
            {paddle.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      </>
    );
  }

  if (!transactionId) {
    return (
      <>
        <p className="eyebrow">Checkout</p>
        <h1>There&apos;s no checkout to open here.</h1>
        <p>To subscribe, choose a plan on the pricing page.</p>
        <div className="checkout-actions">
          <Link href="/pricing" className="primary-button">
            See plans
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="eyebrow">Secure checkout</p>
      {paddle.config.environment === "sandbox" && (
        <p className="pricing-test-note">Test environment: no real money is charged.</p>
      )}
      <h1>
        {state === "loading" && "Opening your checkout…"}
        {state === "open" && "Complete your purchase in the checkout window."}
        {state === "closed" && "Checkout closed."}
        {state === "stalled" && "The checkout didn't open."}
        {state === "error" && "Checkout ran into a problem."}
      </h1>
      {state !== "loading" && state !== "open" && (
        <div className="checkout-actions">
          <button type="button" className="primary-button" onClick={openAgain}>
            Open checkout
          </button>
          <Link href="/pricing" className="secondary-button">
            See plans
          </Link>
        </div>
      )}
    </>
  );
}
