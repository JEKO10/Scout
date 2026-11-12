import type { Opportunity } from "@/db/schema";

// Block Kit message for one opportunity alert. Only what the user would see
// on X anyway, plus Scout's one-line reason: no Brain, profile or reply data.

const MAX_POST_CHARS = 500;
const MAX_REASON_CHARS = 300;

/** Slack mrkdwn treats &, < and > as control characters. */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Each line as a quote, so the post reads like a quote in Slack. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `>${line}`)
    .join("\n");
}

export function opportunitySlackMessage(
  opportunity: Pick<Opportunity, "id" | "authorHandle" | "content" | "postUrl" | "score" | "reason">,
  links: { openInScout: string },
): { text: string; blocks: unknown[] } {
  const score = Math.round(opportunity.score ?? 0);
  const author = opportunity.authorHandle ? `@${opportunity.authorHandle}` : "Someone you watch";
  const post = escape(truncate(opportunity.content.trim(), MAX_POST_CHARS));
  const reason = opportunity.reason ? escape(truncate(opportunity.reason, MAX_REASON_CHARS)) : null;

  const buttons: unknown[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Open in Scout" },
      url: links.openInScout,
      style: "primary",
      action_id: "open_in_scout",
    },
  ];
  if (opportunity.postUrl) {
    buttons.push({
      type: "button",
      text: { type: "plain_text", text: "View original post" },
      url: opportunity.postUrl,
      action_id: "view_original",
    });
  }

  return {
    // Notification and screen-reader fallback
    text: `New Scout opportunity (${score}/100) from ${author}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🎯 New Scout opportunity", emoji: true },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `*Match score: ${score}/100*` }],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${escape(author)}*\n${quote(post)}` },
      },
      ...(reason
        ? [
            {
              type: "section",
              text: { type: "mrkdwn", text: `*Why Scout picked this*\n${reason}` },
            },
          ]
        : []),
      { type: "actions", elements: buttons },
    ],
  };
}

/** "Send test notification": clearly not an opportunity, nothing about the user. */
export function testSlackMessage(links: { settingsUrl: string }): { text: string; blocks: unknown[] } {
  return {
    text: "Scout test notification: Slack alerts are working",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🧪 Scout test notification", emoji: true },
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
