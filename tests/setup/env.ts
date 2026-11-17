// Imported first by every test. Real provider keys are replaced, so a test can
// never reach X, OpenAI or Slack for real: all are mocked (tests/helpers/mocks.ts).
// The database is TEST_DATABASE_URL or DATABASE_TEST_URL (a Neon branch) when set, otherwise the
// development database; tests create and delete their own profiles.
import { config } from "dotenv";

process.env.SCOUT_TEST_MODE = "true";
process.env.X_BEARER_TOKEN = "test-token";
process.env.OPENAI_API_KEY = "test-key";
// Slack is mocked too (tests/helpers/mocks.ts); a fixed test key encrypts tokens
process.env.SLACK_CLIENT_ID = "test-client-id";
process.env.SLACK_CLIENT_SECRET = "test-client-secret";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL = "https://scout.test";
// X OAuth (mocked): off unless a test turns it on; automatic collection off
process.env.X_CLIENT_ID = "test-x-client";
process.env.X_CLIENT_SECRET = "test-x-secret";
process.env.X_OAUTH_ENABLED = "false";
process.env.X_ANALYTICS_AUTO_ENABLED = "false";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

// Either name works for the test branch's connection string
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_TEST_URL;
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.SCOUT_TESTS_ISOLATED_DB = "true";
}
