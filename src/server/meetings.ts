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
		return getMeetingByBodyAndDateQuery(db, data.bodySlug, data.date);
	});

export const listRecentMeetings = createServerFn({
	method: "GET",
})
	.inputValidator((input: { bodySlug?: string; limit?: number }) => input)
	.handler(async ({ data }) => {
		return listRecentMeetingsQuery(db, data.bodySlug, data.limit);
	});

export const aggregateFiscalByBody = createServerFn({
	method: "GET",
}).handler(async () => {
	return aggregateFiscalByBodyQuery(db);
});

export const aggregateFiscalByCategory = createServerFn({
	method: "GET",
}).handler(async () => {
	return aggregateFiscalByCategoryQuery(db);
});

export const aggregateFiscalByTimePeriod = createServerFn({
	method: "GET",
}).handler(async () => {
	return aggregateFiscalByTimePeriodQuery(db);
});

export const listNotableFiscalDecisions = createServerFn({
	method: "GET",
})
	.inputValidator((input: { limit?: number }) => input)
	.handler(async ({ data }) => {
		return listNotableFiscalDecisionsQuery(db, data.limit);
	});

export const listGoverningBodies = createServerFn({
	method: "GET",
}).handler(async () => {
	return listGoverningBodiesQuery(db);
});
