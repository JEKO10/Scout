import "server-only";

// Thin client for the Slack Web API: only the methods Scout uses. Every Slack
// error is classified once here, so callers decide by kind (reconnect, pick
// another channel, retry later) instead of matching error strings.

/** Bot scopes Scout asks for: post, list public channels, join the chosen one */
export const SLACK_BOT_SCOPES = ["chat:write", "channels:read", "channels:join"] as const;

export type SlackErrorKind =
  /** Token revoked, app uninstalled, scope missing: the user must connect again */
  | "auth"
  /** Channel gone, archived, or the bot can't post there */
  | "channel"
  /** HTTP 429; retryAfterSeconds from Retry-After */
  | "rate_limited"
  /** Slack or network trouble: try again later */
  | "transient"
  /** Anything else; retrying won't help */
  | "permanent";

export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    readonly kind: SlackErrorKind,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Slack: ${code}`);
    this.name = "SlackApiError";
  }
}

const AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "app_uninstalled",
  "missing_scope",
  "no_permission",
  "team_access_not_granted",
  "org_login_required",
]);

const CHANNEL_ERRORS = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "restricted_action",
  "method_not_supported_for_channel_type",
]);

const TRANSIENT_ERRORS = new Set([
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  "ratelimited",
]);

function classify(code: string): SlackErrorKind {
  if (AUTH_ERRORS.has(code)) return "auth";
  if (CHANNEL_ERRORS.has(code)) return "channel";
  if (TRANSIENT_ERRORS.has(code)) return "transient";
  return "permanent";
}

type SlackResponse = { ok: boolean; error?: string; [key: string]: unknown };

async function call<T extends SlackResponse>(
  method: string,
  {
    token,
    form,
    json,
  }: { token?: string; form?: Record<string, string>; json?: Record<string, unknown> },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let body: string;
  if (json) {
    headers["content-type"] = "application/json; charset=utf-8";
    body = JSON.stringify(json);
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form ?? {}).toString();
  }

  let response: Response;
  try {
    response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SlackApiError("network_error", "transient");
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new SlackApiError(
      "ratelimited",
      "rate_limited",
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30,
    );
  }
  if (response.status >= 500) throw new SlackApiError(`http_${response.status}`, "transient");

  const data = (await response.json().catch(() => null)) as T | null;
  if (!data) throw new SlackApiError("invalid_response", "transient");
  if (!data.ok) {
    const code = data.error ?? "unknown_error";
    throw new SlackApiError(code, classify(code));
  }
  return data;
}

export type SlackInstallation = {
  accessToken: string;
  scopes: string[];
  botUserId: string | null;
  teamId: string;
  teamName: string;
};

/** OAuth v2: trades the callback code for the workspace's bot token. */
export async function exchangeOAuthCode(code: string, redirectUri: string): Promise<SlackInstallation> {
  const data = await call<
    SlackResponse & {
      access_token?: string;
      token_type?: string;
      scope?: string;
      bot_user_id?: string;
      team?: { id: string; name: string } | null;
    }
  >("oauth.v2.access", {
    form: {
      client_id: process.env.SLACK_CLIENT_ID ?? "",
      client_secret: process.env.SLACK_CLIENT_SECRET ?? "",
      code,
      redirect_uri: redirectUri,
    },
  });
  if (!data.access_token || data.token_type !== "bot" || !data.team) {
    throw new SlackApiError("no_bot_token", "permanent");
  }
  return {
    accessToken: data.access_token,
    scopes: (data.scope ?? "").split(",").filter(Boolean),
    botUserId: data.bot_user_id ?? null,
    teamId: data.team.id,
    teamName: data.team.name,
  };
}

export type SlackChannel = { id: string; name: string; isMember: boolean };

/** Public, unarchived channels (bounded: at most 1000). */
export async function listPublicChannels(token: string): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const data = await call<
      SlackResponse & {
        channels?: { id: string; name: string; is_member?: boolean }[];
        response_metadata?: { next_cursor?: string };
      }
    >("conversations.list", {
      token,
      form: {
        types: "public_channel",
        exclude_archived: "true",
        limit: "200",
        ...(cursor && { cursor }),
      },
    });
    for (const channel of data.channels ?? []) {
      channels.push({ id: channel.id, name: channel.name, isMember: Boolean(channel.is_member) });
    }
    cursor = data.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return channels.sort((a, b) => a.name.localeCompare(b.name));
}

/** Joins a public channel (a no-op when already in it); proves Scout can post there. */
export async function joinChannel(token: string, channelId: string): Promise<{ id: string; name: string }> {
  const data = await call<SlackResponse & { channel?: { id: string; name: string } }>(
    "conversations.join",
    { token, form: { channel: channelId } },
  );
  if (!data.channel) throw new SlackApiError("channel_not_found", "channel");
  return { id: data.channel.id, name: data.channel.name };
}

export async function postMessage(
  token: string,
  message: { channel: string; text: string; blocks: unknown[] },
): Promise<{ ts: string }> {
  const data = await call<SlackResponse & { ts?: string }>("chat.postMessage", {
    token,
    json: { ...message, unfurl_links: false, unfurl_media: false },
  });
  return { ts: data.ts ?? "" };
}

/** Revokes the token (best effort: an already revoked token is fine). */
export async function revokeToken(token: string): Promise<void> {
  try {
    await call("auth.revoke", { token });
  } catch (error) {
    if (error instanceof SlackApiError && error.kind === "auth") return;
    throw error;
  }
}
