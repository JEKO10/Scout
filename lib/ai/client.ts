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

/**
 * Day 40.1: every Responses API call goes out with `store: false`, so OpenAI
 * doesn't keep the response for later retrieval (the API's default is to
 * store it). Scout never uses stored responses (no previous_response_id, no
 * files, vector stores or conversations), so nothing depends on storage.
 * Applied here, once, so no call site can forget it. This does not change
 * OpenAI's own abuse-monitoring retention or account-level data settings.
 */
export const OPENAI_STORE = false;

function withoutStorage(openai: OpenAI): OpenAI {
  const parse = openai.responses.parse.bind(openai.responses);
  const create = openai.responses.create.bind(openai.responses);
  openai.responses.parse = ((body: Parameters<typeof parse>[0], options?: Parameters<typeof parse>[1]) =>
    parse({ ...body, store: OPENAI_STORE }, options)) as typeof openai.responses.parse;
  openai.responses.create = ((body: Parameters<typeof create>[0], options?: Parameters<typeof create>[1]) =>
    create({ ...body, store: OPENAI_STORE } as Parameters<typeof create>[0], options)) as typeof openai.responses.create;
  return openai;
}

/** The only place that creates an OpenAI client; the key never leaves the server. */
export function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  client ??= withoutStorage(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
  return client;
}
