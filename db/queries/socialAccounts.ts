import "server-only";

import { and, count, eq, sql } from "drizzle-orm";

import db from "@/db";
import { postsTable, type SocialAccount, socialAccountsTable } from "@/db/schema";
import type { NormalizedProfile } from "@/lib/posts/types";

export async function upsertSocialAccount(
  profileId: string,
  platform: SocialAccount["platform"],
  profile: NormalizedProfile,
): Promise<SocialAccount> {
  const [account] = await db
    .insert(socialAccountsTable)
    .values({ profileId, platform, ...profile })
    .onConflictDoUpdate({
      target: [
        socialAccountsTable.profileId,
        socialAccountsTable.platform,
        socialAccountsTable.platformUserId,
      ],
      // Handle, name and avatar can change on X; the user ID never does
      set: {
        handle: profile.handle,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        updatedAt: new Date(),
      },
    })
    .returning();
  return account;
}

/** Exports have no X user ID, so CSV imports use this until X confirms the real one. */
export function csvPlatformUserId(handle: string): string {
  return `csv:${handle.toLowerCase()}`;
}

/**
 * Gives a CSV-imported account its real X user ID, so a later sync updates that
 * account instead of creating a second one holding the same posts.
 */
export async function linkCsvSocialAccount(
  profileId: string,
  platform: SocialAccount["platform"],
  profile: NormalizedProfile,
): Promise<void> {
  await db
    .update(socialAccountsTable)
    .set({ platformUserId: profile.platformUserId })
    .where(
      and(
        eq(socialAccountsTable.profileId, profileId),
        eq(socialAccountsTable.platform, platform),
        eq(socialAccountsTable.platformUserId, csvPlatformUserId(profile.handle)),
      ),
    );
}

export async function markSocialAccountSynced(
  socialAccountId: string,
): Promise<void> {
  await db
    .update(socialAccountsTable)
    .set({ lastSyncedAt: new Date() })
    .where(eq(socialAccountsTable.id, socialAccountId));
}

/** The profile's synced account for a handle (X handles are case-insensitive). */
export async function getSocialAccountByHandle(
  profileId: string,
  platform: SocialAccount["platform"],
  handle: string,
): Promise<SocialAccount | undefined> {
  const [account] = await db
    .select()
    .from(socialAccountsTable)
    .where(
      and(
        eq(socialAccountsTable.profileId, profileId),
        eq(socialAccountsTable.platform, platform),
        sql`lower(${socialAccountsTable.handle}) = lower(${handle})`,
      ),
    )
    .limit(1);
  return account;
}

/**
 * X OAuth: whether this X user is already one of the profile's accounts
 * (same account, handle renamed), and how many posts Scout holds from the
 * account behind the profile's current handle.
 */
export async function getXAccountUsage(
  profileId: string,
  platformUserId: string,
  currentHandle: string,
): Promise<{ sameAccountLinked: boolean; postsFromCurrentHandle: number }> {
  const [linked, posts] = await Promise.all([
    db
      .select({ id: socialAccountsTable.id })
      .from(socialAccountsTable)
      .where(
        and(
          eq(socialAccountsTable.profileId, profileId),
          eq(socialAccountsTable.platform, "x"),
          eq(socialAccountsTable.platformUserId, platformUserId),
        ),
      )
      .limit(1),
    db
      .select({ n: count() })
      .from(postsTable)
      .innerJoin(socialAccountsTable, eq(socialAccountsTable.id, postsTable.socialAccountId))
      .where(
        and(
          eq(socialAccountsTable.profileId, profileId),
          eq(socialAccountsTable.platform, "x"),
          sql`lower(${socialAccountsTable.handle}) = lower(${currentHandle})`,
        ),
      ),
  ]);
  return { sameAccountLinked: linked.length > 0, postsFromCurrentHandle: posts[0]?.n ?? 0 };
}
