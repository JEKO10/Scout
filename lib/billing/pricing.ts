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

function every(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "hour" : `${hours} hours`;
}

function limitFeatures(limits: UsageLimits, autoScan: AutoScanSettings): string[] {
  return [
    `Watch up to ${limits.maxActiveWatchlist} accounts`,
    `${number.format(limits.monthlyXPostReads)} X posts read per month`,
    `Automatic scans as often as every ${every(Math.min(...autoScan.intervalsMinutes))}`,
    `Up to ${limits.maxCandidatesPerRun} posts scored per scan`,
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
};
