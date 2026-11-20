import { NextResponse } from "next/server";

import { requireProfile } from "@/lib/auth/session";
import {
  createXOAuthStart,
  isXOAuthEnabled,
  X_OAUTH_COOKIE,
  X_OAUTH_COOKIE_PATH,
  X_OAUTH_MAX_AGE_SECONDS,
} from "@/lib/x/oauth";
import { safeReturnPath } from "@/lib/x/publishing";

// "Connect X": sends the signed-in user to X's consent screen with a fresh
// state and PKCE challenge; the verifier stays in an encrypted httpOnly cookie.
// Day 40: "?publish=1" (the "Enable publishing" button, never by default)
// also asks for tweet.write; "&return=" brings the user back to that Scout page.
export async function GET(request: Request) {
  const { profile } = await requireProfile();
  if (!isXOAuthEnabled()) {
    return NextResponse.redirect(new URL("/account/settings?x=not_configured", request.url));
  }
  const params = new URL(request.url).searchParams;
  const publish = params.get("publish") === "1";
  if (publish && process.env.X_PUBLISHING_ENABLED !== "true") {
    return NextResponse.redirect(new URL("/account/settings?x=publishing_off", request.url));
  }

  const { url, cookie } = createXOAuthStart(profile.id, Date.now(), { publish, returnTo: safeReturnPath(params.get("return")) });
  const response = NextResponse.redirect(url);
  response.cookies.set(X_OAUTH_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax: the cookie comes back on X's top-level redirect to the callback
    sameSite: "lax",
    path: X_OAUTH_COOKIE_PATH,
    maxAge: X_OAUTH_MAX_AGE_SECONDS,
  });
  return response;
}
