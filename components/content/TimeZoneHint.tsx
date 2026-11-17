"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** Offers the browser's time zone when the calendar shows another one */
export function TimeZoneHint({ current, baseQuery }: { current: string; baseQuery: string }) {
  const browser = useSyncExternalStore(
    subscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => current,
  );
  if (!browser || browser === current) return null;
  return (
    <a className="text-link" href={`/calendar?${baseQuery ? `${baseQuery}&` : ""}tz=${encodeURIComponent(browser)}`}>
      Show in your time zone ({browser})
    </a>
  );
}
