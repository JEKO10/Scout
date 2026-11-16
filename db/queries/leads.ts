import "server-only";

import { and, count, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import db from "@/db";
import {
  type Lead,
  leadsTable,
  opportunitiesTable,
  profilesTable,
  type ScoutCandidate,
  scoutCandidatesTable,
} from "@/db/schema";
import type { LeadIntent, LeadProfile } from "@/lib/leads/types";

// Every read and write is scoped by profileId: a lead is only ever its owner's.

export async function saveLeadProfile(profileId: string, leadProfile: LeadProfile): Promise<void> {
  await db.update(profilesTable).set({ leadProfile }).where(eq(profilesTable.id, profileId));
}

/**
 * Candidates worth a buying-intent check: scored, relevant enough, recent,
 * never checked before. Most relevant first, so a small cap checks the best.
 */
export async function getLeadCandidates(
  profileId: string,
  { minScore, postedAfter, limit }: { minScore: number; postedAfter: Date; limit: number },
): Promise<ScoutCandidate[]> {
  if (limit <= 0) return [];
  return db
    .select()
    .from(scoutCandidatesTable)
    .where(
      and(
        eq(scoutCandidatesTable.profileId, profileId),
        isNull(scoutCandidatesTable.leadCheckedAt),
        isNull(scoutCandidatesTable.rejectedReason),
        isNotNull(scoutCandidatesTable.scoredAt),
        gte(scoutCandidatesTable.score, minScore),
        gte(scoutCandidatesTable.postedAt, postedAfter),
      ),
    )
    .orderBy(desc(scoutCandidatesTable.score))
    .limit(limit);
}

export async function markCandidatesLeadChecked(profileId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(scoutCandidatesTable)
    .set({ leadCheckedAt: new Date() })
    .where(and(eq(scoutCandidatesTable.profileId, profileId), inArray(scoutCandidatesTable.id, ids)));
}

export type NewLead = Omit<typeof leadsTable.$inferInsert, "id" | "createdAt" | "updatedAt" | "saved">;

/** UNIQUE(profileId, platform, platformPostId): a post is one lead per user */
export async function insertLeads(leads: NewLead[]): Promise<number> {
  if (leads.length === 0) return 0;
  const rows = await db.insert(leadsTable).values(leads).onConflictDoNothing().returning({ id: leadsTable.id });
  return rows.length;
}

export type LeadFilters = { intent?: LeadIntent; minScore?: number; topicId?: string; sinceDays?: number; saved?: boolean };

export async function getLeads(profileId: string, filters: LeadFilters, limit = 50): Promise<Lead[]> {
  const conditions = [eq(leadsTable.profileId, profileId)];
  if (filters.intent) conditions.push(eq(leadsTable.intent, filters.intent));
  if (filters.minScore) conditions.push(gte(leadsTable.score, filters.minScore));
  if (filters.topicId) conditions.push(eq(leadsTable.discoveryTopicId, filters.topicId));
  if (filters.saved) conditions.push(eq(leadsTable.saved, true));
  if (filters.sinceDays) conditions.push(gte(leadsTable.createdAt, new Date(Date.now() - filters.sinceDays * 86_400_000)));
  return db
    .select()
    .from(leadsTable)
    .where(and(...conditions))
    .orderBy(filters.sinceDays ? desc(leadsTable.createdAt) : desc(leadsTable.score), desc(leadsTable.createdAt))
    .limit(limit);
}

export async function getLead(profileId: string, id: string): Promise<Lead | undefined> {
  const [row] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.profileId, profileId)));
  return row;
}

/** The lead an opportunity came from, if any (for lead-aware reply drafts) */
export async function getLeadByOpportunity(profileId: string, opportunityId: string): Promise<Lead | undefined> {
  const [row] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.profileId, profileId), eq(leadsTable.opportunityId, opportunityId)));
  return row;
}

export async function setLeadSaved(profileId: string, id: string, saved: boolean): Promise<boolean> {
  const rows = await db
    .update(leadsTable)
    .set({ saved })
    .where(and(eq(leadsTable.id, id), eq(leadsTable.profileId, profileId)))
    .returning({ id: leadsTable.id });
  return rows.length > 0;
}

/**
 * The opportunity a lead's reply goes through: the existing one for the same
 * post, or a new one built from the lead (the reply flow needs one).
 */
export async function ensureLeadOpportunity(profileId: string, lead: Lead): Promise<string | null> {
  if (lead.opportunityId) return lead.opportunityId;
  const [existing] = await db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.profileId, profileId),
        eq(opportunitiesTable.platform, lead.platform),
        eq(opportunitiesTable.platformPostId, lead.platformPostId),
      ),
    );
  let opportunityId = existing?.id ?? null;
  if (!opportunityId) {
    const candidate = lead.candidateId
      ? (await db.select().from(scoutCandidatesTable).where(eq(scoutCandidatesTable.id, lead.candidateId)))[0]
      : undefined;
    if (!candidate) return null;
    const [created] = await db
      .insert(opportunitiesTable)
      .values({
        scoutRunId: candidate.runId,
        profileId,
        platform: lead.platform,
        platformPostId: lead.platformPostId,
        postUrl: lead.postUrl,
        authorPlatformUserId: lead.authorPlatformUserId,
        authorHandle: lead.authorHandle,
        content: lead.content,
        score: candidate.score,
        scoreBreakdown: candidate.scoreBreakdown,
        reason: lead.reason,
        suggestedAngle: lead.suggestedAction,
        topic: candidate.topic,
        discoveryTopicId: lead.discoveryTopicId,
        status: "saved",
        postedAt: lead.postedAt,
      })
      .onConflictDoNothing()
      .returning({ id: opportunitiesTable.id });
    opportunityId = created?.id ?? null;
  }
  if (opportunityId) {
    await db
      .update(leadsTable)
      .set({ opportunityId })
      .where(and(eq(leadsTable.id, lead.id), eq(leadsTable.profileId, profileId)));
  }
  return opportunityId;
}

/** The user's lead counts, for the page header */
export async function getLeadCounts(profileId: string) {
  const [row] = await db
    .select({
      total: count(),
      high: sql<number>`count(*) filter (where ${leadsTable.intent} = 'high')::int`,
      saved: sql<number>`count(*) filter (where ${leadsTable.saved})::int`,
    })
    .from(leadsTable)
    .where(eq(leadsTable.profileId, profileId));
  return { total: row?.total ?? 0, high: row?.high ?? 0, saved: row?.saved ?? 0 };
}
