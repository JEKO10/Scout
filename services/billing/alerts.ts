import "server-only";

import { getInternalSlackTargets } from "@/db/queries/billing";
import { decryptToken } from "@/lib/crypto/tokens";
import { postMessage } from "@/lib/slack/client";

export type BillingAlertKind =
  | "unmatched"
  | "duplicate_canceled"
  | "refund_canceled"
  | "adjustment"
  | "internal_purchase"
  | "binding_mismatch";

/**
 * Something about money needs a human: logged with a stable prefix (Vercel
 * logs), stored on the webhook event (the outcome, shown on /dev/runs) and
 * posted to the Slack channels of internal accounts. Best effort: an alert
 * that can't be delivered never fails the webhook. No secrets in the text.
 */
export async function billingAlert(kind: BillingAlertKind, detail: string): Promise<void> {
  console.error(`[billing-alert] ${kind}: ${detail}`);
  try {
    const targets = await getInternalSlackTargets();
    await Promise.all(
      targets.map((target) =>
        postMessage(decryptToken(target.encryptedBotToken), {
          channel: target.channelId,
          text: `Billing alert (${kind}): ${detail}`,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `*Billing alert · ${kind}*\n${detail}` } }],
        }),
      ),
    );
  } catch (error) {
    console.error("[billing-alert] Slack delivery failed", error instanceof Error ? error.message : error);
  }
}
