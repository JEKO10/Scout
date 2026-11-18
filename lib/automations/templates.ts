// Day 36: ready-made automations. A template only fills the builder; the
// user edits and saves it. Nothing is activated on its own (not during
// onboarding, not anywhere).

import type { AutomationAction, AutomationConditions, AutomationTrigger } from "./types";

export type AutomationTemplate = {
  key: string;
  name: string;
  description: string;
  trigger: AutomationTrigger;
  conditions: AutomationConditions;
  actions: AutomationAction[];
};

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: "potential_customer",
    name: "Never miss a potential customer",
    description: "High-intent leads go to your CRM and your review queue, and you get notified.",
    trigger: "high_intent_lead",
    conditions: { intents: ["high"], leadStatuses: ["new"] },
    actions: ["save_lead", "notify", "review"],
  },
  {
    key: "relevant_conversations",
    name: "Find relevant conversations",
    description: "Strong new opportunities are saved and you get notified.",
    trigger: "new_opportunity",
    conditions: { minScore: 80, maxAgeHours: 24 },
    actions: ["save_opportunity", "notify"],
  },
  {
    key: "follow_ups",
    name: "Stay on top of follow-ups",
    description: "A reminder and a notification when a CRM follow-up is due.",
    trigger: "followup_due",
    conditions: {},
    actions: ["reminder", "notify"],
  },
  {
    key: "growth_plan",
    name: "Follow my growth plan",
    description: "A reminder for each task of your weekly growth plan on its day, linked to the right module.",
    trigger: "strategy_task_due",
    conditions: {},
    actions: ["reminder"],
  },
  {
    key: "emerging_trends",
    name: "Catch emerging trends",
    description: "Relevant rising trends go to your review queue, and you get notified.",
    trigger: "relevant_trend",
    conditions: { minRelevance: 60, trendStatuses: ["emerging", "rising"] },
    actions: ["review", "notify"],
  },
  {
    key: "content_schedule",
    name: "Keep my content schedule",
    description: "A reminder when a planned post is due, linked to it in Content Studio.",
    trigger: "content_due",
    conditions: {},
    actions: ["reminder"],
  },
];
