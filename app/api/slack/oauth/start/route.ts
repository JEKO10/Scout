import { NextResponse } from "next/server";

import { requireProfile } from "@/lib/auth/session";
import {
  createSlackOAuthState,
  isSlackConfigured,
  SLACK_STATE_COOKIE,
  SLACK_STATE_MAX_AGE_SECONDS,
  slackAuthorizeUrl,
} from "@/lib/slack/oauth";

// "Connect Slack": sends the signed-in user to Slack's install screen with a
// fresh state, kept in an httpOnly cookie for the callback to check.
export async function GET(request: Request) {
  const { profile } = await requireProfile();
  if (!isSlackConfigured()) {
    return NextResponse.redirect(new URL("/account/settings?slack=not_configured", request.url));
  }

  const { state, cookie } = createSlackOAuthState(profile.id);
  const response = NextResponse.redirect(slackAuthorizeUrl(state));
  response.cookies.set(SLACK_STATE_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax: the cookie comes back on Slack's top-level redirect to the callback
    sameSite: "lax",
    path: "/api/slack/oauth",
    maxAge: SLACK_STATE_MAX_AGE_SECONDS,
  });
  return response;
}
