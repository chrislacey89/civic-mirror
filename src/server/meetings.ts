import { createServerFn } from "@tanstack/react-start";
import { db } from "#/db/index.ts";
import { getMeetingByBodyAndDateQuery } from "#/db/queries.ts";

/**
 * Server function to load a meeting's full detail by governing body slug and date.
 *
 * Delegates to the shared `getMeetingByBodyAndDateQuery` from db/queries,
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
