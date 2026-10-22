import "server-only";

import OpenAI from "openai";

// Override with OPENAI_MODEL without touching code
export const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-5.5";

let client: OpenAI | undefined;

/** The only place that creates an OpenAI client; the key never leaves the server. */
export function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}
