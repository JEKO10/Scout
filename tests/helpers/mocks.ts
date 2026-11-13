// Mocked X API, OpenAI and Slack, installed on global fetch. Everything else
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
  /** Accounts the user lookup finds, by lowercase handle → X user ID */
  users: new Map<string, string>(),
};

export const ai = {
  /** Format name of every OpenAI call */
  calls: [] as string[],
  /** Request body of every OpenAI call */
  requests: [] as Record<string, unknown>[],
  /**
   * Queued outcomes for the next scoring calls: "error" (HTTP 400, not retried),
   * "malformed" (output that isn't the schema), "drop" (one judgment missing).
   */
  failures: [] as ("error" | "malformed" | "drop")[],
  /** Score every candidate this high (all factors maxed = 100 minus freshness) */
  shouldEngage: true,
};

let seq = BigInt("1900000000000000000");

export function nextId(): string {
  seq += BigInt(10);
  return seq.toString();
}

/**
 * Adds posts to a mocked timeline, newest last. `quoting`: they quote that
 * post; `replyTo`: they're replies. The mock ignores `exclude`, so replies
 * reach Scout and its own filters must catch them.
 */
export function addTweets(
  userId: string,
  count: number,
  { quoting, replyTo }: { quoting?: string; replyTo?: string } = {},
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
      ...(replyTo && { referenced_tweets: [{ type: "replied_to" as const, id: replyTo }] }),
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

function aiResponse(payload: unknown, model = "gpt-5.5-2026-04-23") {
  return new Response(
    JSON.stringify({
      id: "resp_test",
      object: "response",
      created_at: 0,
      status: "completed",
      model,
      output: [
        {
          type: "message",
          id: "msg_test",
          status: "completed",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: typeof payload === "string" ? payload : JSON.stringify(payload),
              annotations: [],
            },
          ],
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

type SlackReply = { status?: number; body?: Record<string, unknown>; retryAfter?: number };

export const slack = {
  /** Every Slack call: method, parsed body and the bearer token used */
  calls: [] as { method: string; body: Record<string, unknown>; token: string | null }[],
  /** Per method: queued replies for the next calls, e.g. a 429 or { ok: false } */
  replies: new Map<string, SlackReply[]>(),
  channels: [
    { id: "C0ALERTS01", name: "scout-alerts" },
    { id: "C0GENERAL1", name: "general" },
  ],
  messages: (channel?: string) =>
    slack.calls.filter(
      (call) => call.method === "chat.postMessage" && (!channel || call.body.channel === channel),
    ),
};

let slackTs = 1;

/**
 * OAuth codes look like "team:T123": the workspace the user installs into.
 * Each workspace gets its own bot token, "xoxb-T123".
 */
function slackDefault(method: string, body: Record<string, unknown>): Record<string, unknown> {
  switch (method) {
    case "oauth.v2.access": {
      const team = String(body.code ?? "").match(/^team:(\w+)$/)?.[1];
      if (!team) return { ok: false, error: "invalid_code" };
      return {
        ok: true,
        access_token: `xoxb-${team}`,
        token_type: "bot",
        scope: "chat:write,channels:read,channels:join",
        bot_user_id: `U${team}`,
        team: { id: team, name: `Workspace ${team}` },
      };
    }
    case "conversations.list":
      return { ok: true, channels: slack.channels.map((c) => ({ ...c, is_member: false })) };
    case "conversations.join": {
      const channel = slack.channels.find((c) => c.id === body.channel);
      return channel ? { ok: true, channel } : { ok: false, error: "channel_not_found" };
    }
    case "chat.postMessage":
      return { ok: true, channel: body.channel, ts: `1700000000.${String(slackTs++).padStart(6, "0")}` };
    case "auth.revoke":
      return { ok: true, revoked: true };
    default:
      return { ok: false, error: "unknown_method" };
  }
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
      ai.requests.push(body);
      if (format === "candidate_judgments") {
        // The model echoes what was asked for, so pricing follows the request
        const model = String(body.model).startsWith("gpt-5.5") ? "gpt-5.5-2026-04-23" : String(body.model);
        const failure = ai.failures.shift();
        if (failure === "error") return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 });
        if (failure === "malformed") return aiResponse("not json at all", model);
        // Pretty (prompt v1) and compact (v2) JSON both carry the ids
        let ids = [...String(body.input).matchAll(/"candidateId":\s*"([^"]+)"/g)].map((m) => m[1]);
        if (failure === "drop") ids = ids.slice(1);
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
        }, model);
      }
      if (format === "reply_drafts") return aiResponse({ first: "First draft", second: "Second draft" });
      return new Response("{}", { status: 400 });
    }

    if (url.hostname === "slack.com") {
      const method = url.pathname.replace("/api/", "");
      const raw = String(init?.body ?? "");
      const headers = new Headers(init?.headers);
      const body: Record<string, unknown> = headers.get("content-type")?.includes("json")
        ? JSON.parse(raw || "{}")
        : Object.fromEntries(new URLSearchParams(raw));
      const token = headers.get("authorization")?.replace("Bearer ", "") ?? null;
      slack.calls.push({ method, body, token });
      const reply = slack.replies.get(method)?.shift();
      if (reply?.status && reply.status !== 200) {
        return new Response("", {
          status: reply.status,
          headers: reply.retryAfter ? { "retry-after": String(reply.retryAfter) } : {},
        });
      }
      return Response.json(reply?.body ?? slackDefault(method, body));
    }

    if (url.hostname !== "api.x.com") return realFetch(input, init);

    x.calls.push(url.pathname);
    if (x.delayMs) await new Promise((resolve) => setTimeout(resolve, x.delayMs));
    const lookup = url.pathname.match(/^\/2\/users\/by\/username\/([^/]+)$/);
    if (lookup) {
      const handle = decodeURIComponent(lookup[1]);
      const id = x.users.get(handle.toLowerCase());
      // X answers 200 with errors and no data for unknown accounts
      return Response.json(
        id
          ? { data: { id, username: handle, name: `Name ${handle}`, profile_image_url: "https://pbs.twimg.com/a.jpg" } }
          : { errors: [{ title: "Not Found Error" }] },
      );
    }
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
