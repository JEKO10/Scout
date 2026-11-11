"use client";

import { useState, useTransition } from "react";

import { setAutoScoutAction } from "@/actions/autoScout";

const reasonLabels: Record<string, string> = {
  disabled: "Automatic Scout was off",
  global_x_budget: "Scout's daily X limit was reached",
  daily_auto_limit: "Your daily automatic scans were used up",
  budget_x_reads: "Your monthly X read budget is used up",
  budget_scoring: "Your monthly AI scoring budget is used up",
  run_limit: "Too soon after your last scan",
  scan_running: "A manual scan was running",
  no_active_accounts: "No active accounts on your watchlist",
};

const frequencyLabel = (minutes: number) =>
  minutes < 60 ? `Every ${minutes} minutes` : minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;

export type AutoScoutSettingsData = {
  enabled: boolean;
  intervalMinutes: number;
  intervals: number[];
  /** Formatted on the server, so the client renders the same text it hydrates */
  lastScanLabel: string;
  nextScanLabel: string;
  lastJob: { status: string; skipReason: string | null; error: string | null } | null;
};

/** Settings: Automatic Scout on/off, frequency and what it did last. */
export function AutoScoutSettings({ data }: { data: AutoScoutSettingsData }) {
  const [enabled, setEnabled] = useState(data.enabled);
  const [interval, setIntervalMinutes] = useState(data.intervalMinutes);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function save(next: { enabled: boolean; intervalMinutes: number }) {
    const previous = { enabled, interval };
    setEnabled(next.enabled);
    setIntervalMinutes(next.intervalMinutes);
    setMessage(null);
    startTransition(async () => {
      const result = await setAutoScoutAction(next);
      if (!result.ok) {
        setEnabled(previous.enabled);
        setIntervalMinutes(previous.interval);
      }
      setMessage({ ok: result.ok, text: result.message });
    });
  }

  const last = data.lastJob;
  const status = !enabled
    ? "Off"
    : last?.status === "failed"
      ? `Last scan failed: ${last.error ?? "unknown error"}`
      : last?.status === "skipped"
        ? `Last scan skipped: ${reasonLabels[last.skipReason ?? ""] ?? last.skipReason}`
        : last?.status === "pending" && last.error
          ? `Retrying after an error: ${last.error}`
          : "Active";

  return (
    <section className="profile-form">
      <div className="form-intro">
        <p className="eyebrow">Automatic Scout</p>
        <h2>Scan on its own</h2>
        <p>
          Scout scans your watchlist in the background, within your plan&apos;s limits. You can
          still run it by hand any time.
        </p>
      </div>

      <div>
        <fieldset className="sensitivity-options" disabled={pending}>
          <legend className="sr-only">Automatic Scout</legend>
          <label className="sensitivity-option">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => save({ enabled: event.target.checked, intervalMinutes: interval })}
            />
            <span>
              <strong>Automatic Scout</strong>
              <small>{status}</small>
            </span>
          </label>
          {data.intervals.map((minutes) => (
            <label key={minutes} className="sensitivity-option">
              <input
                type="radio"
                name="auto-scan-interval"
                checked={interval === minutes}
                onChange={() => save({ enabled, intervalMinutes: minutes })}
              />
              <span>
                <strong>{frequencyLabel(minutes)}</strong>
                <small>{minutes === data.intervals[0] ? "Your plan's default" : " "}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="memory-note">
          Last automatic scan: {data.lastScanLabel} · Next:{" "}
          {enabled ? data.nextScanLabel : "not scheduled"}
        </p>
        <div aria-live="polite">
          {message && (
            <p className="form-message" data-status={message.ok ? "success" : "error"}>
              {message.text}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
