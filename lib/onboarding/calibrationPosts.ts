// Voice calibration: posts the user replies to during onboarding, so Scout
// gets real writing samples without any X history. A small, hand-written
// library matched by keywords: deterministic, free and never off-topic.

export type CalibrationType = "agree" | "disagree" | "experience";

export type CalibrationPost = {
  id: string;
  type: CalibrationType;
  /** Lowercase keywords this post is about; "general" fits anyone */
  tags: string[];
  author: string;
  text: string;
};

export const CALIBRATION_POSTS: CalibrationPost[] = [
  // AI and coding
  { id: "ai-agree", type: "agree", tags: ["ai", "coding", "software", "developers", "tools"], author: "sample_builder", text: "AI coding tools don't replace engineers. They replace the boring 60% of the job, and the other 40% gets more important." },
  { id: "ai-disagree", type: "disagree", tags: ["ai", "coding", "software", "developers", "programmers"], author: "sample_hottakes", text: "AI will replace most programmers within 2 years. Learning to code today is a waste of time." },
  { id: "ai-experience", type: "experience", tags: ["ai", "products", "llms", "building", "software"], author: "sample_founder", text: "What's one thing AI genuinely changed in how you work this year? Not hype, an actual workflow." },
  // Startups and SaaS
  { id: "startup-agree", type: "agree", tags: ["startups", "saas", "founders", "products", "customers"], author: "sample_indie", text: "Most startups don't die from competition. They die because nobody wanted the thing in the first place." },
  { id: "startup-disagree", type: "disagree", tags: ["startups", "saas", "founders", "fundraising", "growth"], author: "sample_vc", text: "If you're not raising venture capital, you're not building a real startup. Bootstrapping is just a hobby." },
  { id: "startup-experience", type: "experience", tags: ["startups", "saas", "founders", "launch", "products"], author: "sample_maker", text: "Founders: what's the biggest mistake you made in your first year that you'd warn others about?" },
  // Audience, marketing and growth
  { id: "growth-agree", type: "agree", tags: ["audience", "marketing", "growth", "content", "creators", "brand"], author: "sample_creator", text: "Consistency beats virality. One post a day for a year will do more than one viral thread." },
  { id: "growth-disagree", type: "disagree", tags: ["audience", "marketing", "growth", "content", "creators", "social"], author: "sample_growth", text: "Replying to other people's posts is a waste of time. Only your own posts grow your audience." },
  { id: "growth-experience", type: "experience", tags: ["audience", "marketing", "growth", "distribution", "customers"], author: "sample_marketer", text: "Where did your first 100 customers or followers actually come from? Be specific." },
  // Product and design
  { id: "product-agree", type: "agree", tags: ["product", "design", "ux", "users", "products"], author: "sample_designer", text: "The best product decisions come from watching users struggle, not from asking them what they want." },
  { id: "product-disagree", type: "disagree", tags: ["product", "design", "ux", "features"], author: "sample_pm", text: "More features means more value. Users will always pick the product that does the most." },
  // Anyone
  { id: "general-agree", type: "agree", tags: ["general", "career", "learning", "work"], author: "sample_thinker", text: "You learn more from shipping one imperfect thing than from planning ten perfect ones." },
  { id: "general-disagree", type: "disagree", tags: ["general", "career", "work", "productivity"], author: "sample_hustle", text: "If you're not working 80 hours a week, you don't really want to succeed." },
  { id: "general-experience", type: "experience", tags: ["general", "career", "learning", "work"], author: "sample_curious", text: "What's a belief you held strongly two years ago that you've completely changed your mind on?" },
];

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2));
}

/**
 * One post per type (agree, disagree, add experience), the one sharing the
 * most keywords with what the user told Scout about themselves. Falls back
 * to the general posts.
 */
export function pickCalibrationPosts(profileText: string): CalibrationPost[] {
  const profileWords = words(profileText);
  // Simple plural tolerance: "startup" matches "startups"
  const matches = (tag: string) => profileWords.has(tag) || profileWords.has(tag.replace(/s$/, ""));

  return (["agree", "disagree", "experience"] as const).map((type) => {
    const options = CALIBRATION_POSTS.filter((post) => post.type === type);
    const ranked = options
      .map((post) => ({ post, score: post.tags.filter(matches).length }))
      .sort((a, b) => b.score - a.score);
    return ranked[0].score > 0
      ? ranked[0].post
      : options.find((post) => post.tags.includes("general"))!;
  });
}
