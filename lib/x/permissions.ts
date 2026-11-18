// Day 37: what Scout may do with a connected X account, enforced on the
// server. Today: read only. Publishing is a future capability with its own
// scope, its own explicit consent and its own switch; nothing in Scout can
// post, reply, like, follow or message on X now.
//
// Future publishing (not built), so it can be added without surprises:
// - Scope: tweet.write (plus tweet.read, users.read, offline.access). X
//   grants scopes per authorization, so existing connections must reconnect
//   and see the new permission on X's consent screen; never added silently.
// - Endpoint: POST /2/tweets (posts and replies via reply.in_reply_to_tweet_id).
//   Cost and limits must be checked on X's pricing page before enabling;
//   writes are billed separately from reads.
// - Consent: every post is approved by the user (Content Studio "Publish",
//   Calendar "Schedule" with an explicit confirmation); automations may
//   only prepare drafts unless a future, separately approved workflow says otherwise.
// - Checks before any write: the connection belongs to the signed-in profile,
//   is active, holds tweet.write, the X account is the one the user chose,
//   and X_PUBLISHING_ENABLED=true (off everywhere).

/** Requested today: identity and analytics only */
export const X_READ_SCOPES = ["tweet.read", "users.read", "offline.access"] as const;

/** What a future publishing release would request (by reconnecting) */
export const X_PUBLISH_SCOPES = ["tweet.read", "users.read", "tweet.write", "offline.access"] as const;

export type XCapability = "identity" | "analytics" | "publish";

const NEEDS: Record<XCapability, string[]> = {
  identity: ["users.read", "tweet.read"],
  analytics: ["tweet.read", "users.read"],
  publish: ["tweet.write"],
};

export const SCOPE_LABEL: Record<string, string> = {
  "tweet.read": "Read your posts and their metrics",
  "users.read": "Read your profile",
  "offline.access": "Stay connected without signing in again",
  "tweet.write": "Post on your behalf",
};

export function grantedScopes(scopes: string): string[] {
  return scopes.split(/\s+/).filter(Boolean);
}

/**
 * Whether a connection may be used for something. Publishing additionally
 * needs the (off) publishing switch: holding the scope isn't enough.
 */
export function canUse(connection: { status: string; scopes: string }, capability: XCapability): boolean {
  if (connection.status !== "active") return false;
  const granted = new Set(grantedScopes(connection.scopes));
  if (!NEEDS[capability].every((scope) => granted.has(scope))) return false;
  if (capability === "publish") return process.env.X_PUBLISHING_ENABLED === "true";
  return true;
}
