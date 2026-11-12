import type { Opportunity } from "@/db/schema";
import { splitQuotedPost } from "@/lib/posts/quotedPost";

// Slack is the short heads-up, Scout the full experience: an alert shows the
// score, the author and a short excerpt, with two buttons: into Scout and to
// the post on X. Explanations, angles and reply drafts stay in Scout. Built
// only from what scoring already stored: no AI or X calls, and nothing from
// the Scout Brain or profile.

export const SLACK_EXCERPT_CHARS = 180;

/** Slack mrkdwn treats &, < and > as control characters. */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cuts at a word boundary (unless that loses too much) and adds "…". */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, "")}…`;
}

/** One line of plain text: links (t.co) dropped, whitespace collapsed. */
function flatten(text: string): string {
  return text.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
}

/** The post's own words; for a quote with no words of its own, the quoted post. */
export function postExcerpt(content: string): { excerpt: string; isQuote: boolean } {
  const { own, quoted } = splitQuotedPost(content);
  const words = flatten(own);
  const text = words || (quoted ? flatten(quoted) : "");
  return { excerpt: truncateAtWord(text, SLACK_EXCERPT_CHARS), isQuote: quoted !== null };
}

/** Only http(s) links reach Slack buttons. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** The post's link, only when it really points at X. */
export function xPostUrl(url: string | null | undefined): string | null {
  const safe = safeUrl(url);
  if (!safe) return null;
  const host = new URL(safe).hostname;
  return ["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.twitter.com"].includes(host)
    ? safe
    : null;
}

export function opportunitySlackMessage(
  opportunity: Pick<Opportunity, "id" | "authorHandle" | "content" | "score" | "postUrl">,
  links: { openInScout: string },
): { text: string; blocks: unknown[] } {
  const score = Math.round(opportunity.score ?? 0);
  // X handles are letters, digits and underscores; anything else isn't shown
  const author =
    opportunity.authorHandle && /^\w{1,30}$/.test(opportunity.authorHandle)
      ? `@${opportunity.authorHandle}`
      : "Someone you watch";
  const { excerpt, isQuote } = postExcerpt(opportunity.content);
  const scoutUrl = safeUrl(links.openInScout);
  const xUrl = xPostUrl(opportunity.postUrl);

  const lines = [
    `🎯 *New opportunity* · *${score}*/100`,
    `*${author}*${isQuote ? " · quote post" : ""}`,
    ...(excerpt ? [`>${escape(excerpt)}`] : []),
  ];
  const buttons = [
    ...(scoutUrl
      ? [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in Scout" },
            url: scoutUrl,
            style: "primary",
            action_id: "open_in_scout",
          },
        ]
      : []),
    ...(xUrl
      ? [
          {
            type: "button",
            text: { type: "plain_text", text: "View on X" },
            url: xUrl,
            action_id: "view_on_x",
          },
        ]
      : []),
  ];

  return {
    // Push notification and screen-reader text
    text: `🎯 New opportunity (${score}/100) from ${author}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      ...(buttons.length ? [{ type: "actions", elements: buttons }] : []),
      // Slack has no margin between messages: a line ends each alert, then an
      // empty row (a zero-width space; Slack rejects empty text) below it
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "\u200b" } },
    ],
  };
}

/** "Send test notification": clearly not an opportunity, nothing about the user. */
export function testSlackMessage(links: { settingsUrl: string }): {
  text: string;
  blocks: unknown[];
} {
  return {
    text: "Scout test notification: Slack alerts are working",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🧪 Scout test notification",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*This is a test, not an opportunity.*\nScout can post to this channel. " +
            "Real alerts arrive here when an automatic scan finds a strong, fresh opportunity.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Notification settings" },
            url: links.settingsUrl,
            action_id: "open_settings",
          },
        ],
      },
    ],
  };
}
