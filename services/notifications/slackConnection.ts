import "server-only";

import {
  countOtherTeamConnections,
  deleteSlackConnection,
  getSlackConnection,
  markSlackConnection,
  saveNotificationSettings,
  saveSlackConnection,
  setSlackChannel,
} from "@/db/queries/notifications";
import { appUrl } from "@/lib/appUrl";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { testSlackMessage } from "@/lib/notifications/slackMessage";
import {
  exchangeOAuthCode,
  joinChannel,
  listPublicChannels,
  postMessage,
  revokeToken,
  SLACK_BOT_SCOPES,
  SlackApiError,
  type SlackChannel,
} from "@/lib/slack/client";
import { slackRedirectUri, verifySlackOAuthState } from "@/lib/slack/oauth";

// Connecting, configuring and disconnecting a user's Slack workspace. Tokens
// are decrypted only here and in the delivery worker; nothing returned from
// this module contains one.

export type SlackResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

const messages: Partial<Record<string, string>> = {
  missing_scope: "Scout is missing a Slack permission. Connect Slack again and allow every permission.",
  not_connected: "Connect Slack first.",
  channel_not_found: "That channel no longer exists.",
  is_archived: "That channel is archived.",
  method_not_supported_for_channel_type: "Scout can only post to public channels.",
  ratelimited: "Slack is busy. Try again in a minute.",
};

function failure(code: string, fallback: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message: messages[code] ?? fallback };
}

/** OAuth callback: stores the workspace's bot token, encrypted. */
export async function completeSlackInstall(profileId: string, code: string): Promise<SlackResult> {
  try {
    const install = await exchangeOAuthCode(code, slackRedirectUri());
    const missing = SLACK_BOT_SCOPES.filter((scope) => !install.scopes.includes(scope));
    if (missing.length) return failure("missing_scope", "Slack didn't grant every permission.");
    await saveSlackConnection(profileId, {
      teamId: install.teamId,
      teamName: install.teamName,
      botUserId: install.botUserId,
      scopes: install.scopes.join(","),
      encryptedBotToken: encryptToken(install.accessToken),
    });
    return { ok: true, value: undefined };
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "install_failed";
    return failure(code, "Slack connection failed. Try again.");
  }
}

export type SlackCallbackResult =
  | "connected"
  | "invalid_state"
  | "cancelled"
  | "missing_scope"
  | "failed";

/**
 * The OAuth callback's logic: the code is used only when the state matches
 * the cookie this signed-in profile got when it started the flow.
 */
export async function handleSlackOAuthCallback(
  profileId: string,
  callback: { state: string | null; code: string | null; error: string | null; cookie: string | undefined },
): Promise<SlackCallbackResult> {
  if (!verifySlackOAuthState(callback.state, callback.cookie, profileId)) return "invalid_state";
  if (callback.error) return "cancelled";
  if (!callback.code) return "failed";
  const result = await completeSlackInstall(profileId, callback.code);
  if (result.ok) return "connected";
  return result.code === "missing_scope" ? "missing_scope" : "failed";
}

/** Runs a Slack call with the user's token; a dead token flags the connection. */
async function withToken<T>(
  profileId: string,
  run: (token: string) => Promise<T>,
  { postsToChannel = false }: { postsToChannel?: boolean } = {},
): Promise<SlackResult<T>> {
  const connection = await getSlackConnection(profileId);
  if (!connection) return failure("not_connected", "Connect Slack first.");
  try {
    return { ok: true, value: await run(decryptToken(connection.encryptedBotToken)) };
  } catch (error) {
    if (!(error instanceof SlackApiError)) return failure("unknown_error", "Something went wrong. Try again.");
    if (error.kind === "auth") {
      await markSlackConnection(profileId, "needs_reconnect", error.code);
      return failure(error.code, "Scout lost access to Slack. Connect Slack again.");
    }
    // Posting to the saved channel failed: that channel is no longer usable
    if (error.kind === "channel" && postsToChannel) {
      await markSlackConnection(profileId, "channel_unavailable", error.code);
      return failure(error.code, "Scout can't post to that channel anymore. Choose another one.");
    }
    if (error.kind === "rate_limited") return failure("ratelimited", "Slack is busy. Try again in a minute.");
    if (error.kind === "transient") return failure(error.code, "Slack didn't respond. Try again.");
    return failure(error.code, "Slack didn't accept that. Try again.");
  }
}

export function listSlackChannels(profileId: string): Promise<SlackResult<SlackChannel[]>> {
  return withToken(profileId, listPublicChannels);
}

/** Joins the channel first: alerts go only where Scout has proved it can post. */
export async function chooseSlackChannel(
  profileId: string,
  channelId: string,
): Promise<SlackResult<{ id: string; name: string }>> {
  const joined = await withToken(profileId, (token) => joinChannel(token, channelId));
  if (joined.ok) {
    await setSlackChannel(profileId, { channelId: joined.value.id, channelName: joined.value.name });
  }
  return joined;
}

/**
 * "Send test notification": one clearly labeled message to the saved
 * channel, sent right away through the same Slack client and error handling
 * as real alerts. It is not a notification: no delivery row, no daily-limit
 * slot, no scan, no X or OpenAI call. Succeeds only once Slack returns ok.
 */
export async function sendSlackTestMessage(profileId: string): Promise<SlackResult<{ channelName: string }>> {
  const connection = await getSlackConnection(profileId);
  if (!connection) return failure("not_connected", "Connect Slack first.");
  if (connection.status === "needs_reconnect") {
    return failure("needs_reconnect", "Scout lost access to Slack. Connect Slack again.");
  }
  if (!connection.channelId || connection.status !== "active") {
    return failure("no_channel", "Choose a channel first.");
  }
  const channelId = connection.channelId;
  const channelName = connection.channelName ?? channelId;
  return withToken(
    profileId,
    async (token) => {
      await postMessage(token, {
        channel: channelId,
        ...testSlackMessage({ settingsUrl: `${appUrl()}/account/settings` }),
      });
      return { channelName };
    },
    { postsToChannel: true },
  );
}

/**
 * Removes the connection and turns Slack alerts off. The bot token is
 * revoked unless another Scout user still uses the same workspace: Slack
 * gives every installation in a workspace the same bot token.
 */
export async function disconnectSlack(profileId: string): Promise<void> {
  const connection = await deleteSlackConnection(profileId);
  await saveNotificationSettings(profileId, { slackEnabled: false });
  if (!connection) return;
  if ((await countOtherTeamConnections(connection.teamId, profileId)) > 0) return;
  try {
    await revokeToken(decryptToken(connection.encryptedBotToken));
  } catch {
    // Best effort: the connection is gone from Scout either way
  }
}
