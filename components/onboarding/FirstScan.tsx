"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";

import { runScoutAction } from "@/actions/watchlist";

export type FirstScanState =
  | { kind: "ready" }
  | { kind: "blocked"; message: string }
  | { kind: "running"; startedLabel: string }
  | { kind: "completed"; analyzed: number; opportunities: number; whenLabel: string }
  | { kind: "failed"; error: string; canRetry: boolean; blockedMessage?: string };

/** While a scan started elsewhere (or before a refresh) runs: a gentle re-check */
const RECHECK_MS = 10_000;
const MAX_RECHECKS = 18;

/**
 * Onboarding's last step: start the first scan through the same server action
 * as Run Scout (same limits, budgets and one-scan-at-a-time rule), then show
 * what it found. No progress percentage: the backend doesn't report one.
 */
export function FirstScan({
  state,
  activeAccounts,
  automatic,
  children,
}: {
  state: FirstScanState;
  activeAccounts: number;
  /** What happens after this scan, in the user's actual settings */
  automatic: string;
  /** The best opportunity, rendered on the server (card + explanation) */
  children?: ReactNode;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [rechecks, setRechecks] = useState(0);

  useEffect(() => {
    if (state.kind !== "running" || rechecks >= MAX_RECHECKS) return;
    const timer = setTimeout(() => {
      setRechecks((n) => n + 1);
      router.refresh();
    }, RECHECK_MS);
    return () => clearTimeout(timer);
  }, [state, rechecks, router]);

  function scan() {
    setMessage(null);
    startTransition(async () => {
      const result = await runScoutAction();
      if (result.status === "error" && result.message) setMessage(result.message);
      router.refresh();
    });
  }

  if (pending || state.kind === "running") {
    return (
      <div className="calibration" aria-busy="true">
        <p className="calibration-prompt">
          <span className="x-sync-spinner" aria-hidden="true" /> Scout is reading {activeAccounts}{" "}
          {activeAccounts === 1 ? "account" : "accounts"} and scoring new posts against your Scout Brain.
        </p>
        <p className="memory-note">
          This usually takes under a minute.
          {state.kind === "running" && ` Started ${state.startedLabel}.`}
          {state.kind === "running" && rechecks >= MAX_RECHECKS && " Still running: refresh this page in a moment."}
        </p>
      </div>
    );
  }

  if (state.kind === "completed") {
    return (
      <div className="first-scan">
        <p className="calibration-prompt" role="status">
          Scout analyzed <strong>{state.analyzed}</strong> new {state.analyzed === 1 ? "post" : "posts"}{" "}
          {state.whenLabel} and found <strong>{state.opportunities}</strong>{" "}
          {state.opportunities === 1 ? "conversation" : "conversations"} worth joining.
        </p>
        {children ?? (
          <div className="first-scan-empty">
            <h2>No strong matches in this scan.</h2>
            <p>
              That&apos;s normal: Scout only shows posts it thinks are worth your time, and the
              accounts you watch may simply not have posted about your topics recently. Your monitoring
              is set up.
            </p>
            <ul className="memory-list">
              <li>
                <Link href="/watchlist">Add or change the accounts you watch</Link>
              </li>
              <li>
                <Link href="/account/settings">Review your Scout Brain answers and how many matches you see</Link>
              </li>
            </ul>
          </div>
        )}
        <p className="memory-note">{automatic}</p>
        <div className="calibration-actions">
          <Link href="/dashboard" className="primary-button">
            Go to my dashboard
          </Link>
        </div>
      </div>
    );
  }

  const blocked = state.kind === "blocked" ? state.message : state.kind === "failed" ? state.blockedMessage : undefined;
  return (
    <div className="calibration">
      {state.kind === "failed" && (
        <p className="form-message" data-status="error" role="status">
          The last scan failed: {state.error}
        </p>
      )}
      <p className="calibration-prompt">
        Scout will read the recent posts of your {activeAccounts}{" "}
        {activeAccounts === 1 ? "account" : "accounts"} and score each one for you. It may find several
        conversations, or none yet.
      </p>
      {blocked ? (
        <p className="form-message" data-status="error" role="status">
          {blocked}
        </p>
      ) : (
        <div className="calibration-actions">
          <button type="button" className="primary-button" onClick={scan}>
            {state.kind === "failed" ? "Try again" : "Find my first opportunities"}
          </button>
        </div>
      )}
      {message && (
        <p className="form-message" data-status="error" role="status">
          {message}
        </p>
      )}
      <p className="memory-note">{automatic}</p>
      <div className="calibration-actions">
        <Link href="/dashboard" className="text-link calibration-skip">
          Go to my dashboard
        </Link>
      </div>
    </div>
  );
}
