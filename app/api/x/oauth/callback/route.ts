import { type NextRequest, NextResponse } from "next/server";

import { requireProfile } from "@/lib/auth/session";
import { X_OAUTH_COOKIE, X_OAUTH_COOKIE_PATH } from "@/lib/x/oauth";
import { safeReturnPath } from "@/lib/x/publishing";
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

  // Back where "Enable publishing" was clicked (a checked Scout path), else Settings
  const target = new URL(safeReturnPath(result.returnTo) ?? "/account/settings", request.url);
  target.searchParams.set("x", result.status);
  // The verified handle of the account they authorized: shown so they can choose
  if (result.authorizedHandle) target.searchParams.set("authorized", result.authorizedHandle);
  const response = NextResponse.redirect(target);
  // One use per state
  response.cookies.set(X_OAUTH_COOKIE, "", { path: X_OAUTH_COOKIE_PATH, maxAge: 0 });
  return response;
}
