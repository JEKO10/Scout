"use client";

import { useState, useTransition } from "react";

import { setLeadStatusAction } from "@/actions/leads";
import { LEAD_STATUSES, type LeadStatus, STATUS_LABEL } from "@/lib/leads/crm";

/** Pipeline status: a plain, accessible select; saved at once */
export function StatusSelect({ leadId, status, label = "Status" }: { leadId: string; status: LeadStatus; label?: string }) {
  const [value, setValue] = useState(status);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <label className="crm-status">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        disabled={pending}
        aria-busy={pending}
        onChange={(event) => {
          const next = event.target.value as LeadStatus;
          const previous = value;
          setValue(next);
          setError(null);
          startTransition(async () => {
            const result = await setLeadStatusAction(leadId, next);
            if (!result.ok) {
              setValue(previous);
              setError(result.message);
            }
          });
        }}
      >
        {LEAD_STATUSES.map((option) => (
          <option key={option} value={option}>
            {STATUS_LABEL[option]}
          </option>
        ))}
      </select>
      {error && (
        <small className="form-message" data-status="error" role="status">
          {error}
        </small>
      )}
    </label>
  );
}
