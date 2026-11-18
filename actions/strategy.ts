"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { deletePeer, setPeerSelected } from "@/db/queries/peers";
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
import { experimentWindow, planDays } from "@/lib/strategy/plan";
import {
  EXPERIMENT_MIN_PER_VARIANT,
  EXPERIMENT_PRESETS,
  PEER_MODES,
  STRATEGY_OBJECTIVES,
  WEEKLY_MINUTES_OPTIONS,
} from "@/lib/strategy/types";
import { xHandleSchema } from "@/schemas/onboarding";
import { track } from "@/services/analytics/track";
import { addPeer, refreshPeer } from "@/services/strategy/peers";
import { generateStrategy } from "@/services/strategy/strategist";

type ActionResult = { ok: boolean; message: string };

/** Running experiments at once: more would blur each other's results */
const MAX_ACTIVE_EXPERIMENTS = 3;

const prefsSchema = z.object({
  objective: z.enum(STRATEGY_OBJECTIVES),
  peerMode: z.enum(PEER_MODES).default("recommended"),
  weeklyMinutes: z.number().refine((value) => (WEEKLY_MINUTES_OPTIONS as readonly number[]).includes(value)),
});

/** "Generate my plan" / "Update plan": cached unless data or settings changed */
export async function generateStrategyAction(input: { objective: string; weeklyMinutes: number; peerMode?: string }): Promise<ActionResult> {
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
  // Proposals made before the 14-day minimum start with at least 14 days
  await updateExperiment(profile.id, experiment.id, { status: "active", ...experimentWindow(experiment.durationDays) });
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

// ---- Day 35 Peer Intelligence ------------------------------------------------------

const peerSourceSchema = z.enum(["manual", "watchlist", "scans"]);

/** Adds an account to learn from: one X user read for its public profile */
export async function addPeerAction(handle: string, source: string = "manual"): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = xHandleSchema.safeParse(handle);
  const parsedSource = peerSourceSchema.safeParse(source);
  if (!parsed.success || !parsedSource.success) return { ok: false, message: "Enter a valid X handle." };
  const result = await addPeer(profile, parsed.data, parsedSource.data);
  if (!result.ok) return { ok: false, message: result.message };
  refresh();
  return { ok: true, message: `Added @${result.peer.handle}.` };
}

export async function removePeerAction(peerId: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = id.safeParse(peerId);
  if (!parsed.success || !(await deletePeer(profile.id, parsed.data))) return { ok: false, message: "Account not found." };
  refresh();
  return { ok: true, message: "Removed." };
}

/** In "My selected accounts" mode, exactly the selected peers are analyzed */
export async function setPeerSelectedAction(peerId: string, selected: boolean): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = id.safeParse(peerId);
  if (!parsed.success || typeof selected !== "boolean" || !(await setPeerSelected(profile.id, parsed.data, selected))) {
    return { ok: false, message: "Account not found." };
  }
  refresh();
  return { ok: true, message: selected ? "Selected." : "Deselected." };
}

/** A live read of a peer's recent posts: off unless approved (PEER_REFRESH_ENABLED) */
export async function refreshPeerAction(peerId: string): Promise<ActionResult> {
  const { profile } = await requireProfile();
  const parsed = id.safeParse(peerId);
  if (!parsed.success) return { ok: false, message: "Invalid request." };
  const result = await refreshPeer(profile, parsed.data);
  if (result.ok) refresh();
  return result;
}
