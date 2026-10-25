import "server-only";

import { and, asc, count, eq, inArray, sql } from "drizzle-orm";

import db from "@/db";
import { type WatchlistAccount, watchlistAccountsTable } from "@/db/schema";
import type { NormalizedProfile } from "@/lib/posts/types";

// Every query filters by profileId, so one user can never read or change
// another user's watchlist, even with a guessed account ID.

export async function getWatchlist(
  profileId: string,
): Promise<WatchlistAccount[]> {
  return db
    .select()
    .from(watchlistAccountsTable)
    .where(eq(watchlistAccountsTable.profileId, profileId))
    .orderBy(asc(watchlistAccountsTable.createdAt));
}

export async function countWatchlist(profileId: string): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(watchlistAccountsTable)
    .where(eq(watchlistAccountsTable.profileId, profileId));
  return result.value;
}

/** Handles are case-insensitive on X. */
export async function findWatchlistAccountByHandle(
  profileId: string,
  platform: WatchlistAccount["platform"],
  handle: string,
): Promise<WatchlistAccount | undefined> {
  const [account] = await db
    .select()
    .from(watchlistAccountsTable)
    .where(
      and(
        eq(watchlistAccountsTable.profileId, profileId),
        eq(watchlistAccountsTable.platform, platform),
        sql`lower(${watchlistAccountsTable.handle}) = lower(${handle})`,
      ),
    )
    .limit(1);
  return account;
}

/** Returns null when the account is already on the watchlist. */
export async function insertWatchlistAccount(
  profileId: string,
  platform: WatchlistAccount["platform"],
  profile: NormalizedProfile,
): Promise<WatchlistAccount | null> {
  const [account] = await db
    .insert(watchlistAccountsTable)
    .values({ profileId, platform, ...profile })
    .onConflictDoNothing({
      target: [
        watchlistAccountsTable.profileId,
        watchlistAccountsTable.platform,
        watchlistAccountsTable.platformUserId,
      ],
    })
    .returning();
  return account ?? null;
}

export async function setWatchlistAccountActive(
  profileId: string,
  accountId: string,
  isActive: boolean,
): Promise<boolean> {
  const updated = await db
    .update(watchlistAccountsTable)
    .set({ isActive })
    .where(
      and(
        eq(watchlistAccountsTable.id, accountId),
        eq(watchlistAccountsTable.profileId, profileId),
      ),
    )
    .returning({ id: watchlistAccountsTable.id });
  return updated.length > 0;
}

export async function deleteWatchlistAccount(
  profileId: string,
  accountId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(watchlistAccountsTable)
    .where(
      and(
        eq(watchlistAccountsTable.id, accountId),
        eq(watchlistAccountsTable.profileId, profileId),
      ),
    )
    .returning({ id: watchlistAccountsTable.id });
  return deleted.length > 0;
}

export async function getActiveWatchlist(
  profileId: string,
): Promise<WatchlistAccount[]> {
  return db
    .select()
    .from(watchlistAccountsTable)
    .where(
      and(
        eq(watchlistAccountsTable.profileId, profileId),
        eq(watchlistAccountsTable.isActive, true),
      ),
    )
    .orderBy(asc(watchlistAccountsTable.createdAt));
}

/** Only for accounts whose scan fully succeeded, so failed ones retry the same window. */
export async function markWatchlistAccountsScanned(
  profileId: string,
  accountIds: string[],
  scannedAt: Date,
): Promise<void> {
  if (accountIds.length === 0) return;
  await db
    .update(watchlistAccountsTable)
    .set({ lastScannedAt: scannedAt })
    .where(
      and(
        eq(watchlistAccountsTable.profileId, profileId),
        inArray(watchlistAccountsTable.id, accountIds),
      ),
    );
}

/**
 * Replaces an unverified placeholder with the real profile. Returns null when
 * the same real account is already on the watchlist under another row.
 */
export async function verifyWatchlistAccount(
  profileId: string,
  accountId: string,
  profile: NormalizedProfile,
): Promise<WatchlistAccount | null> {
  try {
    const [account] = await db
      .update(watchlistAccountsTable)
      .set(profile)
      .where(
        and(
          eq(watchlistAccountsTable.id, accountId),
          eq(watchlistAccountsTable.profileId, profileId),
        ),
      )
      .returning();
    return account ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value
      ? (value as { code: unknown }).code
      : undefined;
  const cause = error instanceof Error ? error.cause : undefined;
  return code(error) === "23505" || code(cause) === "23505";
}
