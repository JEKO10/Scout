// Paddle.js settings, read on the server and passed to the client components
// that need them. Only public values: the client-side token and price IDs are
// meant for the browser. The server API key (PADDLE_API_KEY) never goes here.

export type PaddleEnvironment = "sandbox" | "production";

export type PaddleClientConfig = {
  environment: PaddleEnvironment;
  token: string;
  priceIds: { starter: string; pro: string };
};

export type PaddleConfigResult =
  | { ok: true; config: PaddleClientConfig }
  | { ok: false; problems: string[] };

/**
 * Never defaults the environment: a missing or unknown value is an error, so a
 * misconfigured deploy can't quietly talk to the wrong Paddle account.
 */
export function readPaddleConfig(): PaddleConfigResult {
  const environment = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT;
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  const starter = process.env.NEXT_PUBLIC_PADDLE_STARTER_PRICE_ID;
  const pro = process.env.NEXT_PUBLIC_PADDLE_PRO_PRICE_ID;

  const problems: string[] = [];
  if (environment !== "sandbox" && environment !== "production") {
    problems.push(
      environment
        ? `NEXT_PUBLIC_PADDLE_ENVIRONMENT must be "sandbox" or "production", got "${environment}"`
        : "NEXT_PUBLIC_PADDLE_ENVIRONMENT is not set",
    );
  }
  if (!token) problems.push("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set");
  // Paddle prefixes client tokens by environment: test_ (sandbox), live_ (production)
  else if (environment === "sandbox" && !token.startsWith("test_")) {
    problems.push("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not a sandbox token (test_…)");
  } else if (environment === "production" && !token.startsWith("live_")) {
    problems.push("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not a live token (live_…)");
  }
  if (!starter?.startsWith("pri_")) problems.push("NEXT_PUBLIC_PADDLE_STARTER_PRICE_ID is missing or not a price ID (pri_…)");
  if (!pro?.startsWith("pri_")) problems.push("NEXT_PUBLIC_PADDLE_PRO_PRICE_ID is missing or not a price ID (pri_…)");

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      environment: environment as PaddleEnvironment,
      token: token!,
      priceIds: { starter: starter!, pro: pro! },
    },
  };
}

/**
 * Two-letter country from Vercel's geo header, or undefined so Paddle detects
 * the visitor's location from their IP. Vercel uses "XX"-style codes for
 * unknown locations; those are dropped, never sent to Paddle.
 */
export function countryFromHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return undefined;
  return code;
}

/**
 * Whether paid plans can be bought. Real payments need live Paddle billing;
 * Sandbox checkout is a developer tool, so on a deployed app it stays closed
 * (paid plans show as "coming soon") and only local development can use it.
 */
export function isCheckoutOpen(config: PaddleConfigResult): boolean {
  if (!config.ok) return false;
  return config.config.environment === "production" || process.env.NODE_ENV !== "production";
}
