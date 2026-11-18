// Recognizes "the database is behind the code" errors: a table (42P01) or
// column (42703) that a newer migration adds. Used where a newer feature
// must not take older pages down with it; callers log it loudly and show
// that the feature needs the migration, they never pretend it worked.

const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]);

export function isMissingSchemaError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && MISSING_SCHEMA_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The message logged when a feature's tables are missing */
export function missingSchemaMessage(feature: string, migration: string): string {
  return `${feature} is unavailable: the database is missing tables or columns from migration ${migration}. Run the migrations (drizzle-kit migrate).`;
}
