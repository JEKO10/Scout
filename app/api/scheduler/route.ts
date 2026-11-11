import { isAuthorizedSchedulerRequest } from "@/lib/scheduler/auth";
import { runSchedulerTick } from "@/services/scheduler/tick";

// Automatic Scout tick. Called by a planner (Vercel Cron or another
// scheduler) with the CRON_SECRET; one bounded batch of work per call.

/** Vercel function limit; the tick stops claiming jobs well before it */
export const maxDuration = 300;

async function tick(request: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "Scheduler disabled: CRON_SECRET is not set." }, { status: 503 });
  }
  if (!isAuthorizedSchedulerRequest(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runSchedulerTick();
  return Response.json(result);
}

export const GET = tick;
export const POST = tick;
