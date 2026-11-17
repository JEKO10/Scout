import { NextResponse } from "next/server";

import { requireProfile } from "@/lib/auth/session";
import {
  createXOAuthStart,
  isXOAuthEnabled,
  X_OAUTH_COOKIE,
  X_OAUTH_COOKIE_PATH,
  X_OAUTH_MAX_AGE_SECONDS,
} from "@/lib/x/oauth";

// "Connect X": sends the signed-in user to X's consent screen with a fresh
// state and PKCE challenge; the verifier stays in an encrypted httpOnly cookie.
export async function GET(request: Request) {
  const { profile } = await requireProfile();
  if (!isXOAuthEnabled()) {
    return NextResponse.redirect(new URL("/account/settings?x=not_configured", request.url));
  }

  const { url, cookie } = createXOAuthStart(profile.id);
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
