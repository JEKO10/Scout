import { type NextRequest, NextResponse } from "next/server";

import { requireProfile } from "@/lib/auth/session";
import { SLACK_STATE_COOKIE } from "@/lib/slack/oauth";
import { handleSlackOAuthCallback } from "@/services/notifications/slackConnection";

// Slack sends the user back here after "Allow" (or "Cancel"). The code is
// exchanged only when the state matches the cookie of the user signed in now.
export async function GET(request: NextRequest) {
  const { profile } = await requireProfile();
  const params = request.nextUrl.searchParams;

  const result = await handleSlackOAuthCallback(profile.id, {
    state: params.get("state"),
    code: params.get("code"),
    error: params.get("error"),
    cookie: request.cookies.get(SLACK_STATE_COOKIE)?.value,
  });

  const response = NextResponse.redirect(new URL(`/account/settings?slack=${result}`, request.url));
  // One use per state
  response.cookies.set(SLACK_STATE_COOKIE, "", { path: "/api/slack/oauth", maxAge: 0 });
  return response;
}
