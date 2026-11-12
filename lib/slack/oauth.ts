import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";

import { appUrl } from "@/lib/appUrl";

import { SLACK_BOT_SCOPES } from "./client";

// Slack OAuth v2 state: a random value in the authorize URL and in an
// httpOnly cookie bound to the Scout profile that started the flow. The
// callback accepts a code only when both match and the same user is signed
// in, so nobody can attach their workspace to someone else's account.

export const SLACK_STATE_COOKIE = "scout_slack_oauth";
export const SLACK_STATE_MAX_AGE_SECONDS = 600;

export function slackRedirectUri(): string {
  return `${appUrl()}/api/slack/oauth/callback`;
}

export function isSlackConfigured(): boolean {
  return Boolean(
    process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.TOKEN_ENCRYPTION_KEY,
  );
}

export function createSlackOAuthState(profileId: string): { state: string; cookie: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, cookie: `${state}.${profileId}` };
}

export function slackAuthorizeUrl(state: string): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID ?? "");
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", slackRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

/** True when the callback's state matches the cookie set for this profile. */
export function verifySlackOAuthState(
  state: string | null,
  cookie: string | undefined,
  profileId: string,
): boolean {
  if (!state || !cookie) return false;
  const separator = cookie.indexOf(".");
  if (separator < 0) return false;
  const expected = cookie.slice(0, separator);
  if (cookie.slice(separator + 1) !== profileId) return false;
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
