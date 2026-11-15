import { paddleEventSchema, verifyPaddleSignature } from "@/lib/paddle/webhook";
import { handlePaddleEvent } from "@/services/billing/paddleWebhook";

// Paddle notification destination. Plans change only here, after the
// signature is verified; never from the browser's checkout events.
// Non-2xx responses make Paddle retry, so only real failures return them.
export async function POST(request: Request) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret || !secret.startsWith("pdl_ntfset_")) {
    console.error("Paddle webhook: PADDLE_WEBHOOK_SECRET is missing or invalid");
    return Response.json({ error: "Webhook not configured" }, { status: 503 });
  }

  // The raw body, exactly as signed: parsing first would break the signature
  const rawBody = await request.text();
  if (!verifyPaddleSignature(rawBody, request.headers.get("paddle-signature"), secret)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const event = paddleEventSchema.safeParse(json);
  if (!event.success) return Response.json({ error: "Unexpected payload" }, { status: 400 });

  try {
    const outcome = await handlePaddleEvent(event.data);
    if (outcome === "unmatched") {
      console.warn(`Paddle webhook ${event.data.event_id} (${event.data.event_type}): no Scout user in custom_data`);
    }
    return Response.json({ outcome });
  } catch (error) {
    console.error(`Paddle webhook ${event.data.event_id} failed`, error);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}
