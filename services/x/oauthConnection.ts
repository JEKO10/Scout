import "server-only";

import { saveAccountSnapshot } from "@/db/queries/growth";
import { updateProfileXHandle } from "@/db/queries/profiles";
import { cancelActivePublications } from "@/db/queries/publications";
import { getSocialAccountById, getXAccountUsage, linkCsvSocialAccount, upsertSocialAccount } from "@/db/queries/socialAccounts";
import {
  deletePrivateMetricSnapshots,
  deleteXConnection,
  getXConnection,
  markXConnectionNeedsReconnect,
  saveXConnection,
  updateXTokens,
  xUserConnectedElsewhere,
} from "@/db/queries/xConnections";
import type { Profile, XConnection } from "@/db/schema";
import { effectiveLimits, PLANS } from "@/lib/billing/plans";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { getXAuthenticatedUser, XApiBudgetError, XApiRequestError } from "@/lib/x/client";
import {
  exchangeXCode,
  isXOAuthEnabled,
  readXOAuthCookie,
  refreshXToken,
  revokeXToken,
  X_OAUTH_SCOPES,
  XOAuthError,
  type XTokenSet,
} from "@/lib/x/oauth";
import { grantedScopes } from "@/lib/x/permissions";

// Connecting, using and disconnecting the user's own X account (OAuth 2.0).
// Tokens are decrypted only in this module; nothing it returns contains one.

export type XConnectResult =
  | "connected"
  | "not_configured"
  | "invalid_state"
  | "cancelled"
  | "missing_scope"
  | "handle_mismatch"
  | "in_use"
  | "budget"
  | "failed"
  /** Day 40: connected, and X granted publishing (tweet.write) as asked */
  | "publishing_enabled"
  /** Connected read-only: the user didn't grant publishing on X's screen */
  | "publish_not_granted";

/** Refresh the access token this long before X says it expires */
const EXPIRY_MARGIN_MS = 60_000;

const sameHandle = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** First automatic collection: one cadence after connecting; null on manual-only plans */
export function nextAutoCollectionAt(plan: Profile["plan"], from: Date): Date | null {
  const hours = PLANS[plan].growthCollection.autoEveryHours;
  return hours === null ? null : new Date(from.getTime() + hours * 3_600_000);
}

async function revokeQuietly(tokens: Pick<XTokenSet, "accessToken" | "refreshToken">): Promise<void> {
  try {
    if (tokens.refreshToken) await revokeXToken(tokens.refreshToken, "refresh_token");
    await revokeXToken(tokens.accessToken, "access_token");
  } catch {
    // Best effort: Scout keeps nothing either way
  }
}

/**
 * The OAuth callback. The code is used only when the state matches the
 * encrypted cookie this signed-in profile got when it started; the account
 * is the one X says the token belongs to (GET /2/users/me), never a handle
 * the user typed.
 */
export async function handleXOAuthCallback(
  profile: Pick<Profile, "id" | "plan" | "xHandle">,
  callback: { state: string | null; code: string | null; error: string | null; cookie: string | undefined },
  now = new Date(),
): Promise<{ status: XConnectResult; authorizedHandle?: string; returnTo?: string | null }> {
  // The page "Enable publishing" was started from, read from the verified cookie only
  const flow = readXOAuthCookie(callback.state, callback.cookie, profile.id, now.getTime());
  const result = await completeXConnect(profile, callback, now);
  const base = typeof result === "string" ? { status: result } : result;
  return flow?.returnTo ? { ...base, returnTo: flow.returnTo } : base;
}

async function completeXConnect(
  profile: Pick<Profile, "id" | "plan" | "xHandle">,
  callback: { state: string | null; code: string | null; error: string | null; cookie: string | undefined },
  now: Date,
): Promise<XConnectResult | { status: "handle_mismatch"; authorizedHandle: string }> {
  if (!isXOAuthEnabled()) return "not_configured";
  const flow = readXOAuthCookie(callback.state, callback.cookie, profile.id, now.getTime());
  if (!flow) return "invalid_state";
  if (callback.error) return "cancelled";
  if (!callback.code) return "failed";

  let tokens: XTokenSet;
  try {
    tokens = await exchangeXCode(callback.code, flow.verifier, now.getTime());
  } catch (error) {
    console.error("X OAuth code exchange failed", error instanceof XOAuthError ? error.code : error);
    return "failed";
  }

  // Read-only scopes we asked for; offline.access is optional (no refresh token then)
  const required = X_OAUTH_SCOPES.filter((scope) => scope !== "offline.access");
  if (required.some((scope) => !tokens.scopes.includes(scope))) {
    await revokeQuietly(tokens);
    return "missing_scope";
  }

  let me: Awaited<ReturnType<typeof getXAuthenticatedUser>>;
  try {
    me = await getXAuthenticatedUser(tokens.accessToken);
  } catch (error) {
    await revokeQuietly(tokens);
    return error instanceof XApiBudgetError ? "budget" : "failed";
  }
  if (!me) {
    await revokeQuietly(tokens);
    return "failed";
  }

  // Another account than the profile's handle. Accepted when it is the same
  // X account renamed, or when Scout holds nothing from the current handle
  // (nothing to mix). Otherwise the user chooses: switch Scout to the
  // account they authorized, or sign in to X as the current one.
  if (profile.xHandle && !sameHandle(profile.xHandle, me.profile.handle)) {
    const usage = await getXAccountUsage(profile.id, me.profile.platformUserId, profile.xHandle);
    if (!usage.sameAccountLinked && usage.postsFromCurrentHandle > 0) {
      await revokeQuietly(tokens);
      return { status: "handle_mismatch", authorizedHandle: me.profile.handle };
    }
  }
  if (await xUserConnectedElsewhere(me.profile.platformUserId, profile.id)) {
    await revokeQuietly(tokens);
    return "in_use";
  }

  await linkCsvSocialAccount(profile.id, "x", me.profile);
  const account = await upsertSocialAccount(profile.id, "x", me.profile);
  // Revoke what a previous connection of this profile held: it's replaced
  const previous = await getXConnection(profile.id);
  await saveXConnection(
    profile.id,
    {
      socialAccountId: account.id,
      xUserId: me.profile.platformUserId,
      handle: me.profile.handle,
      scopes: tokens.scopes.join(" "),
      encryptedAccessToken: encryptToken(tokens.accessToken),
      encryptedRefreshToken: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
      accessTokenExpiresAt: tokens.expiresAt,
      nextCollectionAt: nextAutoCollectionAt(profile.plan, now),
    },
    now,
  );
  if (previous) await revokeStored(previous);
  // Approvals were given for the previous X account: they never carry over to another one
  if (previous && previous.xUserId !== me.profile.platformUserId) await cancelActivePublications(profile.id, "X account changed: approve again.");
  if (!profile.xHandle || profile.xHandle !== me.profile.handle) await updateProfileXHandle(profile.id, me.profile.handle);
  // The follower count came with the ownership check: no extra read
  await saveAccountSnapshot(profile.id, account.id, me.counts, { now });
  if (flow.publish) return tokens.scopes.includes("tweet.write") ? "publishing_enabled" : "publish_not_granted";
  return "connected";
}

/** Thrown when only reconnecting X can help; the connection is already flagged */
export class XReconnectRequiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "XReconnectRequiredError";
  }
}

/**
 * A usable access token, refreshed when it is about to expire. Call only
 * while holding the connection (claimXConnection): X rotates refresh
 * tokens, so two refreshes at once would kill the connection.
 */
export async function getXAccessToken(connection: XConnection, now = new Date()): Promise<string> {
  if (connection.accessTokenExpiresAt.getTime() - EXPIRY_MARGIN_MS > now.getTime()) {
    return decryptToken(connection.encryptedAccessToken);
  }
  if (!connection.encryptedRefreshToken) {
    await markXConnectionNeedsReconnect(connection.id, "access token expired, no refresh token");
    throw new XReconnectRequiredError("expired");
  }
  try {
    const tokens = await refreshXToken(decryptToken(connection.encryptedRefreshToken), now.getTime());
    await updateXTokens(connection.id, {
      encryptedAccessToken: encryptToken(tokens.accessToken),
      // Rotated: the old one is spent. Kept only if X didn't send a new one.
      encryptedRefreshToken: tokens.refreshToken ? encryptToken(tokens.refreshToken) : connection.encryptedRefreshToken,
      accessTokenExpiresAt: tokens.expiresAt,
    });
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof XOAuthError && error.needsReconnect) {
      await markXConnectionNeedsReconnect(connection.id, `refresh failed: ${error.code}`);
      throw new XReconnectRequiredError(error.code);
    }
    throw error;
  }
}

/** A 401 from X on a user-token call: the user revoked Scout on X */
export async function flagIfUnauthorized(connection: XConnection, error: unknown): Promise<boolean> {
  if (error instanceof XApiRequestError && (error.status === 401 || error.status === 403)) {
    await markXConnectionNeedsReconnect(connection.id, `X answered ${error.status}`);
    return true;
  }
  return false;
}

async function revokeStored(connection: XConnection): Promise<void> {
  try {
    await revokeQuietly({
      accessToken: decryptToken(connection.encryptedAccessToken),
      refreshToken: connection.encryptedRefreshToken ? decryptToken(connection.encryptedRefreshToken) : null,
    });
  } catch {
    // Undecryptable (key rotated): nothing to revoke with
  }
}

/**
 * Removes the tokens (revoked at X, best effort) and the connection. Posts
 * and follower readings stay, like after a public sync; private metric
 * history is deleted too when the user asks for it.
 */
export async function disconnectX(profileId: string, { deleteHistory = false }: { deleteHistory?: boolean } = {}): Promise<{ deletedReadings: number }> {
  // Day 40: consent ends with the connection; nothing scheduled may publish afterwards
  await cancelActivePublications(profileId, "X was disconnected.");
  const connection = await deleteXConnection(profileId);
  if (connection) await revokeStored(connection);
  const deletedReadings = deleteHistory ? await deletePrivateMetricSnapshots(profileId) : 0;
  return { deletedReadings };
}

/** What Settings shows: never a token */
export async function getXConnectionOverview(profile: Pick<Profile, "id" | "plan" | "usageLimitOverrides">, now = new Date()) {
  const enabled = isXOAuthEnabled();
  const connection = enabled ? await getXConnection(profile.id) : undefined;
  const account = connection ? await getSocialAccountById(profile.id, connection.socialAccountId) : undefined;
  const importCap = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxInitialImportPosts;
  const state: XConnectionState | null = !connection
    ? null
    : connection.status === "needs_reconnect"
      ? "needs_reauthorization"
      : connection.busyUntil && connection.busyUntil > now
        ? "syncing"
        : connection.lastError
          ? "sync_failed"
          : "connected";
  return {
    enabled,
    autoEveryHours: PLANS[profile.plan].growthCollection.autoEveryHours,
    importCap,
    connection: connection
      ? {
          handle: connection.handle,
          displayName: account?.displayName ?? null,
          avatarUrl: account?.avatarUrl ?? null,
          state,
          status: connection.status,
          lastError: connection.lastError,
          scopes: grantedScopes(connection.scopes),
          connectedAt: connection.connectedAt,
          lastCollectedAt: connection.lastCollectedAt,
          nextCollectionAt: connection.nextCollectionAt,
          initialImportAt: connection.initialImportAt,
          hasRefreshToken: Boolean(connection.encryptedRefreshToken),
        }
      : null,
  };
}

export type XConnectionState = "connected" | "syncing" | "needs_reauthorization" | "sync_failed";

/**
 * Day 40.1 account deletion: revokes Scout's X tokens at X and deletes the
 * connection, strictly. "failed": X didn't confirm the revocation, nothing was
 * deleted, try again. Tokens that can't be decrypted any more (key rotated)
 * can't be revoked or used by anyone; the connection is deleted.
 */
export async function revokeAndDeleteXConnection(profileId: string): Promise<"none" | "revoked" | "undecryptable" | "failed"> {
  const connection = await getXConnection(profileId);
  if (!connection) return "none";
  let tokens: { access: string; refresh: string | null };
  try {
    tokens = {
      access: decryptToken(connection.encryptedAccessToken),
      refresh: connection.encryptedRefreshToken ? decryptToken(connection.encryptedRefreshToken) : null,
    };
  } catch {
    await cancelActivePublications(profileId, "X was disconnected.");
    await deleteXConnection(profileId);
    return "undecryptable";
  }
  try {
    // The refresh token first: it's the one that would keep access alive
    if (tokens.refresh && !(await revokeXToken(tokens.refresh, "refresh_token"))) return "failed";
    if (!(await revokeXToken(tokens.access, "access_token"))) return "failed";
  } catch {
    return "failed";
  }
  await cancelActivePublications(profileId, "X was disconnected.");
  await deleteXConnection(profileId);
  return "revoked";
}
