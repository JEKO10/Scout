// Day 28 Lead Scout CRM: pipeline statuses and the "next best action", from
// stored lead data only. Deterministic: no AI call, no cost, same answer for
// the same data. Pure, no I/O.
import type { LeadIntent } from "./types";

export const LEAD_STATUSES = ["new", "researching", "contacted", "replied", "qualified", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  researching: "Researching",
  contacted: "Contacted",
  replied: "Replied",
  qualified: "Qualified",
  won: "Won",
  lost: "Lost",
};

/** Statuses meaning the user says they've reached out (user-entered, not verified) */
export const CONTACTED_OR_LATER: LeadStatus[] = ["contacted", "replied", "qualified", "won", "lost"];

export type NextActionInput = {
  status: LeadStatus;
  intent: LeadIntent;
  postedAt: Date;
  followUpAt: Date | null;
  followUpDoneAt: Date | null;
  /** When the user last did something with this lead (status, note, contact…) */
  lastActivityAt: Date | null;
  /** Kinds of activity recorded so far */
  activityKinds: string[];
};

export type NextAction = { tone: "urgent" | "suggest" | "info"; text: string } | null;

const DAY = 86_400_000;
const days = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);

/** Follow-up state for lists: overdue, due today (UTC), upcoming, or none */
export function followUpState(followUpAt: Date | null, followUpDoneAt: Date | null, now = new Date()) {
  if (!followUpAt || (followUpDoneAt && followUpDoneAt >= followUpAt)) return "none" as const;
  const today = now.toISOString().slice(0, 10);
  const due = followUpAt.toISOString().slice(0, 10);
  if (due < today) return "overdue" as const;
  if (due === today) return "today" as const;
  return "upcoming" as const;
}

/**
 * One suggestion per lead, grounded in its data: the most pressing first.
 * Never a claim about how likely someone is to buy.
 */
export function nextBestAction(lead: NextActionInput, now = new Date()): NextAction {
  if (lead.status === "won" || lead.status === "lost") return null;

  const follow = followUpState(lead.followUpAt, lead.followUpDoneAt, now);
  if (follow === "overdue") {
    return { tone: "urgent", text: `Your follow-up was due ${days(lead.followUpAt!, now)} day(s) ago. Review it, or set a new date.` };
  }
  if (follow === "today") return { tone: "urgent", text: "Your follow-up is due today." };

  const engaged = lead.activityKinds.some((kind) =>
    ["reply_started", "contact_logged", "response_logged", "note_added", "status_changed"].includes(kind),
  );
  const postAge = days(lead.postedAt, now);
  if ((lead.status === "new" || lead.status === "researching") && !engaged) {
    if (lead.intent === "high") {
      return postAge <= 3
        ? { tone: "suggest", text: "This person is actively looking for a solution. Consider replying to their original post with something useful." }
        : { tone: "suggest", text: `High buying intent, but the post is ${postAge} days old. A reply may still help; check whether the conversation moved on.` };
    }
    return { tone: "info", text: "No activity yet. Read the post and decide whether it's worth engaging." };
  }

  const quiet = lead.lastActivityAt ? days(lead.lastActivityAt, now) : null;
  if (lead.status === "contacted" && !lead.activityKinds.includes("response_logged") && quiet !== null && quiet >= 3) {
    return { tone: "suggest", text: `You marked this lead as contacted ${quiet} days ago with no response logged. Review whether a follow-up is appropriate.` };
  }
  if (lead.status === "replied") return { tone: "suggest", text: "They replied. Decide whether they're a fit, and mark them qualified or lost." };
  if (!lead.followUpAt && (lead.status === "contacted" || lead.status === "qualified")) {
    return { tone: "info", text: "No follow-up date set. Add one so this lead doesn't go quiet." };
  }
  return null;
}
