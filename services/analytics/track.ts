import "server-only";

import { insertAnalyticsEvent } from "@/db/queries/analytics";
import { type AnalyticsEvent, ONCE_EVENTS } from "@/lib/analytics/events";

type Props = Record<string, string | number | boolean>;

/**
 * Records a product event. Best effort: analytics never breaks the action it
 * describes. Callers pass only non-sensitive properties (a plan, a step),
 * never text the user wrote or anything about their Scout Brain.
 */
export async function track(name: AnalyticsEvent, { profileId = null, props }: { profileId?: string | null; props?: Props } = {}) {
  try {
    await insertAnalyticsEvent({
      name,
      profileId,
      once: Boolean(profileId) && ONCE_EVENTS.has(name),
      props: props ?? null,
    });
  } catch (error) {
    console.error(`analytics: couldn't record ${name}`, error instanceof Error ? error.message : error);
  }
}
