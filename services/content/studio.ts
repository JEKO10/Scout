import "server-only";

import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  deleteDraft,
  getDiscoveryTopicNames,
  getDraft,
  getRecentLeadProblems,
  getTrendsForContent,
  insertDraft,
  lastContentAiCallAt,
  updateDraft,
} from "@/db/queries/content";
import { getTrend } from "@/db/queries/trends";
import type { ContentDraft, Profile, Trend } from "@/db/schema";
import type { AiOperation } from "@/db/schema";
import { type AutoCallLimits, costCeilingUsd } from "@/lib/ai/ceiling";
import { AI_MODELS, getOpenAI } from "@/lib/ai/client";
import {
  CONTENT_FORMATS,
  CONTENT_GOALS,
  CONTENT_LENGTHS,
  CONTENT_TONES,
  type ContentFormat,
  type ContentGoal,
  type ContentReview,
  DRAFT_STATUSES,
  GOAL_LABEL,
  type IdeaSuggestion,
  MAX_POST_CHARS,
  MAX_THREAD_POSTS,
  SECTION_ACTIONS,
} from "@/lib/content/types";
import { recordAiUsage } from "@/services/ai/usage";
import { track } from "@/services/analytics/track";
import { getUsageBudget } from "@/services/billing/budget";
import { resolveScoutBrain } from "@/services/scout-brain/resolveBrain";

/** A conservative per-call estimate, to keep Content Studio inside the writing budget */
export const CONTENT_USD = 0.01;
/** One AI request at a time: the next waits this long after the previous */
export const MIN_SECONDS_BETWEEN_CALLS = 4;
const MAX_OUTPUT_TOKENS = 1800;

export type StudioResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

// ---- Shared prompt rules ------------------------------------------------------

export const RULES = `You write X content for one specific person, described by their Scout profile. It must sound like them, not like an AI or a marketer.
Never invent: personal experiences, customer stories or testimonials, revenue or other numbers, product features or capabilities, case studies or research. When a post needs a specific example or number only the user knows, write an editable placeholder in square brackets, e.g. [your example: the first tool you tried].
No clickbait, no exaggerated claims, no "game-changer"-style clichés, no hashtags unless they'd naturally use one, at most one emoji and only if their voice uses emoji.
Vary sentence structure. Every single post must be at most 280 characters.`;

const GOAL_GUIDE: Record<ContentGoal, string> = {
  grow_audience: "Useful or interesting enough that the right people would follow them for more. No follower promises.",
  build_authority: "Show real understanding of their field: a clear point of view, specific and correct.",
  generate_leads: "Speak to a problem their ideal customers have; helpful first. Mention what they offer only if it fits, once, plainly.",
  start_conversations: "Invite replies: a genuine question or a take people will want to add to.",
  educate: "Teach one thing clearly and practically.",
  promote_product: "Present what they offer honestly, only with facts from their profile; lead with the problem it solves.",
};

const LENGTH_GUIDE = {
  post: { short: "under 140 characters", medium: "140–220 characters", long: "220–280 characters" },
  thread: { short: "3–4 posts", medium: "5–7 posts", long: "8–10 posts" },
} as const;

// ---- Guards --------------------------------------------------------------------

/** Budget and request pacing, checked on the server before any AI call */
async function guard(profile: Profile): Promise<string | null> {
  const last = await lastContentAiCallAt(profile.id);
  if (last && Date.now() - last.getTime() < MIN_SECONDS_BETWEEN_CALLS * 1000) {
    return "One request at a time. Try again in a few seconds.";
  }
  if ((await getUsageBudget(profile)).remaining.replyUsd < CONTENT_USD) {
    return "Your monthly writing budget (shared with reply drafts) is used up. It resets next month.";
  }
  return null;
}

async function callAi<T extends z.ZodType>(
  profile: Profile,
  operation: AiOperation,
  schema: T,
  name: string,
  instructions: string,
  input: unknown,
  auto?: AutoCallLimits,
): Promise<z.infer<T> | null> {
  const body = JSON.stringify(input);
  // Day 38 automatic preparation: the call's worst case is reserved first (the gate throws to stop it)
  if (auto) await auto.gate(costCeilingUsd(AI_MODELS.reply, [instructions, body], auto.maxOutputTokens));
  const response = await getOpenAI().responses.parse({
    model: AI_MODELS.reply,
    instructions,
    input: body,
    max_output_tokens: auto?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
    ...(auto ? { reasoning: { effort: "low" as const } } : {}),
    text: { format: zodTextFormat(schema, name) },
  // An automatic call is made once: a hidden SDK retry could spend past its reservation
  }, auto ? { maxRetries: 0 } : undefined);
  await recordAiUsage({ profileId: profile.id, operation }, response);
  const parsed = schema.safeParse(response.output_parsed);
  return parsed.success ? parsed.data : null;
}

// ---- Context -------------------------------------------------------------------

/** Who the user is: Scout Brain first, onboarding answers as fallback */
export function userContext(profile: Profile) {
  const brain = resolveScoutBrain(profile);
  return {
    occupation: profile.occupation,
    knownFor: brain?.goals.knownFor.map((item) => item.label) ?? profile.knownFor,
    audience: brain?.goals.targetAudience.map((item) => item.label) ?? profile.targetAudience,
    topics: brain?.interests.topics.map((item) => item.label).slice(0, 10) ?? profile.topics,
    expertise: brain?.interests.expertise?.map((item) => item.area).slice(0, 6) ?? [],
    offers: profile.leadProfile ? { product: profile.leadProfile.product, problemsItSolves: profile.leadProfile.problems } : null,
    voice: brain
      ? {
          summary: brain.voice.summary,
          tone: brain.voice.tone.map((item) => item.label),
          avoid: brain.voice.avoid.map((item) => item.label),
          emoji: brain.voice.emojiUsage,
          capitalization: brain.voice.capitalization,
        }
      : profile.voiceDescription,
    rules: profile.replyRules,
  };
}

/** A trend as stored: what Scout observed and, if written, its AI insight. Nothing added. */
function trendContext(trend: Trend) {
  return {
    title: trend.label,
    status: trend.status,
    relevanceToUser: trend.relevance,
    observed: trend.summary,
    oftenMentioned: trend.terms,
    insight: trend.insight
      ? {
          summary: trend.insight.summary,
          discussion: trend.insight.discussion,
          recurringQuestions: trend.insight.recurringQuestions,
          whyItMatters: trend.insight.whyItMatters,
          angles: trend.insight.angles,
        }
      : null,
  };
}

// ---- Ideas ---------------------------------------------------------------------

const ideasSchema = z.object({
  ideas: z.array(
    z.object({
      hook: z.string(),
      description: z.string(),
      format: z.enum(CONTENT_FORMATS),
      audience: z.string(),
      why: z.string().describe("Why it fits this user's goal and expertise"),
    }),
  ),
});

export const ideasInputSchema = z.object({
  goal: z.enum(CONTENT_GOALS),
  topic: z.string().trim().max(200).optional(),
  trendId: z.uuid().optional(),
});

/**
 * Five ideas from what Scout already knows: the Brain, what the user offers,
 * their Discovery topics, saved/top trends and recurring lead problems. No X
 * calls; the trend data is the cached one.
 */
export async function generateIdeas(profile: Profile, raw: z.input<typeof ideasInputSchema>): Promise<StudioResult<{ ideas: IdeaSuggestion[] }>> {
  const input = ideasInputSchema.safeParse(raw);
  if (!input.success) return { ok: false, message: "Pick a goal first." };
  const blocked = await guard(profile);
  if (blocked) return { ok: false, message: blocked };

  const trend = input.data.trendId ? await getTrend(profile.id, input.data.trendId) : undefined;
  if (input.data.trendId && !trend) return { ok: false, message: "Trend not found." };
  const [trends, discoveryTopics, leadProblems] = await Promise.all([
    trend ? Promise.resolve([trend]) : getTrendsForContent(profile.id),
    getDiscoveryTopicNames(profile.id),
    getRecentLeadProblems(profile.id),
  ]);

  const result = await callAi(
    profile,
    "content_ideas",
    ideasSchema,
    "content_ideas",
    `${RULES}
Suggest 5 distinct content ideas for X for this person and goal. Use their topics, expertise and the context given (trends, discovery topics, recurring customer problems). If a trend is given, every idea is about that trend and uses only what it says.
Recurring customer problems are summaries: use them as themes only, never as quotes, and never refer to specific people.
hook: a possible opening line. format: "post" or "thread".`,
    {
      user: userContext(profile),
      goal: { id: input.data.goal, label: GOAL_LABEL[input.data.goal], guide: GOAL_GUIDE[input.data.goal] },
      topic: input.data.topic ?? null,
      trends: trends.map(trendContext),
      discoveryTopics,
      recurringCustomerProblems: leadProblems,
    },
  );
  if (!result) return { ok: false, message: "Couldn't come up with ideas this time. Try again." };
  await track("content_ideas_generated", { profileId: profile.id, props: { goal: input.data.goal } });
  return { ok: true, ideas: result.ideas.slice(0, 5).map((idea) => ({ ...idea, hook: idea.hook.slice(0, 280), description: idea.description.slice(0, 400) })) };
}

// ---- Drafts --------------------------------------------------------------------

const draftSchema = z.object({ title: z.string(), posts: z.array(z.string()) });

export const writeInputSchema = z.object({
  goal: z.enum(CONTENT_GOALS),
  format: z.enum(CONTENT_FORMATS),
  tone: z.enum(CONTENT_TONES),
  length: z.enum(CONTENT_LENGTHS),
  topic: z.string().trim().max(300).optional(),
  idea: z
    .object({ hook: z.string().max(280), description: z.string().max(400), format: z.enum(CONTENT_FORMATS), audience: z.string().max(200), why: z.string().max(400) })
    .optional(),
  trendId: z.uuid().optional(),
});

function cleanPosts(posts: string[], format: ContentFormat): string[] {
  const cleaned = posts.map((post) => post.trim().slice(0, MAX_POST_CHARS)).filter(Boolean);
  return format === "post" ? cleaned.slice(0, 1) : cleaned.slice(0, MAX_THREAD_POSTS);
}

async function writePosts(profile: Profile, input: z.infer<typeof writeInputSchema>, trend: Trend | undefined, guidance: string[] = [], auto?: AutoCallLimits) {
  return callAi(
    profile,
    "content_generation",
    draftSchema,
    "content_draft",
    `${RULES}
Write ${input.format === "post" ? "one X post" : "an X thread"} for this person.
${input.format === "thread" ? "A thread: a first post that makes people want to read on, a logical progression with one point per post, and a clear ending. Don't number posts unless it helps." : ""}
Length: ${LENGTH_GUIDE[input.format][input.length]}. Tone: ${input.tone}, but still in their own voice.
title: a short internal name for the draft.${guidance.length ? `\nLearned from this user's own choices:\n${guidance.map((line) => `- ${line}`).join("\n")}` : ""}`,
    {
      user: userContext(profile),
      goal: { label: GOAL_LABEL[input.goal], guide: GOAL_GUIDE[input.goal] },
      topic: input.topic ?? null,
      idea: input.idea ?? null,
      trend: trend ? trendContext(trend) : null,
    },
    auto,
  );
}

/**
 * Writes a new draft (post or thread) and saves it. Never published.
 * Day 38: the Home inbox prepares posts through here too ("scout" origin),
 * with what Scout learned from the user's Inbox decisions as guidance.
 */
export async function createDraft(
  profile: Profile,
  raw: z.input<typeof writeInputSchema>,
  options: { origin?: "studio" | "scout"; guidance?: string[]; auto?: AutoCallLimits } = {},
): Promise<StudioResult<{ draftId: string }>> {
  const input = writeInputSchema.safeParse(raw);
  if (!input.success) return { ok: false, message: "Check the options." };
  if (!input.data.topic && !input.data.idea && !input.data.trendId) return { ok: false, message: "Pick an idea or write a topic first." };
  const blocked = await guard(profile);
  if (blocked) return { ok: false, message: blocked };
  const trend = input.data.trendId ? await getTrend(profile.id, input.data.trendId) : undefined;
  if (input.data.trendId && !trend) return { ok: false, message: "Trend not found." };

  const result = await writePosts(profile, input.data, trend, options.guidance, options.auto);
  const posts = result ? cleanPosts(result.posts, input.data.format) : [];
  if (!result || posts.length === 0) return { ok: false, message: "Couldn't write it this time. Try again." };
  const draft = await insertDraft(profile.id, {
    title: result.title.trim().slice(0, 120) || "Untitled draft",
    goal: input.data.goal,
    format: input.data.format,
    tone: input.data.tone,
    length: input.data.length,
    posts,
    topic: input.data.topic ?? input.data.idea?.hook ?? null,
    idea: input.data.idea ?? null,
    sourceTrendId: trend?.id ?? null,
    origin: options.origin ?? "studio",
  });
  await track("content_draft_created", { profileId: profile.id, props: { format: input.data.format, goal: input.data.goal } });
  return { ok: true, draftId: draft.id };
}

/** Rewrites the whole draft with the same settings (the user asked for it explicitly) */
export async function regenerateDraft(profile: Profile, draftId: string): Promise<StudioResult<{ posts: string[] }>> {
  const draft = await getDraft(profile.id, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  const blocked = await guard(profile);
  if (blocked) return { ok: false, message: blocked };
  const trend = draft.sourceTrendId ? await getTrend(profile.id, draft.sourceTrendId) : undefined;
  const result = await writePosts(
    profile,
    { goal: draft.goal, format: draft.format, tone: draft.tone, length: draft.length, topic: draft.topic ?? undefined, idea: draft.idea ?? undefined },
    trend,
  );
  const posts = result ? cleanPosts(result.posts, draft.format) : [];
  if (posts.length === 0) return { ok: false, message: "Couldn't rewrite it this time." };
  await updateDraft(profile.id, draftId, { posts, review: null });
  return { ok: true, posts };
}

const sectionSchema = z.object({ text: z.string() });
const SECTION_GUIDE: Record<(typeof SECTION_ACTIONS)[number], string> = {
  hook: "Rewrite this opening so it's clearer and makes the right people want to read on. Same point, no clickbait.",
  shorten: "Make it noticeably shorter, keeping the point.",
  expand: "Expand it with one more useful detail or step, within 280 characters. Use a [placeholder] for anything only the user knows.",
  clarity: "Make it clearer and easier to read. Same meaning.",
  alternative: "Write a different version of this post: same point, a different way in.",
  tone: "Rewrite it in the requested tone, still in their voice.",
};

/**
 * Rewrites ONE post of a draft (the rest stays as it is): better hook,
 * shorter, longer, clearer, an alternative, or another tone.
 */
export async function rewritePost(
  profile: Profile,
  draftId: string,
  index: number,
  action: string,
  tone?: string,
): Promise<StudioResult<{ text: string }>> {
  const parsedAction = z.enum(SECTION_ACTIONS).safeParse(action);
  const parsedTone = tone === undefined ? null : z.enum(CONTENT_TONES).safeParse(tone);
  if (!parsedAction.success || (parsedTone && !parsedTone.success)) return { ok: false, message: "Unknown edit." };
  const draft = await getDraft(profile.id, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  if (!Number.isInteger(index) || index < 0 || index >= draft.posts.length) return { ok: false, message: "That post doesn't exist." };
  const blocked = await guard(profile);
  if (blocked) return { ok: false, message: blocked };

  const result = await callAi(
    profile,
    "content_generation",
    sectionSchema,
    "content_section",
    `${RULES}
${SECTION_GUIDE[parsedAction.data]}${parsedTone?.success ? ` Tone: ${parsedTone.data}.` : ""}
Rewrite only the post marked "rewrite"; the others are context. Return only its new text.`,
    {
      user: userContext(profile),
      goal: GOAL_LABEL[draft.goal],
      format: draft.format,
      posts: draft.posts.map((text, i) => ({ position: i + 1, text, rewrite: i === index })),
    },
  );
  const text = result?.text.trim().slice(0, MAX_POST_CHARS);
  if (!text) return { ok: false, message: "Couldn't rewrite it this time." };
  const posts = [...draft.posts];
  posts[index] = text;
  await updateDraft(profile.id, draftId, { posts });
  await track("content_draft_edited", { profileId: profile.id, props: { action: parsedAction.data } });
  return { ok: true, text };
}

// ---- Review --------------------------------------------------------------------

const reviewSchema = z.object({
  assessment: z.string().describe("2-3 sentences, qualitative. No scores, percentages or predictions."),
  improvements: z.array(z.string()).describe("Up to 3 specific, actionable improvements"),
  revised: z.array(z.string()).nullable().describe("An improved version (same number of posts), or null if it's already good"),
});

/** Scout Content Review, on request only: hook, readability, audience fit, specificity, promo tone, unsupported claims, purpose */
export async function reviewDraft(profile: Profile, draftId: string): Promise<StudioResult<{ review: ContentReview }>> {
  const draft = await getDraft(profile.id, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  const blocked = await guard(profile);
  if (blocked) return { ok: false, message: blocked };

  const result = await callAi(
    profile,
    "content_review",
    reviewSchema,
    "content_review",
    `${RULES}
Review this draft for: a clear hook, readability, relevance to their audience, specificity, unnecessary promotional language, claims it can't support (flag them), and a clear purpose for the goal.
Be honest and brief. Never give scores, percentages, viral potential or reach predictions.`,
    { user: userContext(profile), goal: GOAL_LABEL[draft.goal], format: draft.format, posts: draft.posts },
  );
  if (!result) return { ok: false, message: "Couldn't review it this time." };
  const review: ContentReview = {
    assessment: result.assessment.trim().slice(0, 600),
    improvements: result.improvements.slice(0, 3).map((item) => item.trim().slice(0, 300)),
    revised: result.revised ? cleanPosts(result.revised, draft.format) : null,
  };
  await updateDraft(profile.id, draftId, { review });
  await track("content_reviewed", { profileId: profile.id });
  return { ok: true, review };
}

// ---- Manual edits and management (no AI) -------------------------------------

export const editSchema = z.object({
  title: z.string().trim().min(1, "Give the draft a name.").max(120),
  posts: z
    .array(z.string().max(MAX_POST_CHARS, "A post is too long to store."))
    .min(1, "A draft needs at least one post.")
    .max(MAX_THREAD_POSTS, `A thread can have up to ${MAX_THREAD_POSTS} posts.`),
  status: z.enum(DRAFT_STATUSES),
});

export async function saveDraftEdits(profile: Profile, draftId: string, raw: z.input<typeof editSchema>): Promise<StudioResult> {
  const parsed = editSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the draft." };
  const draft = await getDraft(profile.id, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  const posts = parsed.data.posts.map((post) => post.trim()).filter(Boolean);
  if (posts.length === 0) return { ok: false, message: "A draft needs at least one post." };
  if (draft.format === "post" && posts.length > 1) return { ok: false, message: "A single post has one part. Switch to a thread for more." };
  await updateDraft(profile.id, draftId, { title: parsed.data.title, posts, status: parsed.data.status });
  await track("content_draft_edited", { profileId: profile.id, props: { action: "manual" } });
  if (draft.status !== "ready" && parsed.data.status === "ready") await track("content_marked_ready", { profileId: profile.id });
  return { ok: true };
}

export async function duplicateDraft(profile: Profile, draftId: string): Promise<StudioResult<{ draftId: string }>> {
  const draft = await getDraft(profile.id, draftId);
  if (!draft) return { ok: false, message: "Draft not found." };
  const copy = await insertDraft(profile.id, {
    title: `${draft.title} (copy)`.slice(0, 120),
    goal: draft.goal,
    format: draft.format,
    tone: draft.tone,
    length: draft.length,
    posts: draft.posts,
    topic: draft.topic,
    idea: draft.idea,
    sourceTrendId: draft.sourceTrendId,
    status: "draft",
  });
  return { ok: true, draftId: copy.id };
}

export async function removeDraft(profile: Profile, draftId: string): Promise<StudioResult> {
  return (await deleteDraft(profile.id, draftId)) ? { ok: true } : { ok: false, message: "Draft not found." };
}

/** The user says they posted it on X; Scout can't see that itself */
export async function confirmPublished(profile: Profile, draftId: string): Promise<StudioResult> {
  const updated = await updateDraft(profile.id, draftId, { publishedConfirmedAt: new Date() });
  if (!updated) return { ok: false, message: "Draft not found." };
  await track("content_publish_confirmed", { profileId: profile.id });
  return { ok: true };
}

export type { ContentDraft };
