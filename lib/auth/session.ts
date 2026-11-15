import "server-only";

import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { getOrCreateProfile } from "@/db/queries/profiles";
import { auth } from "@/lib/auth/server";
import { track } from "@/services/analytics/track";

/** Current Neon Auth user, read from the session cookie on the server. */
export const requireUser = cache(async () => {
  // Defer to request time; otherwise Neon Auth logs prerender cookie errors
  await connection();
  const { data: session } = await auth.getSession();
  if (!session) redirect("/auth/sign-in");
  return session.user;
});

/** Current user if signed in, null otherwise: for public pages (pricing). */
export const getOptionalUser = cache(async () => {
  await connection();
  const { data: session } = await auth.getSession();
  return session?.user ?? null;
});

/** Current user plus their Scout profile (created on first access). */
export const requireProfile = cache(async () => {
  const user = await requireUser();
  const profile = await getOrCreateProfile(user.id);
  // A profile created in the last few minutes is a new sign-up (recorded once)
  if (Date.now() - profile.createdAt.getTime() < 10 * 60_000) {
    await track("signup_completed", { profileId: profile.id });
  }
  return { user, profile };
});
