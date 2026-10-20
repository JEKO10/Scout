import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import { relations } from "./relations";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql, relations });

export default db;
