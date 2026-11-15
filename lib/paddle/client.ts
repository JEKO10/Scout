// Browser-only: one Paddle.js instance per page load. Paddle.js is a global
// script, so it's initialized once and pages subscribe to its checkout events.
import { getPaddleInstance, initializePaddle, type Paddle, type PaddleEventData } from "@paddle/paddle-js";

import type { PaddleClientConfig } from "./config";

type Listener = (event: PaddleEventData) => void;

const listeners = new Set<Listener>();
let instance: Promise<Paddle> | null = null;

export function loadPaddle(config: PaddleClientConfig): Promise<Paddle> {
  if (!instance) {
    instance = initializePaddle({
      environment: config.environment,
      token: config.token,
      checkout: { settings: { displayMode: "overlay", variant: "one-page" } },
      eventCallback: (event) => listeners.forEach((listener) => listener(event)),
    }).then((paddle) => {
      if (!paddle) throw new Error("Paddle.js didn't load");
      return paddle;
    });
    // A failed load (blocked script, offline) can be retried on the next call
    instance.catch(() => {
      instance = null;
    });
  }
  return instance;
}

/** Subscribe to checkout events; returns the unsubscribe function. */
export function onPaddleEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Close the overlay before leaving the page. It lives outside React's tree, so
 * a client-side navigation would leave it covering the next page.
 */
export function closeCheckout(): void {
  getPaddleInstance()?.Checkout.close();
}
