import { createClient } from "@libsql/client/http";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";
import * as schema from "#/db/schema.ts";
import {
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";

config({ path: [".env.local", ".env"] });

const client = createClient({
	url: process.env.DATABASE_URL ?? "",
	...(process.env.TURSO_AUTH_TOKEN
		? { authToken: process.env.TURSO_AUTH_TOKEN }
		: {}),
});
const db = drizzle(client, { schema });

const program = Effect.gen(function* () {
	const storage = yield* StorageService;
	const last = yield* storage.getMostRecentMeetingDate(
		"ellettsville-town-council",
	);
	return last;
}).pipe(Effect.provide(StorageServiceLive(db)));

const result = await Effect.runPromise(program);
console.log(`getMostRecentMeetingDate(ellettsville-town-council) = ${result}`);

const now = new Date("2026-04-23");
if (result) {
	const last = new Date(result);
	const days = Math.floor(
		(now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24),
	);
	console.log(`days since last meeting (as of 2026-04-23): ${days}`);
	console.log(`30-day zero-results alert would fire: ${days > 30}`);
}
