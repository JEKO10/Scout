"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import {
  addExperimentObservation,
  countActiveExperiments,
  getExperiment,
  getPlanTask,
  insertExperiment,
  updateExperiment,
  updatePlanTask,
} from "@/db/queries/strategy";
import { requireProfile } from "@/lib/auth/session";
import { planDays } from "@/lib/strategy/plan";
import { EXPERIMENT_MIN_PER_VARIANT, EXPERIMENT_PRESETS, STRATEGY_OBJECTIVES, WEEKLY_MINUTES_OPTIONS } from "@/lib/strategy/types";
import { track } from "@/services/analytics/track";
import { generateStrategy } from "@/services/strategy/strategist";

type ActionResult = { ok: boolean; message: string };

/** Running experiments at once: more would blur each other's results */
const MAX_ACTIVE_EXPERIMENTS = 3;

const prefsSchema = z.object({
  objective: z.enum(STRATEGY_OBJECTIVES),
  weeklyMinutes: z.number().refine((value) => (WEEKLY_MINUTES_OPTIONS as readonly number[]).includes(value)),
});

/** "Generate my plan" / "Update plan": cached unless data or settings changed */
export async function generateStrategyAction(input: { objective: string; weeklyMinutes: number }): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = prefsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose an objective and how much time you have." };
  const result = await generateStrategy(profile, parsed.data);
  if (result.ok && !result.cached) {
    await track("growth_strategy_generated", { profileId: profile.id });
    refresh();
  }
  return { ok: result.ok, message: result.message };
}

const id = z.uuid();
const taskChange = z.union([
  z.object({ status: z.enum(["todo", "done", "skipped"]) }),
  z.object({ day: z.iso.date() }),
]);

/** Done, skipped, back to to-do, or another day of the same 7-day plan */
export async function updateTaskAction(taskId: string, change: { status: "todo" | "done" | "skipped" } | { day: string }): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsedId = id.safeParse(taskId);
  const parsed = taskChange.safeParse(change);
  if (!parsedId.success || !parsed.success) return { ok: false, message: "Invalid request." };
  const found = await getPlanTask(profile.id, parsedId.data);
  if (!found) return { ok: false, message: "Task not found." };
  if ("day" in parsed.data && !planDays(found.weekStart).includes(parsed.data.day)) {
    return { ok: false, message: "Pick a day of this week's plan." };
  }
  await updatePlanTask(profile.id, parsedId.data, parsed.data);
  refresh();
  return { ok: true, message: "Updated." };
}

async function canStartAnother(profileId: string): Promise<boolean> {
  return (await countActiveExperiments(profileId)) < MAX_ACTIVE_EXPERIMENTS;
}

/** Starts an experiment the strategy proposed */
export async function startExperimentAction(experimentId: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = id.safeParse(experimentId);
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const experiment = await getExperiment(profile.id, parsed.data);
  if (!experiment || experiment.status !== "proposed") return { ok: false, message: "Experiment not found." };
  if (!(await canStartAnother(profile.id))) return { ok: false, message: `Run at most ${MAX_ACTIVE_EXPERIMENTS} experiments at once.` };
  const now = new Date();
  await updateExperiment(profile.id, experiment.id, {
    status: "active",
    startedAt: now,
    endsAt: new Date(now.getTime() + experiment.durationDays * 86_400_000),
  });
  refresh();
  return { ok: true, message: "Experiment started." };
}

/** Starts a ready-made experiment, no AI involved */
export async function startPresetExperimentAction(key: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const preset = EXPERIMENT_PRESETS.find((item) => item.key === key);
  if (!preset) return { ok: false, message: "Unknown experiment." };
  if (!(await canStartAnother(profile.id))) return { ok: false, message: `Run at most ${MAX_ACTIVE_EXPERIMENTS} experiments at once.` };
  const now = new Date();
  await insertExperiment(profile.id, {
    title: preset.title,
    hypothesis: preset.hypothesis,
    dimension: preset.dimension,
    variantA: preset.variantA,
    variantB: preset.variantB,
    metric: preset.metric,
    durationDays: preset.durationDays,
    actions: preset.actions,
    minPerVariant: EXPERIMENT_MIN_PER_VARIANT,
    status: "active",
    startedAt: now,
    endsAt: new Date(now.getTime() + preset.durationDays * 86_400_000),
  });
  refresh();
  return { ok: true, message: "Experiment started." };
}

const observationSchema = z.string().trim().min(2).max(500);

export async function addObservationAction(experimentId: string, text: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsedId = id.safeParse(experimentId);
  const parsed = observationSchema.safeParse(text);
  if (!parsedId.success || !parsed.success) return { ok: false, message: "Write a short observation (up to 500 characters)." };
  const saved = await addExperimentObservation(profile.id, parsedId.data, { at: new Date().toISOString(), text: parsed.data });
  if (!saved) return { ok: false, message: "Experiment not found." };
  refresh();
  return { ok: true, message: "Observation saved." };
}

const finishSchema = z.object({ status: z.enum(["completed", "stopped"]), conclusion: z.string().trim().max(800) });

/** Ends an experiment (or dismisses a proposal) with the user's conclusion */
export async function finishExperimentAction(experimentId: string, input: { status: "completed" | "stopped"; conclusion: string }): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsedId = id.safeParse(experimentId);
  const parsed = finishSchema.safeParse(input);
  if (!parsedId.success || !parsed.success) return { ok: false, message: "Invalid request." };
  const saved = await updateExperiment(profile.id, parsedId.data, {
    status: parsed.data.status,
    conclusion: parsed.data.conclusion || null,
    endsAt: new Date(),
  });
  if (!saved) return { ok: false, message: "Experiment not found." };
  refresh();
  return { ok: true, message: parsed.data.status === "completed" ? "Experiment completed." : "Experiment stopped." };
}
