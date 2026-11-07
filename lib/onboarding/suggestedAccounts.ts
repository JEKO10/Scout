// Suggested watchlist: a small, curated list of real X accounts, matched to the
// user's Scout Brain by keywords. The model never suggests handles: it could
// invent ones that don't exist. Handles change; re-check this list now and then.

export type SuggestedAccount = {
  handle: string;
  name: string;
  /** Lowercase keywords the account mostly posts about */
  tags: string[];
};

export const SUGGESTED_ACCOUNTS: SuggestedAccount[] = [
  { handle: "levelsio", name: "Pieter Levels", tags: ["indie", "hacking", "saas", "startups", "ai", "building", "public", "solo", "founders"] },
  { handle: "marclou", name: "Marc Lou", tags: ["indie", "hacking", "saas", "shipping", "solo", "founders", "newsletters", "building", "public"] },
  { handle: "dannypostma", name: "Danny Postma", tags: ["ai", "saas", "indie", "products", "founders"] },
  { handle: "tdinh_me", name: "Tony Dinh", tags: ["indie", "hacking", "ai", "saas", "solo", "founders"] },
  { handle: "theo", name: "Theo", tags: ["developers", "coding", "typescript", "web", "ai", "tools"] },
  { handle: "thekitze", name: "Kitze", tags: ["developers", "coding", "tools", "ai", "vibe", "indie"] },
  { handle: "jessethanley", name: "Jesse Hanley", tags: ["email", "deliverability", "newsletters", "saas", "marketing"] },
  { handle: "nathanbarry", name: "Nathan Barry", tags: ["newsletters", "creators", "email", "audience", "marketing"] },
  { handle: "arvidkahl", name: "Arvid Kahl", tags: ["bootstrapping", "audience", "saas", "founders", "building", "public"] },
  { handle: "robwalling", name: "Rob Walling", tags: ["saas", "bootstrapping", "founders", "startups", "pricing"] },
  { handle: "paulg", name: "Paul Graham", tags: ["startups", "founders", "essays", "fundraising", "writing"] },
  { handle: "naval", name: "Naval", tags: ["startups", "wealth", "philosophy", "founders"] },
  { handle: "karpathy", name: "Andrej Karpathy", tags: ["ai", "llms", "machine", "learning", "coding"] },
  { handle: "swyx", name: "swyx", tags: ["ai", "engineering", "developers", "llms", "tools"] },
  { handle: "rauchg", name: "Guillermo Rauch", tags: ["web", "developers", "nextjs", "ai", "frontend"] },
  { handle: "shadcn", name: "shadcn", tags: ["design", "ui", "react", "developers", "frontend"] },
  { handle: "gregisenberg", name: "Greg Isenberg", tags: ["startups", "ideas", "community", "ai", "products"] },
  { handle: "lennysan", name: "Lenny Rachitsky", tags: ["product", "growth", "startups", "management"] },
  { handle: "shl", name: "Sahil Lavingia", tags: ["creators", "startups", "founders", "indie"] },
  { handle: "dhh", name: "DHH", tags: ["software", "saas", "developers", "rails", "opinions"] },
];

/** How many suggestions are pre-checked; the rest are offered unchecked */
export const PRESELECTED = 5;
const MAX_SUGGESTIONS = 10;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2));
}

/**
 * Accounts sharing the most keywords with the user's Interest and Goal Brain.
 * Skips accounts already watched and any matching topics the user avoids.
 */
export function suggestAccounts(
  interestText: string,
  { exclude, avoidText = "" }: { exclude: Set<string>; avoidText?: string },
): (SuggestedAccount & { score: number })[] {
  const wanted = words(interestText);
  const avoided = words(avoidText);
  const has = (set: Set<string>, tag: string) => set.has(tag) || set.has(tag.replace(/s$/, ""));

  return SUGGESTED_ACCOUNTS.filter((account) => !exclude.has(account.handle.toLowerCase()))
    .map((account) => ({
      ...account,
      score:
        account.tags.filter((tag) => has(wanted, tag)).length -
        account.tags.filter((tag) => has(avoided, tag)).length * 2,
    }))
    .filter((account) => account.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS);
}
