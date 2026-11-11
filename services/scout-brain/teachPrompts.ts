import type { ResolvedScoutBrain } from "./resolveBrain";

// Questions that pull a real take out of the user, about topics they already
// gave Scout. Code, not AI: free, instant and never off-topic.

const TEMPLATES = [
  (topic: string) => `What do most people get wrong about ${topic}?`,
  (topic: string) => `What's a take on ${topic} you'd defend in an argument?`,
  (topic: string) => `What did you learn the hard way about ${topic}?`,
];

const GENERAL = [
  "What's something in your field most people get wrong?",
  "What advice do you disagree with that everyone keeps repeating?",
  "What changed your mind recently about how you work?",
];

/** Questions to show, skipping ones the user already answered. */
export function teachPrompts(brain: ResolvedScoutBrain, answered: string[]): string[] {
  const topics = brain.interests.topics.slice(0, 4).map((topic) => topic.label);
  const prompts = [
    ...TEMPLATES.flatMap((template) => topics.map(template)),
    ...GENERAL,
  ];
  const done = new Set(answered);
  return prompts.filter((prompt) => !done.has(prompt));
}
