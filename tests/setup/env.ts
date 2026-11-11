// Imported first by every test. Real provider keys are replaced, so a test can
// never reach X or OpenAI for real: both are mocked (tests/helpers/mocks.ts).
// The database is the real development database; tests create and delete
// their own profiles.
import { config } from "dotenv";

process.env.SCOUT_TEST_MODE = "true";
process.env.X_BEARER_TOKEN = "test-token";
process.env.OPENAI_API_KEY = "test-key";

config({ path: ".env.local", quiet: true });
config({ quiet: true });
