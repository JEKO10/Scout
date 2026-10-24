import type { EvalCase } from "@/db/schema";

/**
 * A starter test set written for a books-and-ideas profile (history,
 * political philosophy, literary criticism). Handles are fictional; replace
 * these with real posts from X whenever possible.
 */
export const SAMPLE_EVAL_CASES: Pick<
  EvalCase,
  "authorHandle" | "content" | "category"
>[] = [
  // 3 × very relevant
  {
    authorHandle: "sample_criticdesk",
    category: "very_relevant",
    content:
      "Nobody reads long book reviews anymore. The big review journals survive on prestige and aging subscribers. The essay-review is a dead form and we should stop pretending otherwise.",
  },
  {
    authorHandle: "sample_polytheory",
    category: "very_relevant",
    content:
      "Carl Schmitt is the most overrated political theorist of the last century. Take away the friend/enemy line and there's nothing left but a lawyer's apology for whoever holds power.",
  },
  {
    authorHandle: "sample_culturewar",
    category: "very_relevant",
    content:
      "Every 'forgotten thinker' revived by a small magazine is just a culture-war mascot in period costume. Reading the past honestly is impossible; we only ever read it through today's politics.",
  },
  // 3 × somewhat relevant
  {
    authorHandle: "sample_bookish",
    category: "somewhat_relevant",
    content:
      "Rereading Notes from Underground and it's wild how much of it is just a guy being angry online, in 1864.",
  },
  {
    authorHandle: "sample_archivist",
    category: "somewhat_relevant",
    content:
      "The postwar consensus on European defense was much shakier inside Washington than the textbooks admit. Thread on what the declassified archives actually show 🧵",
  },
  {
    authorHandle: "sample_mediawatch",
    category: "somewhat_relevant",
    content:
      "Why do so many new print magazines launch with a big manifesto and fold within three issues? Genuinely curious how the economics work.",
  },
  // 2 × knows the topic but has little to add
  {
    authorHandle: "sample_readingclub",
    category: "knows_little_to_add",
    content: "What's everyone reading this weekend? Drop your current book below 📚",
  },
  {
    authorHandle: "sample_litnews",
    category: "knows_little_to_add",
    content: "The fiction prize shortlist is out! Who's your pick to win this year?",
  },
  // 2 × irrelevant
  {
    authorHandle: "sample_devtools",
    category: "irrelevant",
    content:
      "Just shipped our AI coding agent: it writes, tests and deploys your PRs while you sleep. Free beta, link in bio 🚀",
  },
  {
    authorHandle: "sample_hoopstalk",
    category: "irrelevant",
    content:
      "That trade makes zero sense. You don't give up two first-round picks for a 33-year-old wing.",
  },
];
