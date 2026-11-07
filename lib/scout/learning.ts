// The Learning Profile: what Scout concluded from the user's repeated behavior.
// Separate from the Scout Brain (who the user is, from their posts) and from
// Memory (raw history). It changes slowly: only on repeated evidence.

export type Strength = "mild" | "strong";

export type LearnedItem = {
  /** Stable id, e.g. "style:removed_agreement_opener"; used for corrections */
  key: string;
  label: string;
  /** Human-readable proof, e.g. "6 of the last 8 edits" */
  evidence: string;
  strength: Strength;
};

export type LearnedTopic = LearnedItem & {
  topic: string;
  engaged: number;
  dismissed: number;
};

export type LearnedAccount = LearnedItem & { handle: string; interactions: number };

export type LearningProfile = {
  updatedAt: string;
  /** Interactions counted at the last update; ~10 new ones trigger the next */
  interactionsAtUpdate: number;

  preferredReplyLength: (LearnedItem & {
    value: "short" | "medium" | "long";
    targetChars: number;
  }) | null;
  variantPreference: (LearnedItem & { value: "natural" | "stronger_take" }) | null;

  stylePreferences: LearnedItem[];
  styleAvoidances: LearnedItem[];

  preferredTopics: LearnedTopic[];
  avoidedTopics: LearnedTopic[];

  /** Points that landed (accepted replies), most recent first */
  successfulAngles: string[];
  /** Points already made more than once; replies should find new ones */
  overusedAngles: LearnedItem[];

  preferredAccounts: LearnedAccount[];

  /** Keys the user marked "That's wrong"; never learned again */
  rejectedKeys: string[];
};
