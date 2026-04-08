import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { db } from "#/db/index.ts";
import * as schema from "#/db/schema.ts";

export const getMeetingByBodyAndDate = createServerFn({
	method: "GET",
})
	.inputValidator((input: { bodySlug: string; date: string }) => input)
	.handler(async ({ data }) => {
		const body = db
			.select()
			.from(schema.governingBodies)
			.where(eq(schema.governingBodies.slug, data.bodySlug))
			.get();

		if (!body) return null;

		const meeting = db
			.select()
			.from(schema.meetings)
			.where(
				and(
					eq(schema.meetings.bodyId, body.id),
					eq(schema.meetings.date, data.date),
				),
			)
			.get();

		if (!meeting) return null;

		const docs = db
			.select()
			.from(schema.documents)
			.where(eq(schema.documents.meetingId, meeting.id))
			.all();

		const summary = db
			.select()
			.from(schema.summaries)
			.where(eq(schema.summaries.meetingId, meeting.id))
			.get();

		if (!summary) return null;

		const fiscals = db
			.select()
			.from(schema.fiscalDecisions)
			.where(eq(schema.fiscalDecisions.meetingId, meeting.id))
			.all();

		const discussions = db
			.select()
			.from(schema.budgetDiscussions)
			.where(eq(schema.budgetDiscussions.meetingId, meeting.id))
			.all();

		return {
			id: meeting.id,
			date: meeting.date,
			meetingType: meeting.meetingType,
			bodyName: body.name,
			bodySlug: body.slug,
			documents: docs.map((d) => ({
				sourceUrl: d.sourceUrl,
				rawText: d.rawText,
				documentType: d.documentType,
			})),
			summary: {
				highlights: summary.highlights as string[],
				prose: summary.prose,
				model: summary.model,
			},
			fiscalDecisions: fiscals.map((f) => ({
				title: f.title,
				description: f.description,
				amount: f.amount,
				originalAmount: f.originalAmount,
				budgetCategory: f.budgetCategory,
				status: f.status,
				voteRecord: f.voteRecord as {
					yea: number;
					nay: number;
					abstain: number;
				} | null,
				vendor: f.vendor,
				fundingSource: f.fundingSource,
				ordinanceNumber: f.ordinanceNumber,
				confidence: f.confidence,
				isRecurring: f.isRecurring,
			})),
			budgetDiscussions: discussions.map((bd) => ({
				topic: bd.topic,
				estimatedAmount: bd.estimatedAmount,
				notes: bd.notes,
			})),
		};
	});
