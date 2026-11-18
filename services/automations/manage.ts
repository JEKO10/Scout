import "server-only";

import {
  countCountedRuns,
  countEnabledAutomations,
  deleteAutomation,
  getAutomation,
  insertAutomation,
  listAutomations,
  listNotifications,
  listQueue,
  recentRuns,
  runStatsByAutomation,
  setAutomationEnabled,
  updateAutomation,
} from "@/db/queries/automations";
import type { Profile } from "@/db/schema";
import { validateAutomation } from "@/lib/automations/rules";
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import { effectiveLimits } from "@/lib/billing/plans";
import { automationsPaused } from "@/services/automations/engine";
import { currentPeriodStart } from "@/services/billing/budget";

// Day 36: creating, editing, enabling and deleting automations, always for
// the signed-in profile, within the plan's active-automation limit.

export type ManageResult = { ok: true; id: string } | { ok: false; message: string };

async function activeLimitReached(profile: Profile, exceptId?: string): Promise<string | null> {
  const limit = effectiveLimits(profile.plan, profile.usageLimitOverrides).maxActiveAutomations;
  if ((await countEnabledAutomations(profile.id, exceptId)) >= limit) {
    return `Your plan can run ${limit} ${limit === 1 ? "automation" : "automations"} at once. Turn one off first, or save this one turned off.`;
  }
  return null;
}

export async function createAutomation(profile: Profile, input: unknown): Promise<ManageResult> {
  const parsed = validateAutomation(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.enabled) {
    const limited = await activeLimitReached(profile);
    if (limited) return { ok: false, message: limited };
  }
  const row = await insertAutomation(profile.id, parsed.value);
  return { ok: true, id: row.id };
}

export async function editAutomation(profile: Profile, id: string, input: unknown): Promise<ManageResult> {
  const existing = await getAutomation(profile.id, id);
  if (!existing) return { ok: false, message: "Automation not found." };
  const parsed = validateAutomation(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.enabled && !existing.enabled) {
    const limited = await activeLimitReached(profile, id);
    if (limited) return { ok: false, message: limited };
  }
  await updateAutomation(profile.id, id, { ...parsed.value, templateKey: existing.templateKey }, existing.enabled);
  return { ok: true, id };
}

export async function toggleAutomation(profile: Profile, id: string, enabled: boolean): Promise<ManageResult> {
  const existing = await getAutomation(profile.id, id);
  if (!existing) return { ok: false, message: "Automation not found." };
  if (enabled && !existing.enabled) {
    const limited = await activeLimitReached(profile, id);
    if (limited) return { ok: false, message: limited };
  }
  await setAutomationEnabled(profile.id, id, enabled);
  return { ok: true, id };
}

export async function removeAutomation(profile: Profile, id: string): Promise<ManageResult> {
  return (await deleteAutomation(profile.id, id)) ? { ok: true, id } : { ok: false, message: "Automation not found." };
}

/** "Remind me of my plan tasks" on /strategy: the growth-plan template, created once */
export async function enableGrowthPlanReminders(profile: Profile): Promise<ManageResult> {
  const existing = (await listAutomations(profile.id)).find((a) => a.templateKey === "growth_plan");
  if (existing) return existing.enabled ? { ok: true, id: existing.id } : toggleAutomation(profile, existing.id, true);
  const template = AUTOMATION_TEMPLATES.find((t) => t.key === "growth_plan")!;
  return createAutomation(profile, {
    name: template.name,
    description: template.description,
    trigger: template.trigger,
    conditions: template.conditions,
    actions: template.actions,
    enabled: true,
    templateKey: template.key,
  });
}

/** Everything /automations shows, for the signed-in profile only */
export async function loadAutomationsView(profile: Profile, now = new Date()) {
  const since = currentPeriodStart(now);
  const [automations, stats, used, queue, notifications, activity] = await Promise.all([
    listAutomations(profile.id),
    runStatsByAutomation(profile.id, since),
    countCountedRuns(profile.id, since),
    listQueue(profile.id),
    listNotifications(profile.id),
    recentRuns(profile.id, 30),
  ]);
  const limits = effectiveLimits(profile.plan, profile.usageLimitOverrides);
  return {
    paused: automationsPaused(),
    automations: automations.map((automation) => ({
      automation,
      runsThisMonth: stats.get(automation.id)?.counted ?? 0,
      failed: stats.get(automation.id)?.failed ?? 0,
    })),
    usage: { used, limit: limits.maxAutomationRunsPerMonth, active: automations.filter((a) => a.enabled).length, activeLimit: limits.maxActiveAutomations },
    queue,
    notifications,
    activity,
  };
}
