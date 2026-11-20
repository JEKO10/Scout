// Day 40.1: removes stored X content after a removal request (from X or the
// account owner; X expects it within 24 hours of the request). Removes the
// text in every user's data and the shared cache; keeps post IDs.
//
// Usage (prints counts only, never content):
//   npx tsx --conditions react-server scripts/ops/remove-x-content.ts --posts 123,456 --confirm
//   npx tsx --conditions react-server scripts/ops/remove-x-content.ts --authors 789 --reason suspended --confirm
// Without --confirm it only says what it would do. Runs against DATABASE_URL.
import "dotenv/config";

import { type RemovalReason,removeXContent } from "../../db/queries/compliance";

const REASONS: RemovalReason[] = ["request", "deleted", "protected", "suspended", "deactivated", "edited"];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ids = (raw: string | undefined) => (raw ?? "").split(",").map((id) => id.trim()).filter((id) => /^\d{1,20}$/.test(id));

async function main() {
  const postIds = ids(arg("posts"));
  const authorIds = ids(arg("authors"));
  const reason = (arg("reason") ?? "request") as RemovalReason;
  if (!REASONS.includes(reason)) throw new Error(`--reason must be one of: ${REASONS.join(", ")}`);
  if (postIds.length === 0 && authorIds.length === 0) throw new Error("Give --posts and/or --authors (numeric X IDs, comma-separated).");
  if (!process.argv.includes("--confirm")) {
    console.log(`Would remove content of ${postIds.length} post(s) and of ${authorIds.length} author(s), reason "${reason}". Add --confirm to do it.`);
    return;
  }
  const counts = await removeXContent({ postIds, authorIds }, reason);
  console.log(`Removed (${reason}):`, counts);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
