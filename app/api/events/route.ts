import { z } from "zod";

import { CLIENT_EVENTS } from "@/lib/analytics/events";
import { track } from "@/services/analytics/track";

// Public page events from the browser (landing and pricing views, CTA clicks).
// Only known event names are stored; nothing about the visitor is recorded.
const bodySchema = z.object({ name: z.enum(CLIENT_EVENTS) });

export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > 200) return new Response(null, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return new Response(null, { status: 400 });
  await track(parsed.data.name);
  return new Response(null, { status: 204 });
}
