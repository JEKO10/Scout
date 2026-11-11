import Link from "next/link";

import type { AiOperation } from "@/db/schema";
import { formatRelative } from "@/lib/format";
import { AI_OPERATION_LABELS, type AiCostSummary } from "@/services/ai/costSummary";

const usd = (value: number) => (value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`);
const tokens = new Intl.NumberFormat("en", { notation: "compact" });

// Memory and learning are code only today; shown so a $0 reads as "no AI", not "missing"
const ALWAYS_SHOWN: AiOperation[] = [
  "opportunity_scoring",
  "reply_generation",
  "brain_creation",
  "memory_learning",
];

/** Development dashboard: estimated OpenAI cost per operation. */
export function AiCostPanel({ summary }: { summary: AiCostSummary }) {
  const operations = [
    ...ALWAYS_SHOWN,
    ...summary.allTime
      .map((row) => row.operation)
      .filter((operation) => !ALWAYS_SHOWN.includes(operation)),
  ];
  const unpriced = summary.allTime.reduce((sum, row) => sum + row.unpriced, 0);

  return (
    <div className="aside-section scout-run-summary ai-cost">
      <div className="aside-heading">
        <p className="eyebrow">AI cost (estimated)</p>
        <span>{usd(summary.totalUsd)}</span>
      </div>
      <dl>
        {operations.map((operation) => {
          const row = summary.allTime.find((item) => item.operation === operation);
          return (
            <div key={operation}>
              <dt
                title={
                  row
                    ? `${row.calls} calls · ${tokens.format(row.inputTokens)} in (${tokens.format(row.cachedInputTokens)} cached) · ${tokens.format(row.outputTokens)} out (${tokens.format(row.reasoningTokens)} reasoning)`
                    : operation === "memory_learning"
                      ? "Memory and learning run as code, without AI calls"
                      : "No calls yet"
                }
              >
                {AI_OPERATION_LABELS[operation]}
                {row ? ` · ${row.calls}×` : ""}
              </dt>
              <dd>{usd(row?.costUsd ?? 0)}</dd>
            </div>
          );
        })}
        <div>
          <dt>Last 24 hours</dt>
          <dd>{usd(summary.last24hUsd)}</dd>
        </div>
        {summary.lastRun && (
          <div>
            <dt>Last Scout run · {formatRelative(summary.lastRun.at)}</dt>
            <dd>{usd(summary.lastRun.costUsd)}</dd>
          </div>
        )}
      </dl>
      <p className="scout-run-note">
        From actual token usage × list prices in lib/ai/pricing.ts. Models: scoring{" "}
        {summary.models.scoring}, replies {summary.models.reply}, brain {summary.models.brain}.
      </p>
      {unpriced > 0 && (
        <p className="scout-run-error">
          {unpriced} calls used a model with no configured price; they&apos;re not in the totals.
        </p>
      )}
      <Link href="/dev/runs" className="text-link">
        Run analytics <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
