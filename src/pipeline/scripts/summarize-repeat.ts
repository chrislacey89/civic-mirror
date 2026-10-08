/**
 * Summarizes one stored meeting several times and prints each run's fiscal
 * decisions and source disagreements, so run-to-run differences can be seen
 * before a prompt or summarizer change is trusted. It reads the meeting's
 * stored sources and calls the model; it writes nothing.
 *
 *   pnpm tsx src/pipeline/scripts/summarize-repeat.ts <body-slug> <YYYY-MM-DD> [runs]
 *
 * Exits 1 when the runs disagree on any decision's amount or status.
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/libsql";
import { Effect, Layer } from "effect";
import { resolveDatabaseUrl } from "#/db/database-url.ts";
import * as schema from "#/db/schema.ts";
import { DEFAULT_BODIES } from "#/pipeline/composition.ts";
import { createGeminiSummarizer } from "#/pipeline/services/GeminiSummarizer.ts";
import {
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";
import {
	SummarizationService,
	SummarizationServiceLive,
} from "#/pipeline/services/SummarizationService.ts";
import { readableSources } from "#/pipeline/sources.ts";

config({ path: [".env.local", ".env"] });

const [bodySlug, date, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 5);
const body = DEFAULT_BODIES.find((candidate) => candidate.slug === bodySlug);
if (!body || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !(runs >= 1)) {
	console.error(
		"usage: summarize-repeat.ts <body-slug> <YYYY-MM-DD> [runs]\n" +
			`known slugs: ${DEFAULT_BODIES.map((candidate) => candidate.slug).join(", ")}`,
	);
	process.exit(2);
}

const client = createClient({
	url: resolveDatabaseUrl() ?? "",
	...(process.env.TURSO_AUTH_TOKEN
		? { authToken: process.env.TURSO_AUTH_TOKEN }
		: {}),
});
const modelId = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const layers = Layer.mergeAll(
	StorageServiceLive(drizzle(client, { schema })),
	SummarizationServiceLive({
		model: modelId,
		generateFn: createGeminiSummarizer({ modelId }),
	}),
);

const summaries = await Effect.runPromise(
	Effect.gen(function* () {
		const storage = yield* StorageService;
		const summarizer = yield* SummarizationService;
		const meeting = yield* storage.getMeetingSourceState({
			bodySlug: body.slug,
			date,
			session: "",
		});
		if (meeting === null) return null;
		const sources = readableSources(
			yield* storage.getMeetingSources(meeting.meetingId),
		);
		return yield* Effect.forEach(
			Array.from({ length: runs }),
			() =>
				summarizer.summarize({
					sources,
					meetingContext: `${body.name}, ${date}`,
				}),
			{ concurrency: runs },
		);
	}).pipe(Effect.provide(layers)),
);

if (summaries === null) {
	console.error(`no meeting stored for ${body.slug} on ${date}`);
	process.exit(2);
}

/** A run's decisions as comparable lines: what was decided and for how much, without the wording. */
const fingerprints = summaries.map((summary) =>
	summary.fiscalDecisions
		.map(
			(decision) =>
				`${decision.status} ${decision.amount} ${decision.ordinanceNumber ?? ""}`,
		)
		.sort()
		.join("\n"),
);

summaries.forEach((summary, run) => {
	console.log(`\nrun ${run + 1}`);
	for (const decision of summary.fiscalDecisions) {
		console.log(
			`  ${decision.status}  ${decision.amount}  (${decision.originalAmount})  ${decision.title}`,
		);
	}
	for (const disagreement of summary.sourceDisagreements) {
		console.log(
			`  disagreement  ${disagreement.topic}: ${disagreement.documentsSay} / ${disagreement.transcriptSays}`,
		);
	}
});

const distinct = new Set(fingerprints).size;
console.log(
	`\n${runs} run(s), ${distinct} distinct set(s) of decisions by status, amount and ordinance number`,
);
process.exit(distinct === 1 ? 0 : 1);
