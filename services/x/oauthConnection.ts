import "server-only";

import { saveAccountSnapshot } from "@/db/queries/growth";
import { updateProfileXHandle } from "@/db/queries/profiles";
import { getXAccountUsage, linkCsvSocialAccount, upsertSocialAccount } from "@/db/queries/socialAccounts";
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
import { PLANS } from "@/lib/billing/plans";
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
  | "failed";

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
): Promise<{ status: XConnectResult; authorizedHandle?: string }> {
  const result = await completeXConnect(profile, callback, now);
  return typeof result === "string" ? { status: result } : result;
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
  if (!profile.xHandle || profile.xHandle !== me.profile.handle) await updateProfileXHandle(profile.id, me.profile.handle);
  // The follower count came with the ownership check: no extra read
  await saveAccountSnapshot(profile.id, account.id, me.counts, { now });
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
  const connection = await deleteXConnection(profileId);
  if (connection) await revokeStored(connection);
  const deletedReadings = deleteHistory ? await deletePrivateMetricSnapshots(profileId) : 0;
  return { deletedReadings };
}

/** What Settings shows: never a token */
export async function getXConnectionOverview(profile: Pick<Profile, "id" | "plan">) {
  const enabled = isXOAuthEnabled();
  const connection = enabled ? await getXConnection(profile.id) : undefined;
  return {
    enabled,
    autoEveryHours: PLANS[profile.plan].growthCollection.autoEveryHours,
    connection: connection ? {
      handle: connection.handle,
      status: connection.status,
      connectedAt: connection.connectedAt,
      lastCollectedAt: connection.lastCollectedAt,
      nextCollectionAt: connection.nextCollectionAt,
      hasRefreshToken: Boolean(connection.encryptedRefreshToken),
    } : null,
  };
}
