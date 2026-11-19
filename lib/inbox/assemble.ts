// Day 38: turns stored Scout data into the Inbox, deterministically. Pure:
// the service loads the rows, this decides what shows, in what order, once.

import { INBOX_CAPS, type InboxItem, type InboxPreferences, type InboxSummary, URGENT } from "./types";

export type InboxSources = {
  conversations: {
    id: string;
    authorHandle: string | null;
    content: string;
    postUrl: string | null;
    platformPostId: string;
    score: number | null;
    topic: string | null;
    reason: string | null;
    postedAt: Date | null;
    createdAt: Date;
    /** The first live reply draft, if one exists */
    reply: { id: string; content: string } | null;
  }[];
  leads: {
    id: string;
    authorHandle: string;
    content: string;
    postUrl: string;
    platformPostId: string;
    opportunityId: string | null;
    score: number;
    reason: string;
    createdAt: Date;
  }[];
  posts: { id: string; text: string; why: string; topic: string | null; createdAt: Date }[];
  reminders: {
    key: string;
    /** The entity it reminds about (lead, task…): a duplicate of another reminder or card is dropped */
    entityId: string;
    title: string;
    body: string | null;
    href: string;
    at: Date;
  }[];
  recommendations: { key: string; title: string; text: string; why: string; at: Date }[];
};

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export const RANK = { urgent: 1, lead: 2, reply: 3, conversation: 3, post: 4, reminder: 5, recommendation: 6 } as const;

/**
 * Builds the cards: one per underlying event (a lead and the opportunity
 * behind it are one card; a reminder about an entity already on screen is
 * dropped), hidden when decided (or snoozed), capped per type, ordered.
 */
export function assembleInbox(
  sources: InboxSources,
  hidden: Set<string>,
  prefs: Pick<InboxPreferences, "avoidTopics">,
  now: Date,
): InboxItem[] {
  const items: InboxItem[] = [];
  const shownEntities = new Set<string>();
  const avoid = new Set(prefs.avoidTopics.map((topic) => topic.toLowerCase()));

  // Leads first: a lead and its conversation are the same event
  const leadPosts = new Set<string>();
  for (const lead of sources.leads) {
    const key = `lead:${lead.id}`;
    if (hidden.has(key)) continue;
    if (lead.opportunityId && hidden.has(`opportunity:${lead.opportunityId}`)) continue;
    if (items.filter((i) => i.type === "lead").length >= INBOX_CAPS.leads) break;
    leadPosts.add(lead.platformPostId);
    if (lead.opportunityId) leadPosts.add(`opportunity:${lead.opportunityId}`);
    shownEntities.add(lead.id);
    if (lead.opportunityId) shownEntities.add(lead.opportunityId);
    items.push({
      key,
      type: "lead",
      rank: RANK.lead,
      score: lead.score,
      at: lead.createdAt.toISOString(),
      label: "Possible customer",
      text: lead.content,
      why: short(lead.reason, 160),
      context: { author: lead.authorHandle, text: lead.content, url: lead.postUrl },
      href: `/crm/${lead.id}`,
      externalUrl: lead.postUrl,
    });
  }

  // Conversations: the best fresh ones; learned "not relevant" topics sink
  const conversations = sources.conversations
    .filter((c) => !hidden.has(`opportunity:${c.id}`) && !leadPosts.has(c.platformPostId) && !leadPosts.has(`opportunity:${c.id}`))
    .map((c) => ({ ...c, adjusted: (c.score ?? 0) - (c.topic && avoid.has(c.topic.toLowerCase()) ? 25 : 0) }))
    .sort((a, b) => b.adjusted - a.adjusted || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, INBOX_CAPS.conversations);
  let replies = 0;
  for (const c of conversations) {
    const ageHours = (now.getTime() - (c.postedAt ?? c.createdAt).getTime()) / 3_600_000;
    const urgent = (c.score ?? 0) >= URGENT.score && ageHours <= URGENT.hours;
    const withReply = c.reply && replies < INBOX_CAPS.replies;
    if (withReply) replies++;
    shownEntities.add(c.id);
    const base = {
      key: `opportunity:${c.id}`,
      score: c.adjusted,
      at: c.createdAt.toISOString(),
      context: { author: c.authorHandle, text: c.content, url: c.postUrl },
      href: `/opportunities/${c.id}`,
      externalUrl: c.postUrl,
      replyToPostId: c.platformPostId,
    };
    items.push(
      withReply
        ? {
            ...base,
            type: "reply",
            rank: urgent ? RANK.urgent : RANK.reply,
            label: "Reply ready",
            text: c.reply!.content,
            why: c.authorHandle ? `A reply to @${c.authorHandle}, in your voice.` : "A reply in your voice.",
          }
        : {
            ...base,
            type: "conversation",
            rank: urgent ? RANK.urgent : RANK.conversation,
            label: urgent ? "Join now" : "Worth joining",
            text: c.content,
            why: short(c.reason ?? "It fits what you talk about.", 160),
          },
    );
  }

  const posts = sources.posts.filter((p) => !hidden.has(`draft:${p.id}`)).slice(0, INBOX_CAPS.posts);
  for (const post of posts) {
    items.push({
      key: `draft:${post.id}`,
      type: "post",
      rank: RANK.post,
      score: 0,
      at: post.createdAt.toISOString(),
      label: "Post ready",
      text: post.text,
      why: post.why,
      href: `/studio/${post.id}`,
    });
  }

  let reminders = 0;
  for (const reminder of sources.reminders) {
    if (hidden.has(reminder.key) || shownEntities.has(reminder.entityId)) continue;
    if (reminders >= INBOX_CAPS.reminders) break;
    reminders++;
    shownEntities.add(reminder.entityId);
    items.push({
      key: reminder.key,
      type: "reminder",
      rank: RANK.reminder,
      score: 0,
      at: reminder.at.toISOString(),
      label: "Reminder",
      text: reminder.title,
      why: reminder.body ? short(reminder.body, 160) : "Due now.",
      href: reminder.href,
    });
  }

  for (const rec of sources.recommendations.filter((r) => !hidden.has(r.key)).slice(0, INBOX_CAPS.recommendations)) {
    items.push({ key: rec.key, type: "recommendation", rank: RANK.recommendation, score: 0, at: rec.at.toISOString(), label: "Try this", text: rec.text, why: rec.why, href: "/strategy" });
  }

  return items.sort((a, b) => a.rank - b.rank || b.score - a.score || b.at.localeCompare(a.at));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 conversations worth joining · 1 post ready for review": counted, no AI */
export function summarizeInbox(items: InboxItem[]): InboxSummary {
  const count = (...types: InboxItem["type"][]) => items.filter((i) => types.includes(i.type)).length;
  const parts = [
    count("reply") && plural(count("reply"), "reply ready", "replies ready"),
    count("conversation") && plural(count("conversation"), "conversation worth joining", "conversations worth joining"),
    count("lead") && plural(count("lead"), "possible customer", "possible customers"),
    count("post") && plural(count("post"), "post ready for review", "posts ready for review"),
    count("reminder") && plural(count("reminder"), "reminder", "reminders"),
    count("recommendation") && plural(count("recommendation"), "idea to try", "ideas to try"),
  ].filter((part): part is string => Boolean(part));
  return { total: items.length, parts };
}

/** Good morning / afternoon / evening, by the user's local hour */
export function greeting(localTime: string): string {
  const hour = Number(localTime.slice(0, 2));
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
