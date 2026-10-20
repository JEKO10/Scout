import "server-only";

import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { getOrCreateProfile } from "@/db/queries/profiles";
import { auth } from "@/lib/auth/server";

/** Current Neon Auth user, read from the session cookie on the server. */
export const requireUser = cache(async () => {
  // Defer to request time; otherwise Neon Auth logs prerender cookie errors
  await connection();
  const { data: session } = await auth.getSession();
  if (!session) redirect("/auth/sign-in");
  return session.user;
});

/** Current user plus their Scout profile (created on first access). */
export const requireProfile = cache(async () => {
  const user = await requireUser();
  const profile = await getOrCreateProfile(user.id);
  return { user, profile };
});
