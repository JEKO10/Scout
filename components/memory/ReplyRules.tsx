"use client";

import { useActionState, useTransition } from "react";

import {
  addReplyRuleAction,
  removeReplyRuleAction,
  type ReplyRuleState,
} from "@/actions/replies";

/** /memory: the user's own standing rules for every reply. */
export function ReplyRules({ rules }: { rules: string[] }) {
  const [state, formAction, adding] = useActionState<ReplyRuleState, FormData>(
    addReplyRuleAction,
    { status: "idle" },
  );
  const [removing, startRemoving] = useTransition();

  return (
    <div className="reply-rules">
      {rules.length ? (
        <ul className="memory-list">
          {rules.map((rule) => (
            <li key={rule}>
              <strong>{rule}</strong>
              <button
                type="button"
                className="learned-wrong"
                disabled={removing}
                aria-label={`Remove rule: ${rule}`}
                onClick={() => startRemoving(() => removeReplyRuleAction(rule))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="memory-note">
          No rules yet. Add one here, or tick &ldquo;Always do this&rdquo; when you regenerate a
          reply.
        </p>
      )}

      <form action={formAction} className="connect-row reply-rules-form">
        {/* React resets the form after the action, which clears the field */}
        <input
          name="rule"
          className="field-control"
          maxLength={300}
          placeholder="e.g. Never start with “Exactly”"
          aria-label="New rule for every reply"
          required
        />
        <button type="submit" className="secondary-button" disabled={adding}>
          {adding ? "Adding…" : "Add rule"}
        </button>
      </form>
      {state.status === "error" && state.message && (
        <p className="form-message" data-status="error" role="status">
          {state.message}
        </p>
      )}
    </div>
  );
}
