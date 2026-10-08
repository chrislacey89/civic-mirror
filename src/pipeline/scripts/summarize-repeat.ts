/**
 * Summarizes one stored meeting several times and prints each run's fiscal
 * decisions and source disagreements, so run-to-run differences can be seen
 * before a prompt or summarizer change is trusted. It reads the meeting's
 * stored sources and calls the model; it writes nothing.
 *
 *   pnpm tsx src/pipeline/scripts/summarize-repeat.ts <body-slug> <YYYY-MM-DD> [runs]
 *
 * Exit codes:
 *   0  every run gave the same decisions
 *   1  the runs disagree on a decision's amount, status or ordinance number
 *   2  bad usage, or no stored meeting for that body and date
 *   3  a model or database call failed, so the runs could not all be compared;
 *      the failed runs are printed and nothing is compared
 */
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/libsql";
import { Effect, Layer, Result } from "effect";
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
import { EXIT_FAILED, judgeRuns } from "./summarize-repeat-verdict.ts";

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

const attempt = await Effect.runPromise(
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
				summarizer
					.summarize({
						sources,
						meetingContext: `${body.name}, ${date}`,
					})
					.pipe(Effect.result),
			{ concurrency: runs },
		);
	}).pipe(Effect.provide(layers), Effect.result),
);

if (Result.isFailure(attempt)) {
	console.error(
		`could not load the meeting: ${attempt.failure.message}; nothing was compared`,
	);
	process.exit(EXIT_FAILED);
}
const results = attempt.success;

if (results === null) {
	console.error(`no meeting stored for ${body.slug} on ${date}`);
	process.exit(2);
}

results.forEach((result, run) => {
	console.log(`\nrun ${run + 1}`);
	if (Result.isFailure(result)) {
		console.log(`  failed  ${result.failure.message}`);
		return;
	}
	const summary = result.success;
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

const verdict = judgeRuns(
	results.map((result) =>
		Result.isFailure(result)
			? { failure: result.failure.message }
			: { decisions: result.success.fiscalDecisions },
	),
);
if (verdict.distinct === null) {
	console.error(
		`\n${verdict.failedRuns.length} of ${runs} run(s) failed (${verdict.failedRuns.map((failed) => failed.run).join(", ")}); nothing was compared`,
	);
} else {
	console.log(
		`\n${runs} run(s), ${verdict.distinct} distinct set(s) of decisions by status, amount and ordinance number`,
	);
}
process.exit(verdict.exitCode);
