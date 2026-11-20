import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { appUrl } from "@/lib/appUrl";
import { decryptToken, encryptToken } from "@/lib/crypto/tokens";
import { X_PUBLISH_SCOPES, X_READ_SCOPES } from "@/lib/x/permissions";

// X OAuth 2.0 Authorization Code with PKCE, for connecting the user's own X
// account (Growth Intelligence private metrics). Scout is a confidential
// client: the token endpoint is called with HTTP Basic client credentials.
// Neon Auth stays the only way to sign in to Scout; this only links X.

/**
 * Read-only, the minimum for private metrics on the user's own posts:
 * tweet.read + users.read for GET /2/users/me and /2/users/:id/tweets,
 * offline.access for a refresh token (access tokens last 2 hours).
 */
export const X_OAUTH_SCOPES = X_READ_SCOPES;

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REVOKE_URL = "https://api.x.com/2/oauth2/revoke";
const REQUEST_TIMEOUT_MS = 15_000;

export const X_OAUTH_COOKIE = "scout_x_oauth";
export const X_OAUTH_COOKIE_PATH = "/api/x/oauth";
export const X_OAUTH_MAX_AGE_SECONDS = 600;

/**
 * Off unless X_OAUTH_ENABLED=true and the client credentials and encryption
 * key are set. While off, Scout never touches the X connection tables.
 */
export function isXOAuthEnabled(): boolean {
  return (
    process.env.X_OAUTH_ENABLED === "true" &&
    Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET && process.env.TOKEN_ENCRYPTION_KEY)
  );
}

/** Must match a Callback URI in the X app's settings exactly */
export function xRedirectUri(): string {
  return `${appUrl()}/api/x/oauth/callback`;
}

/** w: the user asked for publishing (tweet.write); r: the Scout page to return to */
type FlowCookie = { s: string; v: string; p: string; t: number; w?: 1; r?: string };

/**
 * A fresh state and PKCE verifier. Both go into an encrypted httpOnly
 * cookie bound to the profile that started the flow; only the S256
 * challenge goes to X.
 */
export function createXOAuthStart(
  profileId: string,
  now = Date.now(),
  /** Day 40: "Enable publishing" asks X for tweet.write too; never by default */
  { publish = false, returnTo = null }: { publish?: boolean; returnTo?: string | null } = {},
): { url: string; cookie: string } {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.X_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", xRedirectUri());
  url.searchParams.set("scope", (publish ? X_PUBLISH_SCOPES : X_OAUTH_SCOPES).join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const flow: FlowCookie = { s: state, v: verifier, p: profileId, t: now, ...(publish ? { w: 1 as const } : {}), ...(returnTo ? { r: returnTo } : {}) };
  return { url: url.toString(), cookie: encryptToken(JSON.stringify(flow)) };
}

/**
 * The PKCE verifier, when the callback's state matches the cookie this same
 * profile got less than 10 minutes ago. Null for anything else.
 */
export function readXOAuthCookie(
  state: string | null,
  cookie: string | undefined,
  profileId: string,
  now = Date.now(),
): { verifier: string; publish: boolean; returnTo: string | null } | null {
  if (!state || !cookie) return null;
  let flow: FlowCookie;
  try {
    flow = JSON.parse(decryptToken(cookie)) as FlowCookie;
  } catch {
    return null;
  }
  if (flow.p !== profileId) return null;
  if (now - flow.t > X_OAUTH_MAX_AGE_SECONDS * 1000 || now < flow.t) return null;
  const a = Buffer.from(state);
  const b = Buffer.from(String(flow.s));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { verifier: flow.v, publish: flow.w === 1, returnTo: typeof flow.r === "string" ? flow.r : null };
}

/** The token endpoint said no. `code` is X's OAuth error, e.g. invalid_grant. */
export class XOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** 0 when X never answered */
    readonly status: number,
  ) {
    super(message);
    this.name = "XOAuthError";
  }

  /** The grant is dead (revoked, expired, already used): only reconnecting helps */
  get needsReconnect(): boolean {
    return this.code === "invalid_grant" || this.code === "invalid_token" || this.status === 401;
  }
}

const tokenResponseSchema = z.object({
  token_type: z.string(),
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(""),
});

export type XTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
};

function basicAuth(): string {
  const id = process.env.X_CLIENT_ID;
  const secret = process.env.X_CLIENT_SECRET;
  if (!id || !secret) throw new Error("X_CLIENT_ID and X_CLIENT_SECRET must be set.");
  return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new XOAuthError(`X unreachable: ${cause instanceof Error ? cause.message : String(cause)}`, "unreachable", 0);
  }
}

async function tokenRequest(body: Record<string, string>, now: number): Promise<XTokenSet> {
  const res = await postForm(TOKEN_URL, body);
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = json as { error?: string; error_description?: string } | null;
    throw new XOAuthError(
      `X token request failed (${res.status}): ${error?.error_description ?? error?.error ?? res.statusText}`,
      error?.error ?? "token_error",
      res.status,
    );
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new XOAuthError("X returned an unexpected token response.", "bad_response", res.status);
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: new Date(now + parsed.data.expires_in * 1000),
    scopes: parsed.data.scope.split(/\s+/).filter(Boolean),
  };
}

/** Callback: the one-time code (valid ~30 s) for tokens */
export function exchangeXCode(code: string, verifier: string, now = Date.now()): Promise<XTokenSet> {
  return tokenRequest(
    { code, grant_type: "authorization_code", redirect_uri: xRedirectUri(), code_verifier: verifier },
    now,
  );
}

/**
 * A new access token. X may rotate the refresh token: the caller stores
 * whatever comes back and treats the old one as spent.
 */
export function refreshXToken(refreshToken: string, now = Date.now()): Promise<XTokenSet> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" }, now);
}

/** Best effort: X invalidates the token; failures are the caller's to ignore */
export async function revokeXToken(token: string, hint: "access_token" | "refresh_token"): Promise<boolean> {
  const res = await postForm(REVOKE_URL, { token, token_type_hint: hint });
  return res.ok;
}
