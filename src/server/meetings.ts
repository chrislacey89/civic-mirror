import { createServerFn } from "@tanstack/react-start";
import { db } from "#/db/index.ts";
import {
	aggregateFiscalByBodyQuery,
	aggregateFiscalByCategoryQuery,
	aggregateFiscalByTimePeriodQuery,
	getMeetingByBodyAndDateQuery,
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

export const listGoverningBodies = createServerFn({
	method: "GET",
}).handler(async () => {
	return await listGoverningBodiesQuery(db);
});
