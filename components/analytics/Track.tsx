"use client";

import Link from "next/link";
import { type ComponentProps, useEffect } from "react";

import type { ClientEvent } from "@/lib/analytics/events";

/** Fire-and-forget: survives navigation, never delays or breaks the page */
export function sendEvent(name: ClientEvent) {
  try {
    const body = JSON.stringify({ name });
    if (navigator.sendBeacon?.("/api/events", new Blob([body], { type: "application/json" }))) return;
    void fetch("/api/events", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } });
  } catch {}
}

/** Records one view of the page it's rendered on */
export function TrackView({ name }: { name: ClientEvent }) {
  useEffect(() => {
    sendEvent(name);
  }, [name]);
  return null;
}

/** A link that records a click event before navigating */
export function TrackedLink({ event, onClick, ...props }: ComponentProps<typeof Link> & { event: ClientEvent }) {
  return (
    <Link
      {...props}
      onClick={(e) => {
        sendEvent(event);
        onClick?.(e);
      }}
    />
  );
}
