// Day 36: deterministic rule evaluation and validation for Automation Scout.
// No AI decides whether an automation fires; only these checks do.

import { z } from "zod";

import {
  ACTIONS_FOR,
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  type AutomationAction,
  type AutomationConditions,
  type AutomationTrigger,
  CONDITIONS_FOR,
} from "./types";

/** One event, normalized from the module that stored it */
export type AutomationEvent = {
  trigger: AutomationTrigger;
  /** Stable across ticks: the same event always gets the same key */
  key: string;
  entityId: string;
  /** When it happened (stored, due) */
  at: Date;
  title: string;
  body: string | null;
  href: string;
  sourceModule: string;
  entityType: "opportunity" | "lead" | "trend" | "content" | "strategy_task";
  /** Fields conditions look at; absent: unknown (a condition on it doesn't match) */
  facts: {
    score?: number | null;
    text?: string | null;
    ageHours?: number | null;
    intent?: string | null;
    leadStatus?: string | null;
    relevance?: number | null;
    trendStatus?: string | null;
    confidence?: string | null;
    contentFormat?: string | null;
    contentStatus?: string | null;
    taskModule?: string | null;
  };
};

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * Whether an event meets every set condition, and if not, the first reason.
 * Unknown facts never pass a condition: no guessing.
 */
export function matchConditions(conditions: AutomationConditions, event: AutomationEvent): { match: true } | { match: false; reason: string } {
  const f = event.facts;
  const fail = (reason: string) => ({ match: false as const, reason });
  if (conditions.minScore !== undefined && (f.score == null || f.score < conditions.minScore)) {
    return fail(`score ${f.score == null ? "unknown" : Math.round(f.score)} below ${conditions.minScore}`);
  }
  if (conditions.textContains && !(f.text ?? "").toLowerCase().includes(conditions.textContains.toLowerCase())) {
    return fail(`doesn't mention "${conditions.textContains}"`);
  }
  if (conditions.maxAgeHours !== undefined && (f.ageHours == null || f.ageHours > conditions.maxAgeHours)) {
    return fail(`older than ${conditions.maxAgeHours} h`);
  }
  if (conditions.intents?.length && !conditions.intents.includes(f.intent as never)) return fail(`intent ${f.intent ?? "unknown"}`);
  if (conditions.leadStatuses?.length && !conditions.leadStatuses.includes(f.leadStatus as never)) return fail(`CRM status ${f.leadStatus ?? "unknown"}`);
  if (conditions.minRelevance !== undefined && (f.relevance == null || f.relevance < conditions.minRelevance)) {
    return fail(`relevance ${f.relevance ?? "unknown"} below ${conditions.minRelevance}`);
  }
  if (conditions.trendStatuses?.length && !conditions.trendStatuses.includes(f.trendStatus as never)) return fail(`trend status ${f.trendStatus ?? "unknown"}`);
  if (
    conditions.minConfidence &&
    (!f.confidence || !(f.confidence in CONFIDENCE_RANK) || CONFIDENCE_RANK[f.confidence as keyof typeof CONFIDENCE_RANK] < CONFIDENCE_RANK[conditions.minConfidence])
  ) {
    return fail(`confidence ${f.confidence ?? "unknown"} below ${conditions.minConfidence}`);
  }
  if (conditions.contentFormats?.length && !conditions.contentFormats.includes(f.contentFormat as never)) return fail(`format ${f.contentFormat ?? "unknown"}`);
  if (conditions.contentStatuses?.length && !conditions.contentStatuses.includes(f.contentStatus as never)) return fail(`status ${f.contentStatus ?? "unknown"}`);
  if (conditions.taskModules?.length && !conditions.taskModules.includes(f.taskModule as never)) return fail(`task type ${f.taskModule ?? "unknown"}`);
  return { match: true };
}

const conditionsSchema = z
  .object({
    minScore: z.number().int().min(0).max(100).optional(),
    textContains: z.string().trim().min(2).max(60).optional(),
    maxAgeHours: z.number().int().min(1).max(24 * 30).optional(),
    intents: z.array(z.enum(["high", "medium", "low"])).max(3).optional(),
    leadStatuses: z.array(z.enum(["new", "researching", "contacted", "replied", "qualified", "won", "lost"])).max(7).optional(),
    minRelevance: z.number().int().min(0).max(100).optional(),
    trendStatuses: z.array(z.enum(["emerging", "rising", "stable", "declining", "newly_detected", "insufficient_history"])).max(6).optional(),
    minConfidence: z.enum(["low", "medium", "high"]).optional(),
    contentFormats: z.array(z.enum(["post", "thread"])).max(2).optional(),
    contentStatuses: z.array(z.enum(["draft", "ready"])).max(2).optional(),
    taskModules: z.array(z.enum(["studio", "calendar", "trends", "opportunities", "leads", "growth", "discovery"])).max(7).optional(),
  })
  .strict();

export const automationInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(240).optional().default(""),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: conditionsSchema.default({}),
  actions: z.array(z.enum(AUTOMATION_ACTIONS)).min(1).max(AUTOMATION_ACTIONS.length),
  enabled: z.boolean().default(true),
  templateKey: z.string().max(40).nullable().optional(),
});

export type AutomationInput = z.infer<typeof automationInputSchema>;

/**
 * Parses builder input and keeps only what the trigger supports: conditions
 * for other triggers are dropped, actions it can't take are refused.
 */
export function validateAutomation(input: unknown): { ok: true; value: AutomationInput } | { ok: false; message: string } {
  const parsed = automationInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the automation." };
  const value = parsed.data;
  const allowedActions = ACTIONS_FOR[value.trigger];
  const unsupported = value.actions.filter((action) => !allowedActions.includes(action));
  if (unsupported.length) return { ok: false, message: `This trigger can't use: ${unsupported.join(", ")}.` };
  const allowedConditions = new Set(CONDITIONS_FOR[value.trigger]);
  const conditions = Object.fromEntries(
    Object.entries(value.conditions).filter(([key, v]) => allowedConditions.has(key as keyof AutomationConditions) && v !== undefined && !(Array.isArray(v) && v.length === 0)),
  ) as AutomationConditions;
  return { ok: true, value: { ...value, actions: [...new Set(value.actions)] as AutomationAction[], conditions } };
}
