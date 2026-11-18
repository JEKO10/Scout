// Day 36 Automation Scout: triggers, conditions and actions. No server code
// here: the builder, the engine and the tests share these definitions.

export const AUTOMATION_TRIGGERS = [
  "new_opportunity",
  "high_intent_lead",
  "relevant_trend",
  "followup_due",
  "content_due",
  "strategy_task_due",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_ACTIONS = [
  /** In-app notification (unread until opened) */
  "notify",
  /** An item in the review queue */
  "review",
  /** A reminder in the review queue, with its due time */
  "reminder",
  /** Opportunity → status "saved" */
  "save_opportunity",
  /** Lead → saved in CRM */
  "save_lead",
  /** Opt-in AI: two reply drafts (writing budget); never sent */
  "ai_reply_draft",
  /** Opt-in AI: the trend's content angles (Trend Insight, scoring budget, cached) */
  "ai_content_angle",
] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export const AI_ACTIONS: AutomationAction[] = ["ai_reply_draft", "ai_content_angle"];

/** Every condition is optional; a missing one doesn't filter */
export type AutomationConditions = {
  /** Opportunities and leads: score 0-100 */
  minScore?: number;
  /** Opportunities: topic contains this text; leads: post contains it */
  textContains?: string;
  /** Opportunities and trends: the post / latest trend post is at most this old */
  maxAgeHours?: number;
  /** Leads and follow-ups */
  intents?: ("high" | "medium" | "low")[];
  /** Leads: CRM status */
  leadStatuses?: ("new" | "researching" | "contacted" | "replied" | "qualified" | "won" | "lost")[];
  /** Trends */
  minRelevance?: number;
  trendStatuses?: ("emerging" | "rising" | "stable" | "declining" | "newly_detected" | "insufficient_history")[];
  minConfidence?: "low" | "medium" | "high";
  /** Content */
  contentFormats?: ("post" | "thread")[];
  contentStatuses?: ("draft" | "ready")[];
  /** Strategy tasks: the module the task links to */
  taskModules?: ("studio" | "calendar" | "trends" | "opportunities" | "leads" | "growth" | "discovery")[];
};

export type AutomationActionResult = {
  action: AutomationAction;
  status: "done" | "skipped" | "failed";
  /** Short and safe to show: never secrets or post text */
  note?: string;
};

export const TRIGGER_INFO: Record<AutomationTrigger, { label: string; when: string; module: string }> = {
  new_opportunity: { label: "New opportunity", when: "When Scout finds a new conversation worth joining", module: "Opportunities" },
  high_intent_lead: { label: "High-intent lead", when: "When Lead Scout finds a potential customer", module: "Lead Scout" },
  relevant_trend: { label: "Relevant trend", when: "When Trend Scout detects a trend in your niche", module: "Trend Scout" },
  followup_due: { label: "CRM follow-up due", when: "When a follow-up you set in the CRM is due", module: "CRM" },
  content_due: { label: "Content due", when: "When a post planned in the Content Calendar is due", module: "Content Calendar" },
  strategy_task_due: { label: "Growth plan task due", when: "When a task of your weekly growth plan is due", module: "Growth Strategy" },
};

export const ACTION_INFO: Record<AutomationAction, { label: string; ai?: boolean }> = {
  notify: { label: "Notify me in Scout" },
  review: { label: "Add to my review queue" },
  reminder: { label: "Create a reminder" },
  save_opportunity: { label: "Save the opportunity" },
  save_lead: { label: "Save the lead in my CRM" },
  ai_reply_draft: { label: "Prepare 2 reply drafts with AI (uses your AI writing budget; you review and post them yourself)", ai: true },
  ai_content_angle: { label: "Suggest content angles with AI (uses your AI budget; cached per trend)", ai: true },
};

/** Which actions make sense for which trigger */
export const ACTIONS_FOR: Record<AutomationTrigger, AutomationAction[]> = {
  new_opportunity: ["notify", "review", "save_opportunity", "ai_reply_draft"],
  high_intent_lead: ["notify", "review", "save_lead", "ai_reply_draft"],
  relevant_trend: ["notify", "review", "ai_content_angle"],
  followup_due: ["notify", "reminder"],
  content_due: ["notify", "reminder"],
  strategy_task_due: ["notify", "reminder"],
};

/** Which conditions the builder shows for which trigger */
export const CONDITIONS_FOR: Record<AutomationTrigger, (keyof AutomationConditions)[]> = {
  new_opportunity: ["minScore", "textContains", "maxAgeHours"],
  high_intent_lead: ["intents", "minScore", "leadStatuses", "textContains"],
  relevant_trend: ["minRelevance", "trendStatuses", "minConfidence", "maxAgeHours"],
  followup_due: ["intents", "minScore"],
  content_due: ["contentFormats", "contentStatuses"],
  strategy_task_due: ["taskModules"],
};

/** Run states that mean an event is finished for an automation */
export const FINAL_RUN_STATES = ["succeeded", "skipped"] as const;
export const MAX_RUN_ATTEMPTS = 3;
