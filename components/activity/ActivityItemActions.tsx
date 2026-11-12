"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { confirmReplyPostedAction, returnToFeedAction } from "@/actions/replyIntents";

/** Optional follow-ups on an opened reply; none is ever required. */
export function ActivityItemActions({
  opportunityId,
  confirmed,
  postUrl,
}: {
  opportunityId: string;
  confirmed: boolean;
  postUrl: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: (id: string) => Promise<{ ok: boolean }>) {
    setError(null);
    startTransition(async () => {
      const result = await action(opportunityId);
      if (!result.ok) setError("Couldn't update. Try again.");
    });
  }

  return (
    <div className="activity-actions">
      {!confirmed && (
        <>
          <button type="button" className="secondary-button" disabled={pending} onClick={() => run(confirmReplyPostedAction)}>
            Mark as posted
          </button>
          <button type="button" className="secondary-button" disabled={pending} onClick={() => run(returnToFeedAction)}>
            Return to opportunities
          </button>
        </>
      )}
      {postUrl && (
        <a href={postUrl} target="_blank" rel="noopener noreferrer" className="text-link">
          Open on X <span aria-hidden="true">↗</span>
        </a>
      )}
      <Link href={`/opportunities/${opportunityId}`} className="text-link">
        Opportunity
      </Link>
      {error && (
        <small className="form-message" data-status="error">
          {error}
        </small>
      )}
    </div>
  );
}
