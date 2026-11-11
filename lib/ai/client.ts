import "server-only";

import OpenAI from "openai";

// Override with env vars without touching code. OPENAI_MODEL is the shared
// fallback; each operation can have its own model.
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.5";

export const AI_MODELS = {
  scoring: process.env.OPENAI_SCORING_MODEL ?? DEFAULT_MODEL,
  reply: process.env.OPENAI_REPLY_MODEL ?? DEFAULT_MODEL,
  brain: process.env.OPENAI_BRAIN_MODEL ?? DEFAULT_MODEL,
  /** Day 6 Brain eval (development only) */
  eval: DEFAULT_MODEL,
};

let client: OpenAI | undefined;

/** The only place that creates an OpenAI client; the key never leaves the server. */
export function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}
