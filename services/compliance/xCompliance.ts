import "server-only";

import {
  expireThirdPartyContent,
  insertComplianceJob,
  latestComplianceJob,
  type RemovalCounts,
  type RemovalReason,
  removeXContent,
  storedXIds,
  updateComplianceJob,
} from "@/db/queries/compliance";
import { reserveXRequest } from "@/db/queries/xApiUsage";
import { RETENTION_BATCH, THIRD_PARTY_RETENTION_DAYS } from "@/lib/compliance/retention";
import { getScoutLimits } from "@/lib/scout/testLimits";

// Day 40.1 X content compliance. X's Developer Policy: stored X content must
// be kept up to date with X, and content deleted, made private, suspended or
// withheld on X must be deleted or modified. Scout does three things:
// 1. Retention (always on, no API cost): third-party text is kept only for a
//    limited time (lib/compliance/retention.ts), so stale copies don't pile up.
// 2. Removal requests (always available): removeXContent by post or author ID,
//    for a request from X or an account owner (scripts/ops/remove-x-content.ts).
// 3. X Batch Compliance jobs (off unless X_COMPLIANCE_JOBS_ENABLED): once a day
//    Scout uploads the IDs it stores, X answers which changed, Scout removes
//    them. X doesn't document the price or availability of these jobs on
//    self-serve plans, so they stay off until that is confirmed.
// Scout does NOT detect every deletion on X on its own: between jobs (or with
// jobs off), a post deleted on X stays in Scout until retention removes it.

export function complianceJobsEnabled(): boolean {
  return process.env.X_COMPLIANCE_JOBS_ENABLED === "true";
}

const X_API = "https://api.x.com/2";
/** One job per type per day */
const JOB_EVERY_MS = 24 * 3_600_000;
/** IDs per job (X accepts ~5 million per file; Scout stores far fewer) */
const MAX_IDS = 200_000;

/** Retention pass of the cleanup step: bounded, no API calls */
export async function applyRetention(now = new Date()): Promise<RemovalCounts> {
  return expireThirdPartyContent(THIRD_PARTY_RETENTION_DAYS, now, RETENTION_BATCH);
}

type JobResponse = { data?: { id: string; status: string; upload_url?: string; download_url?: string } };

async function xRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN is not set.");
  if (!(await reserveXRequest(getScoutLimits().maxXRequestsPerDay, { retry: false }))) throw new Error("Daily X request limit reached.");
  return fetch(`${X_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
}

/** One compliance event from X's results file */
type ComplianceEvent = { id: string; action?: string; reason?: string; error?: string };

export function parseComplianceResults(ndjson: string): ComplianceEvent[] {
  return ndjson
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as ComplianceEvent;
        return typeof event.id === "string" || typeof event.id === "number" ? [{ ...event, id: String(event.id) }] : [];
      } catch {
        return [];
      }
    });
}

const REASONS: RemovalReason[] = ["deleted", "protected", "suspended", "deactivated"];

/** Applies X's answer: deletions remove content; an edit removes the stale copy too (Scout can't refresh it for free) */
export async function applyComplianceEvents(type: "tweets" | "users", events: ComplianceEvent[], now = new Date()): Promise<Record<string, number>> {
  const results: Record<string, number> = { events: events.length, invalid: 0, ignored: 0, removedRows: 0 };
  const groups = new Map<RemovalReason, string[]>();
  for (const event of events) {
    if (event.error) {
      results.invalid++;
      continue;
    }
    let reason: RemovalReason | null = null;
    if (event.action === "delete") reason = REASONS.includes(event.reason as RemovalReason) ? (event.reason as RemovalReason) : "deleted";
    else if (event.action === "rehydrate") reason = "edited";
    // scrub_geo: Scout stores no location data
    if (!reason) {
      results.ignored++;
      continue;
    }
    groups.set(reason, [...(groups.get(reason) ?? []), event.id]);
    results[reason] = (results[reason] ?? 0) + 1;
  }
  for (const [reason, ids] of groups) {
    const counts = await removeXContent(type === "tweets" ? { postIds: ids } : { authorIds: ids }, reason, now);
    results.removedRows += counts.cache + counts.candidates + counts.opportunities + counts.leads + counts.imported;
  }
  return results;
}

/**
 * Scheduler step (off unless enabled): for each type, finish the open job
 * (download and apply) or start the day's job (upload stored IDs). Every
 * failure is recorded on the job; nothing is retried in a loop.
 */
export async function runComplianceJobs(now = new Date()) {
  if (!complianceJobsEnabled()) return { disabled: true as const };
  const summary: Record<string, string> = {};
  for (const type of ["tweets", "users"] as const) {
    const job = await latestComplianceJob(type);
    try {
      if (job?.status === "uploaded" && job.xJobId) {
        const res = await xRequest(`/compliance/jobs/${encodeURIComponent(job.xJobId)}`);
        if (!res.ok) throw new Error(`X answered ${res.status} to the job status`);
        const body = (await res.json()) as JobResponse;
        const status = body.data?.status;
        if (status === "complete") {
          const download = await fetch(body.data?.download_url ?? job.downloadUrl ?? "", { signal: AbortSignal.timeout(60_000) });
          if (!download.ok) throw new Error(`Results download failed (${download.status})`);
          const results = await applyComplianceEvents(type, parseComplianceResults(await download.text()), now);
          await updateComplianceJob(job.id, { status: "applied", results, completedAt: now, downloadUrl: null });
          summary[type] = "applied";
        } else if (status === "failed" || status === "expired") {
          await updateComplianceJob(job.id, { status: "failed", error: `X job ${status}`, downloadUrl: null });
          summary[type] = "failed";
        } else summary[type] = "waiting";
        continue;
      }
      if (job && job.status !== "applied" && job.status !== "failed") {
        // Created but never uploaded (a crash between the two): start over tomorrow
        await updateComplianceJob(job.id, { status: "failed", error: "Upload didn't finish." });
      }
      if (job && now.getTime() - job.createdAt.getTime() < JOB_EVERY_MS) {
        summary[type] = "not due";
        continue;
      }
      const ids = await storedXIds(type, MAX_IDS);
      if (ids.length === 0) {
        summary[type] = "nothing stored";
        continue;
      }
      const res = await xRequest("/compliance/jobs", { method: "POST", body: JSON.stringify({ type, name: `scout-${type}-${now.toISOString().slice(0, 10)}` }) });
      if (!res.ok) throw new Error(`X answered ${res.status} when creating the job`);
      const body = (await res.json()) as JobResponse;
      if (!body.data?.id || !body.data.upload_url) throw new Error("X returned no job or upload URL.");
      const created = await insertComplianceJob({ type, xJobId: body.data.id, status: "created", idCount: ids.length, downloadUrl: body.data.download_url ?? null });
      const upload = await fetch(body.data.upload_url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: ids.join("\n"), signal: AbortSignal.timeout(60_000) });
      if (!upload.ok) {
        await updateComplianceJob(created.id, { status: "failed", error: `Upload failed (${upload.status})` });
        summary[type] = "failed";
        continue;
      }
      await updateComplianceJob(created.id, { status: "uploaded" });
      summary[type] = "uploaded";
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : "error";
      if (job && job.status === "uploaded") await updateComplianceJob(job.id, { error: message });
      console.error(`X compliance job (${type}) failed: ${message}`);
      summary[type] = "error";
    }
  }
  return summary;
}
