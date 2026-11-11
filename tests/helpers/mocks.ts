// Mocked X API and OpenAI, installed on global fetch. Everything else
// (the Neon database) goes to the real fetch.

type Tweet = {
  id: string;
  text: string;
  created_at: string;
  referenced_tweets?: { type: "quoted" | "replied_to" | "retweeted"; id: string }[];
};

export const x = {
  timelines: new Map<string, Tweet[]>(),
  /** Quoted posts X can expand, by ID */
  quoted: new Map<string, Tweet>(),
  /** Paths of every X request */
  calls: [] as string[],
  /** Per user ID: queued failures for the next requests, e.g. ["500", "500"] */
  failures: new Map<string, string[]>(),
  /** Milliseconds each X request takes, to overlap concurrent workers */
  delayMs: 0,
};

export const ai = {
  /** Format name of every OpenAI call */
  calls: [] as string[],
  /** Score every candidate this high (all factors maxed = 100 minus freshness) */
  shouldEngage: true,
};

let seq = BigInt("1900000000000000000");

export function nextId(): string {
  seq += BigInt(10);
  return seq.toString();
}

export function addTweets(
  userId: string,
  count: number,
  { quoting }: { quoting?: string } = {},
): string[] {
  const list = x.timelines.get(userId) ?? [];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = nextId();
    ids.push(id);
    list.push({
      id,
      text: `Post ${id} about AI products and startup marketing`,
      created_at: new Date(Date.now() - 3600_000).toISOString(),
      ...(quoting && { referenced_tweets: [{ type: "quoted" as const, id: quoting }] }),
    });
  }
  x.timelines.set(userId, list);
  return ids;
}

export function addQuotedPost(text: string): string {
  const id = nextId();
  x.quoted.set(id, { id, text, created_at: new Date(Date.now() - 7200_000).toISOString() });
  return id;
}

function aiResponse(payload: unknown) {
  return new Response(
    JSON.stringify({
      id: "resp_test",
      object: "response",
      created_at: 0,
      status: "completed",
      model: "gpt-5.5-2026-04-23",
      output: [
        {
          type: "message",
          id: "msg_test",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(payload), annotations: [] }],
        },
      ],
      // 1000 in + 100 out = $0.008 per call at gpt-5.5 list prices
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 1100,
      },
      parallel_tool_calls: false,
      tools: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const realFetch = globalThis.fetch;

export function installMocks() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );

    if (url.hostname === "api.openai.com") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const format = body.text?.format?.name;
      ai.calls.push(format);
      if (format === "candidate_judgments") {
        const ids = [...String(body.input).matchAll(/"candidateId": "([^"]+)"/g)].map((m) => m[1]);
        return aiResponse({
          judgments: ids.map((candidateId) => ({
            candidateId,
            relevance: 25,
            goalAlignment: 20,
            expertiseFit: 20,
            audienceValue: 10,
            novelty: 10,
            shouldEngage: ai.shouldEngage,
            reason: "You've written about this.",
            topic: "AI products",
            suggestedAngle: "Your angle.",
          })),
        });
      }
      if (format === "reply_drafts") return aiResponse({ first: "First draft", second: "Second draft" });
      return new Response("{}", { status: 400 });
    }

    if (url.hostname !== "api.x.com") return realFetch(input, init);

    x.calls.push(url.pathname);
    if (x.delayMs) await new Promise((resolve) => setTimeout(resolve, x.delayMs));
    const match = url.pathname.match(/^\/2\/users\/([^/]+)\/tweets$/);
    if (!match) return new Response(JSON.stringify({ title: "unexpected" }), { status: 404 });
    const userId = match[1];
    const failure = x.failures.get(userId)?.shift();
    if (failure) return new Response(JSON.stringify({ title: "failure" }), { status: Number(failure) });

    const p = url.searchParams;
    const since = p.get("since_id");
    const until = p.get("until_id");
    const start = p.get("start_time");
    const max = Number(p.get("max_results"));
    const all = [...(x.timelines.get(userId) ?? [])]
      .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
      .filter((t) => !since || BigInt(t.id) > BigInt(since))
      .filter((t) => !until || BigInt(t.id) < BigInt(until))
      .filter((t) => !start || t.created_at >= start);
    const page = all.slice(0, max);
    const expand = p.get("expansions") === "referenced_tweets.id";
    const includes = expand
      ? page
          .flatMap((t) => t.referenced_tweets ?? [])
          .map((ref) => x.quoted.get(ref.id))
          .filter((t): t is Tweet => Boolean(t))
      : [];
    return new Response(
      JSON.stringify({
        data: page.length ? page : undefined,
        ...(includes.length && { includes: { tweets: includes } }),
        meta: { result_count: page.length, ...(all.length > max && { next_token: "more" }) },
      }),
    );
  }) as typeof fetch;
}
