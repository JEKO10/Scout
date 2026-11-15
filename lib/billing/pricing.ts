// What the pricing page says about each plan. Limits come from PLANS, so the
// page can't promise more than Scout enforces. Prices for paid plans come from
// Paddle at runtime; nothing here is a price.
import { type AutoScanSettings, PLANS, type UsageLimits } from "./plans";

export type PricingTierId = "free" | "starter" | "pro";
export type PaidTierId = Exclude<PricingTierId, "free">;

export type PricingTier = {
  id: PricingTierId;
  name: string;
  description: string;
  features: string[];
  recommended?: boolean;
};

const number = new Intl.NumberFormat("en");

/** Measured averages (Day 23): what one scored post and one reply generation cost */
export const SCORING_USD_PER_POST = 0.0104;
export const REPLY_USD_PER_GENERATION = 0.028;

/** Roughly how many posts the AI can score and how many replies it can draft per month */
export function monthlyCapacity(limits: UsageLimits): { scoredPosts: number; replies: number } {
  return {
    scoredPosts: Math.floor(limits.monthlyScoringUsd / SCORING_USD_PER_POST),
    replies: Math.floor(limits.monthlyReplyUsd / REPLY_USD_PER_GENERATION),
  };
}

function scanFrequency(autoScan: AutoScanSettings): string {
  const minutes = Math.min(...autoScan.intervalsMinutes);
  if (minutes >= 1440) return "Automatic scan once a day";
  if (minutes >= 60) return `Automatic scans up to every ${minutes / 60} hours`;
  return `Automatic scans up to every ${minutes} minutes`;
}

function limitFeatures(limits: UsageLimits, autoScan: AutoScanSettings): string[] {
  const capacity = monthlyCapacity(limits);
  return [
    `Watch up to ${limits.maxActiveWatchlist} accounts`,
    `About ${number.format(capacity.scoredPosts)} new posts scored for you per month`,
    `About ${number.format(capacity.replies)} reply drafts per month`,
    scanFrequency(autoScan),
    "Budget paced daily, so it lasts all month",
  ];
}

const CORE = ["Scout Brain from your posts and answers", "Ranked opportunity feed", "Replies in your voice", "Slack alerts"];

export const PRICING_TIERS: PricingTier[] = [
  {
    id: "free",
    name: "Free",
    description: "Everything you need to try Scout on a small watchlist.",
    features: [...CORE, ...limitFeatures(PLANS.free.limits, PLANS.free.autoScan)],
  },
  {
    id: "starter",
    name: "Starter",
    description: "For people engaging on X every week.",
    features: ["Everything in Free", ...limitFeatures(PLANS.starter.limits, PLANS.starter.autoScan)],
  },
  {
    id: "pro",
    name: "Pro",
    description: "For founders and creators who want Scout watching all day.",
    recommended: true,
    features: ["Everything in Free", ...limitFeatures(PLANS.pro.limits, PLANS.pro.autoScan)],
  },
];

export function isPaidTier(value: unknown): value is PaidTierId {
  return value === "starter" || value === "pro";
}

/** What the pricing page knows about the signed-in user's plan */
export type PricingAccount = {
  /** The tier to mark "Your plan"; null for internal accounts without a subscription */
  currentTier: PricingTierId | null;
  /** A subscription granting access: paid tiers switch on it instead of a new checkout */
  subscription: { plan: PaidTierId | null; changeBlockedBy: string | null } | null;
  /** Internal (development) accounts are never billed: no checkout */
  internal: boolean;
};
