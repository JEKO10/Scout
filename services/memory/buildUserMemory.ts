import "server-only";

import {
  type EngagementRow,
  getEngagementHistory,
  getReplyHistory,
  type ReplyHistoryRow,
} from "@/db/queries/memory";

import {
  AGREEMENT_OPENER,
  detectEditPatterns,
  type EditPattern,
  editPatternLabels,
} from "./editPatterns";

// MEMORY answers "what has happened?" (the Scout Brain answers "who is this
// person?"). It is rebuilt from the user's behavior on every call; nothing is
// stored separately, so it can never drift from what actually happened.

const WINDOW_DAYS = 90;
/** A pattern seen fewer times than this is a one-off, not a preference */
export const MIN_REPEATS = 3;
/** ...and it must hold for at least this share of the relevant cases */
const MIN_SHARE = 0.5;
const MAX_ARGUMENTS = 20;
const MAX_EDIT_EXAMPLES = 3;
/** Replies to one account in a day before Scout calls it over-engaged */
const OVER_ENGAGED_PER_DAY = 3;
const OVER_ENGAGED_PER_WEEK = 8;

export type MemoryPreference = { label: string; evidence: number; of: number };

export type PersonMemory = {
  handle: string;
  interactions: number;
  today: number;
  lastReply: string | null;
  lastAt: Date | null;
  relationship: "existing" | "over_engaged";
};

export type UserMemory = {
  windowDays: number;
  counts: {
    generated: number;
    accepted: number;
    edited: number;
    rejected: number;
    skippedOpportunities: number;
    savedOpportunities: number;
  };
  /** Only patterns repeated at least MIN_REPEATS times */
  preferences: MemoryPreference[];
  rejectedStyles: MemoryPreference[];
  variants: { natural: number; strongerTake: number };
  topics: { engaged: TopicCount[]; dismissed: TopicCount[] };
  /** Final text of replies the user accepted, newest first */
  arguments: { text: string; authorHandle: string | null; at: Date }[];
  people: PersonMemory[];
  editExamples: { original: string; final: string }[];

  // Raw signals for the Day 13 Learning Engine
  /** Every edited reply, newest first: what changed and final/original length */
  edits: { patterns: EditPattern[]; lengthRatio: number }[];
  acceptedLengths: number[];
  /** Per topic: replied or saved vs skipped */
  topicSignals: { topic: string; engaged: number; dismissed: number }[];
  /** Accepted, edited, rejected, skipped and saved, in the window */
  interactionCount: number;
};

export type TopicCount = { topic: string; count: number };

type ReplyOutcome = "accepted" | "rejected" | "pending";

/** What became of one generated reply */
function outcome(row: ReplyHistoryRow): ReplyOutcome {
  if (row.reply.status === "approved" || row.reply.status === "posted") return "accepted";
  // Regenerated over, or left behind when the user skipped the opportunity
  if (row.reply.status === "discarded" || row.opportunity.status === "dismissed") {
    return "rejected";
  }
  return "pending";
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function countTopics(rows: EngagementRow[], statuses: string[]): TopicCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.topic || !statuses.includes(row.status)) continue;
    counts.set(row.topic, (counts.get(row.topic) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count);
}

function topicSignals(rows: EngagementRow[]) {
  const signals = new Map<string, { topic: string; engaged: number; dismissed: number }>();
  for (const row of rows) {
    if (!row.topic) continue;
    const entry = signals.get(row.topic) ?? { topic: row.topic, engaged: 0, dismissed: 0 };
    if (row.status === "replied" || row.status === "saved") entry.engaged++;
    if (row.status === "dismissed") entry.dismissed++;
    signals.set(row.topic, entry);
  }
  return [...signals.values()];
}

/** Pure: turns raw history into memory. */
export function summarizeMemory(
  replies: ReplyHistoryRow[],
  engagement: EngagementRow[],
  now: Date,
): UserMemory {
  const accepted = replies.filter((row) => outcome(row) === "accepted");
  const rejected = replies.filter((row) => outcome(row) === "rejected");
  const edited = replies.filter(
    (row) => row.reply.content.trim() !== row.reply.originalContent.trim(),
  );

  // Edit patterns: counted per edited reply, kept only when they repeat
  const patternCounts = new Map<EditPattern, number>();
  for (const row of edited) {
    for (const pattern of detectEditPatterns(row.reply.originalContent, row.reply.content)) {
      patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
    }
  }
  const preferences: MemoryPreference[] = [...patternCounts.entries()]
    .filter(([, count]) => count >= MIN_REPEATS && count >= edited.length * MIN_SHARE)
    .map(([pattern, count]) => ({
      label: editPatternLabels[pattern],
      evidence: count,
      of: edited.length,
    }));

  const variants = {
    natural: accepted.filter((row) => row.reply.variant === "natural").length,
    strongerTake: accepted.filter((row) => row.reply.variant === "stronger_take").length,
  };
  const totalPicked = variants.natural + variants.strongerTake;
  for (const [key, label] of [
    ["natural", "Usually picks the Natural reply"],
    ["strongerTake", "Usually picks the Stronger take"],
  ] as const) {
    if (variants[key] >= MIN_REPEATS && variants[key] >= totalPicked * 0.7) {
      preferences.push({ label, evidence: variants[key], of: totalPicked });
    }
  }

  // Styles the user turns down: compare rejected drafts with accepted ones
  const rejectedStyles: MemoryPreference[] = [];
  const rejectedOpeners = rejected.filter((row) =>
    AGREEMENT_OPENER.test(row.reply.originalContent),
  ).length;
  if (rejectedOpeners >= MIN_REPEATS && rejectedOpeners >= rejected.length * MIN_SHARE) {
    rejectedStyles.push({
      label: "Rejects drafts that open with generic agreement",
      evidence: rejectedOpeners,
      of: rejected.length,
    });
  }
  const acceptedLength = median(accepted.map((row) => row.reply.content.length));
  const rejectedLength = median(rejected.map((row) => row.reply.originalContent.length));
  if (
    accepted.length >= MIN_REPEATS &&
    rejected.length >= MIN_REPEATS &&
    acceptedLength !== null &&
    rejectedLength !== null &&
    rejectedLength > acceptedLength * 1.3
  ) {
    rejectedStyles.push({
      label: `Rejects long drafts (rejected ~${rejectedLength} chars vs accepted ~${acceptedLength})`,
      evidence: rejected.length,
      of: rejected.length + accepted.length,
    });
  }

  // People: who the user has actually replied to
  const dayAgo = now.getTime() - 86_400_000;
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const byPerson = new Map<string, ReplyHistoryRow[]>();
  for (const row of accepted) {
    const handle = row.opportunity.authorHandle;
    if (!handle) continue;
    byPerson.set(handle, [...(byPerson.get(handle) ?? []), row]);
  }
  const people: PersonMemory[] = [...byPerson.entries()]
    .map(([handle, rows]) => {
      const today = rows.filter((row) => row.reply.updatedAt.getTime() > dayAgo).length;
      const week = rows.filter((row) => row.reply.updatedAt.getTime() > weekAgo).length;
      const latest = rows[0]; // rows are newest first
      return {
        handle,
        interactions: rows.length,
        today,
        lastReply: latest?.reply.content ?? null,
        lastAt: latest?.reply.updatedAt ?? null,
        relationship:
          today >= OVER_ENGAGED_PER_DAY || week >= OVER_ENGAGED_PER_WEEK
            ? ("over_engaged" as const)
            : ("existing" as const),
      };
    })
    .sort((a, b) => b.interactions - a.interactions);

  return {
    windowDays: WINDOW_DAYS,
    counts: {
      generated: replies.length,
      accepted: accepted.length,
      edited: edited.length,
      rejected: rejected.length,
      skippedOpportunities: engagement.filter((row) => row.status === "dismissed").length,
      savedOpportunities: engagement.filter((row) => row.status === "saved").length,
    },
    preferences,
    rejectedStyles,
    variants,
    topics: {
      engaged: countTopics(engagement, ["replied", "saved"]),
      dismissed: countTopics(engagement, ["dismissed"]),
    },
    arguments: accepted.slice(0, MAX_ARGUMENTS).map((row) => ({
      text: row.reply.content,
      authorHandle: row.opportunity.authorHandle,
      at: row.reply.updatedAt,
    })),
    people,
    edits: edited.map((row) => ({
      patterns: detectEditPatterns(row.reply.originalContent, row.reply.content),
      lengthRatio: row.reply.content.length / Math.max(1, row.reply.originalContent.length),
    })),
    acceptedLengths: accepted.map((row) => row.reply.content.length),
    topicSignals: topicSignals(engagement),
    interactionCount:
      accepted.length +
      edited.length +
      rejected.length +
      engagement.filter((row) => row.status === "dismissed" || row.status === "saved").length,
    editExamples: edited
      .filter((row) => outcome(row) === "accepted")
      .slice(0, MAX_EDIT_EXAMPLES)
      .map((row) => ({ original: row.reply.originalContent, final: row.reply.content })),
  };
}

export async function buildUserMemory(profileId: string): Promise<UserMemory> {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const [replies, engagement] = await Promise.all([
    getReplyHistory(profileId, since),
    getEngagementHistory(profileId, since),
  ]);
  return summarizeMemory(replies, engagement, now);
}
