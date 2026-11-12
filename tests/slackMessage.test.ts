// Compact Slack alerts: format only. Pure functions, no database, no network.
import "./setup/env";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  opportunitySlackMessage,
  postExcerpt,
  safeUrl,
  SLACK_EXCERPT_CHARS,
  truncateAtWord,
  xPostUrl,
} from "@/lib/notifications/slackMessage";
import { withQuotedPost } from "@/lib/posts/quotedPost";

const LINK = "https://scout.test/opportunities/3f0c1d7e-1111-4222-8333-444455556666";
const POST = "https://x.com/founder/status/1900000000000000000";

type Button = { type: string; url: string; style?: string; text: { text: string }; action_id: string };

function render(overrides: Partial<Parameters<typeof opportunitySlackMessage>[0]> = {}, link = LINK) {
  const message = opportunitySlackMessage(
    {
      id: "3f0c1d7e-1111-4222-8333-444455556666",
      authorHandle: "founder",
      content: "What's the best way to grow on X without spending hours engaging?",
      score: 92.4,
      postUrl: POST,
      ...overrides,
    },
    { openInScout: link },
  );
  const blocks = message.blocks as { type: string; text?: { text: string }; elements?: Button[] }[];
  const buttons = blocks.find((block) => block.type === "actions")?.elements ?? [];
  return { message, blocks, buttons, text: blocks[0].text!.text };
}

test("an alert: score, author, excerpt, two buttons, a divider and space below", () => {
  const { message, blocks, buttons, text } = render();
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["section", "actions", "divider", "section"],
  );
  assert.deepEqual(text.split("\n"), [
    "🎯 *New opportunity* · *92*/100",
    "*@founder*",
    ">What's the best way to grow on X without spending hours engaging?",
  ]);
  assert.deepEqual(
    buttons.map((button) => [button.text.text, button.url, button.style]),
    [
      ["Open in Scout", LINK, "primary"],
      ["View on X", POST, undefined],
    ],
  );
  assert.deepEqual(blocks[3], { type: "section", text: { type: "mrkdwn", text: "​" } });
  assert.equal(message.text, "🎯 New opportunity (92/100) from @founder");
});

test("long posts are cut at a word boundary within 180 characters", () => {
  const long = `${"Pricing an AI product is hard because ".repeat(10)}end`;
  const { excerpt } = postExcerpt(long);
  assert.ok(excerpt.length <= SLACK_EXCERPT_CHARS, `${excerpt.length}`);
  assert.ok(excerpt.endsWith("…"));
  assert.ok(long.startsWith(excerpt.slice(0, -1)), "a prefix of the post");
  assert.ok(/\w…$/.test(excerpt), "no dangling space or comma before the ellipsis");
  // One unbroken word: a hard cut, still within the limit
  assert.equal(truncateAtWord("x".repeat(400), 180).length, 180);
  // Newlines and links don't reach the excerpt
  assert.equal(postExcerpt("Line one\n\nline two https://t.co/abc").excerpt, "Line one line two");
});

test("missing handle, text or post link degrade gracefully", () => {
  assert.ok(render({ authorHandle: null }).text.includes("*Someone you watch*"));
  assert.ok(render({ authorHandle: "evil> <!channel>" }).text.includes("*Someone you watch*"), "odd handles aren't shown");
  assert.ok(!render({ content: "https://t.co/only-a-link" }).text.includes(">"), "no empty excerpt");

  const noPost = render({ postUrl: null }).buttons;
  assert.deepEqual(noPost.map((button) => button.text.text), ["Open in Scout"]);
});

test("quote posts show the author's words, or the quoted post when they have none", () => {
  const quote = render({ content: withQuotedPost("Hard disagree.", "Founders should never talk to customers") }).text;
  assert.ok(quote.includes("*@founder* · quote post"));
  assert.ok(quote.includes(">Hard disagree."));
  assert.ok(!quote.includes("never talk to customers"));

  const bare = render({ content: withQuotedPost("https://t.co/x", "Founders should never talk to customers") }).text;
  assert.ok(bare.includes(">Founders should never talk to customers"));
});

test("Slack control characters are escaped; buttons only get safe links", () => {
  const { text } = render({ content: "Use <!channel> & <https://evil.example|click> > everything" });
  // Links are dropped from the excerpt; the rest is escaped
  assert.ok(text.includes(">Use &lt;!channel&gt; &amp; &lt; &gt; everything"), text);
  assert.ok(!text.includes("evil.example"));
  assert.ok(!/<[!@]/.test(text), "no live mentions");

  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("not a url"), null);
  assert.deepEqual(render({}, "javascript:alert(1)").buttons.map((b) => b.text.text), ["View on X"]);
  // "View on X" only for X links
  assert.equal(xPostUrl("https://evil.example/status/1"), null);
  assert.equal(xPostUrl("https://twitter.com/a/status/1"), "https://twitter.com/a/status/1");
  assert.deepEqual(render({ postUrl: "https://evil.example/x" }).buttons.map((b) => b.text.text), ["Open in Scout"]);
});
