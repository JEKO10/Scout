import { createHash } from "node:crypto";

import type { EvalDataset, EvalRun } from "./types";

// Blind human review. Each example shows the post and every strategy's
// verdict as "Output A/B/C" in an order shuffled per example; the key that
// maps letters to strategies is written to a separate file. The page saves
// the reviewer's labels as JSON for `eval:scoring compare --labels`.
// The page shows posts and verdicts only, never a Scout Brain.

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function order<T>(items: T[], seed: string): T[] {
  return [...items]
    .map((item, index) => ({
      item,
      key: createHash("sha256").update(`${seed}:${index}`).digest("hex"),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ item }) => item);
}

/** Up to `size` examples: every human-signal one first, then spread over score ranges. */
export function reviewSample(
  dataset: EvalDataset,
  runs: EvalRun[],
  size: number,
): string[] {
  const disagree = (id: string) => {
    const surfaced = runs.map(
      (run) => run.outcomes.find((o) => o.id === id)?.surfaced ?? false,
    );
    return surfaced.some((value) => value !== surfaced[0]);
  };
  const signal = dataset.examples.filter(
    (e) => e.original.userLabel || e.original.opportunityStatus === "replied",
  );
  const disputed = dataset.examples.filter(
    (e) => !signal.includes(e) && disagree(e.id),
  );
  const rest = order(
    dataset.examples.filter(
      (e) => !signal.includes(e) && !disputed.includes(e),
    ),
    "review",
  );
  return [...disputed, ...signal, ...rest]
    .slice(0, size)
    .map((example) => example.id);
}

export function buildReview(
  dataset: EvalDataset,
  runs: EvalRun[],
  exampleIds: string[],
): { html: string; key: Record<string, Record<string, string>> } {
  const key: Record<string, Record<string, string>> = {};
  const letters = "ABCDEFGH";
  const cards = exampleIds.map((id, number) => {
    const example = dataset.examples.find((e) => e.id === id)!;
    const shuffled = order(runs, id);
    key[id] = Object.fromEntries(
      shuffled.map((run, index) => [letters[index], run.strategy]),
    );
    const outputs = shuffled
      .map((run, index) => {
        const outcome = run.outcomes.find((o) => o.id === id);
        const letter = letters[index];
        const verdict = !outcome
          ? "not run"
          : outcome.prefiltered
            ? `pre-filtered (${outcome.prefiltered})`
            : outcome.score === null
              ? "no judgment"
              : `${outcome.score}/100 · ${outcome.surfaced ? "SURFACED" : "not surfaced"}`;
        const checks = (
          ["personalized", "angleSpecific", "quoteUnderstood"] as const
        )
          .filter(
            (field) => field !== "quoteUnderstood" || example.input.quotedPost,
          )
          .map(
            (field) =>
              `<label><input type="checkbox" data-id="${id}" data-letter="${letter}" data-field="${field}"> ${
                {
                  personalized: "personalized, not generic",
                  angleSpecific: "angle is specific",
                  quoteUnderstood: "understands the quote",
                }[field]
              }</label>`,
          )
          .join(" ");
        return `<div class="out"><b>Output ${letter}</b> — ${verdict}<p>${escape(outcome?.reason ?? "")}</p>${
          outcome?.suggestedAngle
            ? `<p><i>Angle:</i> ${escape(outcome.suggestedAngle)}</p>`
            : ""
        }<div class="checks">${checks}</div></div>`;
      })
      .join("");
    const radios = ["strong", "acceptable", "weak", "irrelevant"]
      .map(
        (label) =>
          `<label><input type="radio" name="l-${id}" value="${label}" data-id="${id}"> ${label}</label>`,
      )
      .join(" ");
    return `<section><h2>${number + 1}. @${escape(example.input.authorHandle)} · ${example.input.hoursAgo}h old · ${
      example.input.kind
    }</h2><blockquote>${escape(example.input.content)}</blockquote>${
      example.input.quotedPost
        ? `<p class="q"><b>Quoted post:</b> ${escape(example.input.quotedPost)}</p>`
        : ""
    }<p><a href="${escape(example.url)}" target="_blank" rel="noreferrer">Original post</a></p>${outputs}<div class="label"><b>Is this a reply opportunity for this user?</b> ${radios}</div></section>`;
  });

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scout scoring review</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1d1d1f}section{border-top:1px solid #ddd;padding:16px 0}blockquote{margin:8px 0;padding:8px 12px;background:#f5f5f7;white-space:pre-wrap}.q{color:#555;white-space:pre-wrap}.out{border:1px solid #e5e5e7;border-radius:8px;padding:8px 12px;margin:8px 0}.checks,.label{font-size:13px}.label{margin-top:8px}button{font:inherit;padding:8px 16px;margin:16px 0}h2{font-size:15px;margin:0}</style></head>
<body><h1>Scout scoring review</h1><p>Strategies are hidden as A/B/C and shuffled per post. Label each post, tick what holds for each output, then save. Labels stay on this computer.</p>
${cards.join("\n")}
<button id="save">Save labels JSON</button>
<script>
document.getElementById("save").onclick = () => {
  const labels = {};
  document.querySelectorAll("input[type=radio]:checked").forEach((input) => {
    labels[input.dataset.id] = { label: input.value, outputs: {} };
  });
  document.querySelectorAll("input[type=checkbox]").forEach((input) => {
    const entry = labels[input.dataset.id];
    if (!entry) return;
    entry.outputs[input.dataset.letter] ??= {};
    entry.outputs[input.dataset.letter][input.dataset.field] = input.checked;
  });
  const blob = new Blob([JSON.stringify(labels, null, 2)], { type: "application/json" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "labels.local.json" });
  link.click();
};
</script></body></html>`;
  return { html, key };
}
