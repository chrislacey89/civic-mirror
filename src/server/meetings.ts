import { createServerFn } from "@tanstack/react-start";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema.ts";
import { getMeetingByBodyAndDateQuery } from "#/pipeline/services/StorageService.ts";

const url = process.env.DATABASE_URL ?? "";
const db = drizzle(url, { schema });

/**
 * Server function to load a meeting's full detail by governing body slug and date.
 *
 * Delegates to the shared `getMeetingByBodyAndDateQuery` from StorageService,
 * keeping the query logic in one place. The server function is a thin wrapper
 * that bridges TanStack Start's RPC layer to the query function.
 */
export const getMeetingByBodyAndDate = createServerFn({
	method: "GET",
})
	.inputValidator((input: { bodySlug: string; date: string }) => input)
	.handler(async ({ data }) => {
		return getMeetingByBodyAndDateQuery(db, data.bodySlug, data.date);
	});
