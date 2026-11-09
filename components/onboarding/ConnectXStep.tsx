"use client";

import Link from "next/link";
import { useActionState } from "react";

import {
  type ConnectState,
  connectXHandleAction,
  importOwnPostsAction,
} from "@/actions/onboarding";

const USE_POSTS_HREF = "/onboarding?step=answers&mode=posts";
const SCRATCH_HREF = "/onboarding?step=answers&mode=scratch";

/**
 * First step: find out how much of the user's writing Scout can read, then
 * offer the path that fits. Counts only posts already imported, so the choice
 * reflects real data rather than a guess about their X account.
 */
export function ConnectXStep({
  handle,
  postCount,
  enoughPosts,
}: {
  handle: string | null;
  postCount: number;
  enoughPosts: number;
}) {
  const [connect, connectAction, connecting] = useActionState<ConnectState, FormData>(
    connectXHandleAction,
    { status: "idle" },
  );
  const [imported, importAction, importing] = useActionState<ConnectState, FormData>(
    importOwnPostsAction,
    { status: "idle" },
  );
  const enough = postCount >= enoughPosts;

  if (enough) {
    return (
      <div className="calibration">
        <p className="eyebrow">{handle ? `@${handle}` : "Your posts"}</p>
        <p className="calibration-prompt">
          {postCount} posts ready. Scout can learn your voice, topics and opinions from them.
        </p>
        <div className="calibration-actions">
          <Link href={USE_POSTS_HREF} className="primary-button">
            Learn from my posts
          </Link>
          <Link href={SCRATCH_HREF} className="text-link calibration-skip">
            Start from scratch instead
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="calibration">
      {postCount > 0 && (
        <p className="connect-result">
          Scout has {postCount} of your posts and needs at least {enoughPosts} to learn from
          them. Import more, or start from scratch: three short replies teach it your voice.
        </p>
      )}

      <form action={connectAction} className="connect-form">
        <label htmlFor="connect-handle">What&apos;s your X handle?</label>
        <div className="connect-row">
          <div className="x-handle-input">
            <span aria-hidden="true">@</span>
            <input
              id="connect-handle"
              name="handle"
              defaultValue={handle ?? ""}
              placeholder="martinbuilds"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              className="field-control"
            />
          </div>
          <button type="submit" className="primary-button" disabled={connecting}>
            {connecting ? (
              <>
                <span className="x-sync-spinner" aria-hidden="true" />
                Reading your posts…
              </>
            ) : (
              "Find my posts"
            )}
          </button>
        </div>
        {connect.message && (
          <p className="form-message" data-status={connect.status} role="status">
            {connect.message}
          </p>
        )}
      </form>

      <form action={importAction} className="connect-form">
        <label htmlFor="connect-file">Or import a CSV export of your posts</label>
        <div className="connect-row">
          <input
            // Remount clears the chosen file after each import
            key={imported.message ?? "file"}
            id="connect-file"
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            className="watchlist-file"
          />
          <button type="submit" className="secondary-button" disabled={importing}>
            {importing ? "Importing…" : "Import CSV"}
          </button>
        </div>
        {imported.message && (
          <p className="form-message" data-status={imported.status} role="status">
            {imported.message}
          </p>
        )}
      </form>

      <div className="connect-scratch">
        <div>
          <strong>New on X, or no account?</strong>
          <p>Answer six questions and write three short replies instead.</p>
        </div>
        <Link href={SCRATCH_HREF} className="secondary-button">
          Start from scratch
        </Link>
      </div>
    </div>
  );
}
