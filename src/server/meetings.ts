import { createServerFn } from "@tanstack/react-start";
import { db } from "#/db/index.ts";
import {
	aggregateFiscalByBodyQuery,
	aggregateFiscalByCategoryForBodyQuery,
	aggregateFiscalByCategoryQuery,
	aggregateFiscalByTimePeriodQuery,
	getMeetingByBodyAndDateQuery,
	listBodiesWithStatsQuery,
	listFiscalDecisionsQuery,
	listGoverningBodiesQuery,
	listNotableFiscalDecisionsQuery,
	listRecentMeetingsQuery,
} from "#/db/queries.ts";

export const getMeetingByBodyAndDate = createServerFn({
	method: "GET",
})
	.inputValidator((input: { bodySlug: string; date: string }) => input)
	.handler(async ({ data }) => {
		return await getMeetingByBodyAndDateQuery(db, data.bodySlug, data.date);
	});

export const listRecentMeetings = createServerFn({
	method: "GET",
})
	.inputValidator((input: { bodySlug?: string; limit?: number }) => input)
	.handler(async ({ data }) => {
		return await listRecentMeetingsQuery(db, data.bodySlug, data.limit);
	});

export const aggregateFiscalByBody = createServerFn({
	method: "GET",
}).handler(async () => {
	return await aggregateFiscalByBodyQuery(db);
});

export const aggregateFiscalByCategory = createServerFn({
	method: "GET",
}).handler(async () => {
	return await aggregateFiscalByCategoryQuery(db);
});

export const aggregateFiscalByTimePeriod = createServerFn({
	method: "GET",
}).handler(async () => {
	return await aggregateFiscalByTimePeriodQuery(db);
});

export const listNotableFiscalDecisions = createServerFn({
	method: "GET",
})
	.inputValidator((input: { limit?: number }) => input)
	.handler(async ({ data }) => {
		return await listNotableFiscalDecisionsQuery(db, data.limit);
	});

export const listFiscalDecisions = createServerFn({
	method: "GET",
})
	.inputValidator(
		(input: { bodySlug?: string; category?: string; period?: string }) => input,
	)
	.handler(async ({ data }) => {
		return await listFiscalDecisionsQuery(db, data);
	});

export const listGoverningBodies = createServerFn({
	method: "GET",
}).handler(async () => {
	return await listGoverningBodiesQuery(db);
});

export const listBodiesWithStats = createServerFn({
	method: "GET",
}).handler(async () => {
	return await listBodiesWithStatsQuery(db);
});

export const aggregateFiscalByCategoryForBody = createServerFn({
	method: "GET",
})
	.inputValidator((input: { bodySlug: string }) => input)
	.handler(async ({ data }) => {
		return await aggregateFiscalByCategoryForBodyQuery(db, data.bodySlug);
	});
