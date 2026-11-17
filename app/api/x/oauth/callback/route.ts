import { type NextRequest, NextResponse } from "next/server";

import { requireProfile } from "@/lib/auth/session";
import { X_OAUTH_COOKIE, X_OAUTH_COOKIE_PATH } from "@/lib/x/oauth";
import { handleXOAuthCallback } from "@/services/x/oauthConnection";

// X sends the user back here after "Authorize app" (or "Cancel"). The code
// is exchanged only when the state matches the cookie of the user signed in now.
export async function GET(request: NextRequest) {
  const { profile } = await requireProfile();
  const params = request.nextUrl.searchParams;

  const result = await handleXOAuthCallback(profile, {
    state: params.get("state"),
    code: params.get("code"),
    error: params.get("error"),
    cookie: request.cookies.get(X_OAUTH_COOKIE)?.value,
  });

  const response = NextResponse.redirect(new URL(`/account/settings?x=${result}`, request.url));
  // One use per state
  response.cookies.set(X_OAUTH_COOKIE, "", { path: X_OAUTH_COOKIE_PATH, maxAge: 0 });
  return response;
}
