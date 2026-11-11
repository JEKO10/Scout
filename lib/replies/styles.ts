// Reply styles the user picks two of before generating. One AI call writes
// both, so the choice costs nothing extra. Shared by server and client.

export const REPLY_STYLES = [
  "natural",
  "stronger_take",
  "funny",
  "question",
  "practical_tip",
  "one_liner",
] as const;

export type ReplyStyle = (typeof REPLY_STYLES)[number];

export const DEFAULT_REPLY_STYLES: [ReplyStyle, ReplyStyle] = ["natural", "stronger_take"];

export const REPLY_STYLE_INFO: Record<
  ReplyStyle,
  { label: string; hint: string; prompt: string }
> = {
  natural: {
    label: "Natural",
    hint: "What you'd write first",
    prompt: "what they would most likely write on first instinct.",
  },
  stronger_take: {
    label: "Stronger take",
    hint: "Clearer stance, sharper point",
    prompt:
      "the same person, firmer: a clearer stance or sharper argument. Bolder, never ruder, and still true to their opinions.",
  },
  funny: {
    label: "Funny",
    hint: "A light joke that still makes a point",
    prompt:
      "witty in their own sense of humor: a light joke, irony or a playful twist that still makes a real point. Never mocking the author, no forced puns, no meme clichés.",
  },
  question: {
    label: "Question",
    hint: "Asks the author something worth answering",
    prompt:
      "one thoughtful, specific question to the author that they'd want to answer, optionally after a short point of their own. Not a generic \"what do you think?\".",
  },
  practical_tip: {
    label: "Practical tip",
    hint: "Agrees and adds one concrete step",
    prompt:
      "adds one concrete, actionable tip or step that builds on the post, from what they know. Specific enough to try today.",
  },
  one_liner: {
    label: "One-liner",
    hint: "One short, punchy sentence",
    prompt: "a single short, punchy sentence, under 100 characters, that still adds something.",
  },
};

export function isReplyStyle(value: string): value is ReplyStyle {
  return (REPLY_STYLES as readonly string[]).includes(value);
}
