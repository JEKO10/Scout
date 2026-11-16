"use client";

import { useState, useTransition } from "react";

import { saveIcpAction, suggestIcpAction } from "@/actions/leads";
import type { LeadProfile } from "@/lib/leads/types";

const toList = (text: string) =>
  text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
const toText = (items: string[] | undefined) => (items ?? []).join(", ");

/** The ideal customer profile: drafted from the Scout Brain, edited by the user */
export function IcpForm({ initial }: { initial: LeadProfile | null }) {
  const [product, setProduct] = useState(initial?.product ?? "");
  const [audience, setAudience] = useState(initial?.audience ?? "");
  const [problems, setProblems] = useState(toText(initial?.problems));
  const [industries, setIndustries] = useState(toText(initial?.industries));
  const [signals, setSignals] = useState(toText(initial?.buyingSignals));
  const [excluded, setExcluded] = useState(toText(initial?.excluded));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [suggesting, startSuggest] = useTransition();
  const [saving, startSave] = useTransition();
  const busy = suggesting || saving;

  function fill(icp: LeadProfile) {
    setProduct(icp.product);
    setAudience(icp.audience);
    setProblems(toText(icp.problems));
    setIndustries(toText(icp.industries));
    setSignals(toText(icp.buyingSignals));
    setExcluded(toText(icp.excluded));
  }

  return (
    <div className="topic-form">
      {!initial && (
        <div className="calibration-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              startSuggest(async () => {
                setMessage(null);
                const result = await suggestIcpAction();
                if (!result.ok) return setMessage({ ok: false, text: result.message });
                fill(result.icp);
                setMessage({ ok: true, text: "Drafted from your Scout Brain. Review it, fix anything wrong, then save." });
              })
            }
          >
            {suggesting ? "Drafting…" : "Draft from my Scout Brain"}
          </button>
        </div>
      )}
      <label>
        What do you offer?
        <textarea value={product} onChange={(e) => setProduct(e.target.value)} rows={2} maxLength={500} placeholder="An AI SEO tool for small SaaS teams." />
      </label>
      <label>
        Who is it for?
        <input value={audience} onChange={(e) => setAudience(e.target.value)} maxLength={300} placeholder="SaaS founders and small businesses" />
      </label>
      <label>
        Problems it solves (comma separated)
        <textarea value={problems} onChange={(e) => setProblems(e.target.value)} rows={2} placeholder="low organic traffic, can't rank on Google, agencies too expensive" />
      </label>
      <label>
        Industries or niches (optional)
        <input value={industries} onChange={(e) => setIndustries(e.target.value)} placeholder="SaaS, e-commerce" />
      </label>
      <label>
        Buying signals (optional)
        <input value={signals} onChange={(e) => setSignals(e.target.value)} placeholder="looking for SEO software, asking for recommendations" />
      </label>
      <label>
        Ignore (optional)
        <input value={excluded} onChange={(e) => setExcluded(e.target.value)} placeholder="agencies selling SEO, job posts" />
      </label>
      <div className="calibration-actions">
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() =>
            startSave(async () => {
              setMessage(null);
              const result = await saveIcpAction({
                product,
                audience,
                problems: toList(problems),
                industries: toList(industries),
                buyingSignals: toList(signals),
                excluded: toList(excluded),
              });
              setMessage({ ok: result.ok, text: result.message });
            })
          }
        >
          {saving ? "Saving…" : "Save customer profile"}
        </button>
      </div>
      {message && (
        <p className="form-message" data-status={message.ok ? "success" : "error"} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
