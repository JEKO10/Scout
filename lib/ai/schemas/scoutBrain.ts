import { z } from "zod";

// ---------------------------------------------------------------------------
// AI output schemas. Sent to OpenAI as a strict JSON schema, so every field is
// required (use nullable instead of optional) and guidance lives in describe().
// ---------------------------------------------------------------------------

const evidenceSchema = z
  .enum(["observed", "stated", "inferred"])
  .describe(
    "observed = clearly visible in several posts; stated = comes from the user's onboarding answers, not the posts; inferred = an educated guess the posts only hint at.",
  );

const confidenceSchema = z.enum(["high", "medium", "low"]);

const postIdsSchema = z
  .array(z.string())
  .describe("IDs of supporting posts, copied exactly from the post list. Max 5.");

export const voiceBrainSchema = z.object({
  summary: z
    .string()
    .describe(
      "2–3 sentences briefing a ghostwriter on how this person writes. Concrete, no flattery.",
    ),
  languages: z
    .array(z.string())
    .describe("Languages the person posts in, most used first."),
  perspective: z
    .enum(["personal", "institutional", "mixed"])
    .describe(
      "personal = writes as an individual ('I'); institutional = writes on behalf of an organization ('we', the brand name); mixed = both.",
    ),
  tone: z
    .array(z.string())
    .describe("3–6 short tone descriptors, e.g. 'direct', 'dry humor', 'optimistic'."),
  sentenceLength: z.enum(["very_short", "short", "medium", "long", "mixed"]),
  directness: z.enum(["low", "medium", "high"]),
  humor: z
    .string()
    .describe("Kind and frequency of humor, or 'None observed'."),
  vocabulary: z
    .string()
    .describe("Register, jargon, slang, technical depth of word choice."),
  formatting: z
    .array(z.string())
    .describe(
      "Observed formatting habits, e.g. 'single-line posts', 'line breaks between ideas', 'numbered lists'.",
    ),
  capitalization: z.enum(["standard", "mostly_lowercase", "mixed", "emphatic_caps"]),
  emojiUsage: z.enum(["none", "rare", "moderate", "frequent"]),
  postStyle: z.string().describe("How a typical original post is structured."),
  replyStyle: z
    .string()
    .describe(
      "How replies differ from posts. Write 'Not enough replies to tell' if fewer than 3 replies.",
    ),
  signaturePhrases: z
    .array(
      z.object({
        phrase: z.string().describe("Quoted exactly, in the original language. Emoji count as phrases."),
        frequency: z
          .enum(["rare", "occasional", "frequent"])
          .describe(
            "Share of posts that use it: rare = under 10%, occasional = 10–30%, frequent = over 30%. Count, don't guess.",
          ),
      }),
    )
    .describe(
      "Phrases or rhetorical patterns that recur in at least 2 posts and would also fit in a conversation, quoted exactly in the original language. Exclude calls to action, link pointers and subscription or sales boilerplate. Empty if none.",
    ),
  promotionalPatterns: z
    .array(z.string())
    .describe(
      "Recurring calls to action and promotional boilerplate (e.g. 'Link below:', 'subscribe', 'free for 48 hours'). Recorded so replies can deliberately avoid them. Empty if none.",
    ),
  avoid: z
    .array(z.string())
    .describe(
      "Things a ghostwriter must not do to sound like this person, grounded in what the posts never do (e.g. 'no hashtags', 'never uses corporate buzzwords').",
    ),
  examplePostIds: postIdsSchema,
  confidence: confidenceSchema.describe(
    "Overall confidence in this voice profile given the amount and variety of posts.",
  ),
});

export const interestBrainSchema = z.object({
  topics: z
    .array(
      z.object({
        name: z.string().describe("Short topic name, e.g. 'AI agents', 'SaaS pricing'."),
        tier: z
          .enum(["core", "secondary"])
          .describe("core = a main subject of their posts; secondary = recurring but minor."),
        evidence: evidenceSchema,
        confidence: confidenceSchema,
        postCount: z
          .number()
          .int()
          .describe("How many of the provided posts are about this topic."),
        examplePostIds: postIdsSchema,
      }),
    )
    .describe(
      "Subject areas the person could credibly join other people's conversations about. Only include areas covered by at least 2 posts or stated in onboarding. Not their own business operations (shipping, billing, support, subscription drives).",
    ),
  expertise: z
    .array(
      z.object({
        area: z.string(),
        evidence: evidenceSchema,
        reasoning: z
          .string()
          .describe(
            "Why this counts as expertise: specific depth, first-hand experience or results shown in posts, or an onboarding claim.",
          ),
      }),
    )
    .describe(
      "Areas of real expertise. Talking about a topic is not expertise; require depth or first-hand experience. Handling one's own shipping, billing or customer support is not subject expertise.",
    ),
  recurringThemes: z
    .array(z.string())
    .describe("Angles or narratives they keep returning to, e.g. 'building in public'."),
  entities: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(["company", "person", "technology", "product", "other"]),
      }),
    )
    .describe("Companies, people, technologies and products they mention more than once."),
  opinions: z
    .array(
      z.object({
        statement: z
          .string()
          .describe("The opinion in one sentence, as the person would put it."),
        topic: z.string(),
        examplePostIds: postIdsSchema,
      }),
    )
    .describe(
      "Every clear stance or take the posts show, each backed by posts. Look in replies as well as original posts: replies often hold the sharpest opinions, even in one line. Usually 4–10 when the posts support them; never invent one.",
    ),
  lowConfidenceTopics: z
    .array(
      z.object({
        name: z.string(),
        reason: z.string().describe("e.g. 'Mentioned once', 'Only retweet-style commentary'."),
      }),
    )
    .describe(
      "Subject areas that appear only once or superficially AND are not part of any topic above. Scout avoids engaging on these. Never list a specific subject (a book, event or figure) whose broader area is already a topic.",
    ),
});

export const goalBrainSchema = z.object({
  primaryGoal: z.string().describe("The user's primary goal, from onboarding."),
  occupation: z.string().describe("Their role and context, from onboarding."),
  targetAudience: z
    .array(z.string())
    .describe("2–5 concrete audience segments derived from the onboarding answer."),
  knownFor: z
    .array(z.string())
    .describe("What they want to be known for, split into short items."),
  desiredPositioning: z
    .string()
    .describe(
      "One sentence: how they want to be perceived by the target audience.",
    ),
  postingAlignment: z
    .string()
    .describe(
      "How well their current posts serve this goal and audience, and the biggest gap. Be honest.",
    ),
});

export const scoutBrainAnalysisSchema = z.object({
  voice: voiceBrainSchema,
  interests: interestBrainSchema,
  goals: goalBrainSchema,
});

export type VoiceBrainData = z.infer<typeof voiceBrainSchema>;
export type InterestBrainData = z.infer<typeof interestBrainSchema>;
export type GoalBrainData = z.infer<typeof goalBrainSchema>;
export type ScoutBrainAnalysis = z.infer<typeof scoutBrainAnalysisSchema>;

// ---------------------------------------------------------------------------
// Stored brains. The AI analysis is kept separate from the user's edits, so
// re-analyzing never overwrites what the user added or removed.
// ---------------------------------------------------------------------------

/** Lists the user can add to or remove from, per brain. */
export const editableBrainLists = {
  voice: ["tone", "signaturePhrases", "avoid"],
  interests: ["topics", "recurringThemes"],
  goals: ["targetAudience", "knownFor"],
} as const;

export type BrainName = keyof typeof editableBrainLists;
export type EditableList<B extends BrainName> =
  (typeof editableBrainLists)[B][number];

export type BrainListEdits = { added: string[]; removed: string[] };

export type StoredBrain<TData, B extends BrainName> = {
  data: TData;
  edits: Partial<Record<EditableList<B>, BrainListEdits>>;
  analyzedAt: string;
  /** Posts the analysis was trained on. */
  postCount: number;
  /** Posts deliberately withheld from the model, for evals. */
  holdoutPostIds: string[];
  model: string;
};

/** Style habits counted in code from the analyzed posts (not AI output). */
export const measuredVoiceSchema = z.object({
  postCount: z.number(),
  emojiShare: z.number(),
  exclamationShare: z.number(),
  lowercaseStartShare: z.number(),
  replyShare: z.number(),
  medianPostLength: z.number(),
  medianReplyLength: z.number().nullable(),
});

export type MeasuredVoice = z.infer<typeof measuredVoiceSchema>;

export type StoredVoiceBrain = StoredBrain<VoiceBrainData, "voice"> & {
  measured?: MeasuredVoice;
};
export type StoredInterestBrain = StoredBrain<InterestBrainData, "interests">;
export type StoredGoalBrain = StoredBrain<GoalBrainData, "goals">;
