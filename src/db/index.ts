import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema.ts";
import { resolveDatabaseUrl } from "./url.ts";

const client = createClient({
	url: resolveDatabaseUrl(),
	authToken: process.env.TURSO_AUTH_TOKEN,
});

export const db = drizzle(client, { schema });
