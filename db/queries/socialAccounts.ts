import "server-only";

import { and, eq, sql } from "drizzle-orm";

import db from "@/db";
import { type SocialAccount, socialAccountsTable } from "@/db/schema";
import type { NormalizedProfile } from "@/lib/x/types";

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
