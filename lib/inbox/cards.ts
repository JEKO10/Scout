// Home card spec: which actions each card offers, and their words. Pure, so
// the card component and the tests share it. Every action happens on the
// card itself; there is no generic "Open" (only "View on X" for the source).

import type { InboxItem, InboxItemType } from "./types";

export type CardAction = "approve" | "edit" | "regenerate" | "decline" | "write_reply" | "save" | "dismiss" | "accept" | "done" | "snooze" | "prepare" | "publish_now" | "schedule";

export type CardSpec = {
  primary: { action: CardAction; label: string };
  secondary: { action: CardAction; label: string }[];
  /** The card's small heading when the item doesn't set one */
  icon: "reply" | "post" | "conversation" | "lead" | "idea" | "reminder";
};

export function cardSpec(item: Pick<InboxItem, "type" | "prepare">): CardSpec {
  switch (item.type) {
    case "post":
    case "reply":
      return {
        primary: { action: "approve", label: "Approve" },
        secondary: [
          { action: "edit", label: "Edit" },
          { action: "regenerate", label: "Regenerate" },
          { action: "decline", label: "Decline" },
        ],
        icon: item.type,
      };
    case "publish":
      // Rendered by PublishCard: these are its default actions when publishing is possible
      return {
        primary: { action: "publish_now", label: "Publish now" },
        secondary: [
          { action: "schedule", label: "Schedule" },
          { action: "edit", label: "Edit" },
        ],
        icon: "post",
      };
    case "conversation":
      // Not "Reply ready": no draft exists yet. Preparing one is a click (writing budget).
      return {
        primary: { action: "write_reply", label: "Prepare reply" },
        secondary: [
          { action: "save", label: "Save" },
          { action: "dismiss", label: "Dismiss" },
        ],
        icon: "conversation",
      };
    case "lead":
      return { primary: { action: "save", label: "Save lead" }, secondary: [{ action: "dismiss", label: "Dismiss" }], icon: "lead" };
    case "recommendation":
      return { primary: { action: "accept", label: "Start experiment" }, secondary: [{ action: "dismiss", label: "Dismiss" }], icon: "idea" };
    case "reminder":
      return item.prepare?.length
        ? {
            // Scout does the task's work itself; the user then approves the result
            primary: {
              action: "prepare",
              label: item.prepare.length > 1 ? "Prepare post & reply" : item.prepare[0] === "post" ? "Prepare a post" : "Prepare a reply",
            },
            secondary: [
              { action: "done", label: "Done" },
              { action: "snooze", label: "Tomorrow" },
            ],
            icon: "reminder",
          }
        : { primary: { action: "done", label: "Done" }, secondary: [{ action: "snooze", label: "Tomorrow" }], icon: "reminder" };
  }
}

const NOUN: Record<InboxItemType, [string, string]> = {
  reply: ["reply", "replies"],
  conversation: ["conversation", "conversations"],
  lead: ["possible customer", "possible customers"],
  post: ["post", "posts"],
  recommendation: ["growth idea", "growth ideas"],
  reminder: ["reminder", "reminders"],
  publish: ["post to publish", "posts to publish"],
};

/** "1 reply", "1 post", "1 growth idea": only categories that have items, counted (no AI) */
export function summaryChips(items: Pick<InboxItem, "type">[]): { type: InboxItemType; label: string }[] {
  const order: InboxItemType[] = ["reply", "conversation", "lead", "post", "publish", "recommendation", "reminder"];
  return order
    .map((type) => ({ type, n: items.filter((i) => i.type === type).length }))
    .filter(({ n }) => n > 0)
    .map(({ type, n }) => ({ type, label: `${n} ${NOUN[type][n === 1 ? 0 : 1]}` }));
}
