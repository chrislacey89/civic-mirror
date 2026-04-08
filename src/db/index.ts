import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.ts";

const url = process.env.DATABASE_URL ?? "";
export const db = drizzle(url, { schema });
