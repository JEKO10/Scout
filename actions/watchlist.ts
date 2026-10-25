"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { saveImportedPosts } from "@/db/queries/importedPosts";
import {
  deleteWatchlistAccount,
  getWatchlist,
  setWatchlistAccountActive,
} from "@/db/queries/watchlist";
import { requireProfile } from "@/lib/auth/session";
import { parseTwExtractCsv } from "@/lib/import/twExtractCsv";
import { xHandleSchema } from "@/schemas/onboarding";
import { runScout } from "@/services/scout/runScout";
import {
  addWatchlistAccount,
  WATCHLIST_LIMIT,
} from "@/services/watchlist/addAccount";

export type WatchlistActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  /** Set after a completed Scout run, for the dashboard loop */
  run?: { analyzed: number; opportunities: number };
};

export async function addWatchlistAccountAction(
  _prev: WatchlistActionState,
  formData: FormData,
): Promise<WatchlistActionState> {
  const { profile } = await requireProfile();
  const parsed = xHandleSchema.safeParse(String(formData.get("handle") ?? ""));
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message };
  }

  try {
    const result = await addWatchlistAccount(profile.id, parsed.data);
    switch (result.status) {
      case "limit_reached":
        return {
          status: "error",
          message: `Your watchlist is full (${WATCHLIST_LIMIT} accounts). Remove one first.`,
        };
      case "duplicate":
        return { status: "error", message: `@${result.handle} is already on your watchlist.` };
      case "not_found":
        return { status: "error", message: `@${result.handle} doesn't exist on X.` };
      case "added":
        refresh();
        return {
          status: "success",
          message: result.verified
            ? `Added @${result.account.handle}.`
            : `Added @${result.account.handle}. X is unavailable right now, so Scout will verify it before the first scan.`,
        };
    }
  } catch (error) {
    console.error("Adding watchlist account failed", error);
    return { status: "error", message: "Couldn't add the account. Try again." };
  }
}

const accountIdSchema = z.uuid();

export async function setWatchlistAccountActiveAction(
  accountId: string,
  isActive: boolean,
): Promise<void> {
  const { profile } = await requireProfile();
  await setWatchlistAccountActive(
    profile.id,
    accountIdSchema.parse(accountId),
    isActive,
  );
  refresh();
}

export async function removeWatchlistAccountAction(
  accountId: string,
): Promise<void> {
  const { profile } = await requireProfile();
  await deleteWatchlistAccount(profile.id, accountIdSchema.parse(accountId));
  refresh();
}

export async function runScoutAction(): Promise<WatchlistActionState> {
  const { profile } = await requireProfile();
  const result = await runScout(profile.id);
  refresh();

  switch (result.status) {
    case "no_active_accounts":
      return {
        status: "error",
        message: "Add or resume at least one account before running Scout.",
      };
    case "already_running":
      return {
        status: "error",
        message: "A scan is already running. Wait for it to finish.",
      };
    case "failed":
      return { status: "error", message: `Scan failed: ${result.error}` };
    case "completed": {
      const { candidates, accountsFailed, scoring } = result.stats;
      const surfaced = scoring?.surfaced ?? 0;
      return {
        status: "success",
        message:
          `Scan complete: ${candidates} new ${candidates === 1 ? "candidate" : "candidates"}, ` +
          `${surfaced} worth your time.` +
          (scoring?.skippedReason ? ` ${scoring.skippedReason}` : "") +
          (accountsFailed ? ` ${accountsFailed} account(s) failed; they retry next run.` : ""),
        run: { analyzed: scoring?.scored ?? 0, opportunities: surfaced },
      };
    }
  }
}

// Server Actions accept 1 MB bodies by default; that is hundreds of posts
const MAX_IMPORT_BYTES = 1024 * 1024;

/** Imports a CSV export of X posts as a post source for watched accounts. */
export async function importPostsAction(
  _prev: WatchlistActionState,
  formData: FormData,
): Promise<WatchlistActionState> {
  const { profile } = await requireProfile();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a CSV export to import." };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return { status: "error", message: "That file is too large (max 1 MB)." };
  }

  let posts;
  try {
    posts = parseTwExtractCsv(await file.text());
  } catch (error) {
    return {
      status: "error",
      message: `Couldn't read that CSV. ${error instanceof Error ? error.message : ""}`.trim(),
    };
  }
  if (posts.length === 0) {
    return { status: "error", message: "No posts found in that file." };
  }

  const added = await saveImportedPosts(profile.id, posts);
  const watched = new Set(
    (await getWatchlist(profile.id)).map((account) => account.handle.toLowerCase()),
  );
  const authors = [...new Set(posts.map((post) => post.authorHandle))];
  const watchedAuthors = authors.filter((author) => watched.has(author.toLowerCase()));

  refresh();
  return {
    status: "success",
    message:
      `Imported ${added} new of ${posts.length} posts by ${authors.length} ${authors.length === 1 ? "author" : "authors"}. ` +
      (watchedAuthors.length
        ? `On your watchlist: ${watchedAuthors.map((a) => `@${a}`).join(", ")}.`
        : "None of them are on your watchlist yet; add them to scan their posts."),
  };
}
