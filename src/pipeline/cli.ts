import { Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { config as loadDotenv } from "dotenv";
import { Console, Effect, Option } from "effect";

loadDotenv({ path: [".env.local", ".env"] });

import {
	buildProductionLayers,
	DEFAULT_BODIES,
	extractPdfText,
} from "#/pipeline/composition.ts";
import {
	runDramaDetectForVideo,
	runPipeline,
} from "#/pipeline/orchestrator.ts";

/**
 * Effect teaching note: This file owns the CLI surface — `@effect/cli` Command
 * and Options definitions plus the `NodeRuntime.runMain` entrypoint — and
 * nothing else. The production layer graph, the hardcoded body list, the env
 * binding, and the real PDF extractor all live in composition.ts, so
 * changing how services are wired for production doesn't force edits past
 * a wall of Option / Command boilerplate.
 */

// ---------------------------------------------------------------------------
// `run` subcommand — full pipeline execution
// ---------------------------------------------------------------------------

const dryRun = Options.boolean("dry-run").pipe(
	Options.withDefault(false),
	Options.withDescription(
		"Run all stages except storage and alerts — safe smoke test.",
	),
);

const skipCrawlDelay = Options.boolean("skip-crawl-delay").pipe(
	Options.withDefault(false),
	Options.withDescription(
		"Skip the 300-second eGov crawl delay between downloads (local testing only).",
	),
);

const bodySlug = Options.text("body").pipe(
	Options.optional,
	Options.withDescription(
		"Only process the body with this slug (defaults to all bodies).",
	),
);

const runCommand = Command.make(
	"run",
	{ dryRun, skipCrawlDelay, bodySlug },
	({ dryRun, skipCrawlDelay, bodySlug }) =>
		Effect.gen(function* () {
			const bodies = Option.match(bodySlug, {
				onNone: () => DEFAULT_BODIES,
				onSome: (slug) => DEFAULT_BODIES.filter((b) => b.slug === slug),
			});

			if (bodies.length === 0) {
				yield* Console.error(
					`No body matched the provided --body slug. Known slugs: ${DEFAULT_BODIES.map((b) => b.slug).join(", ")}`,
				);
				return;
			}

			yield* Console.log(
				`[pipeline] starting run: bodies=${bodies.length} dryRun=${dryRun} skipCrawlDelay=${skipCrawlDelay}`,
			);

			const layers = yield* Effect.try({
				try: () => buildProductionLayers({ dryRun }),
				catch: (error) =>
					new Error(
						`Failed to construct pipeline layers: ${error instanceof Error ? error.message : String(error)}`,
					),
			});

			const result = yield* runPipeline({
				bodies,
				crawlDelayMs: skipCrawlDelay ? 0 : 300_000,
				extractPdfText,
				dryRun,
			}).pipe(Effect.provide(layers));

			yield* Console.log(
				`[pipeline] done: processed=${result.processed} errors=${result.errors}`,
			);
		}),
);

// ---------------------------------------------------------------------------
// `list-bodies` subcommand — prints the configured bodies so the operator
// can see what `run` will process without running anything.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// `drama:detect` subcommand — first-run inspection on a single YouTube video.
// Bypasses the playlist scraper so the operator can target one meeting,
// observe the structured output, and confirm Heated-band assignment on the
// RBB hiring transcript before configuring full playlist ingestion.
// ---------------------------------------------------------------------------

const detectVideoId = Options.text("video-id").pipe(
	Options.withDescription("YouTube video ID (the part after `?v=`)."),
);

const detectBodySlug = Options.text("body").pipe(
	Options.withDescription(
		"Body slug to attribute the meeting to (must exist in governing_bodies).",
	),
);

const detectTitle = Options.text("title").pipe(
	Options.optional,
	Options.withDescription(
		"Meeting title used as the prompt context (defaults to a stub).",
	),
);

const detectDate = Options.text("date").pipe(
	Options.optional,
	Options.withDescription(
		"ISO date (YYYY-MM-DD) recorded as the meeting date (defaults to today).",
	),
);

const dramaDetectCommand = Command.make(
	"drama:detect",
	{
		videoId: detectVideoId,
		bodySlug: detectBodySlug,
		title: detectTitle,
		date: detectDate,
	},
	({ videoId, bodySlug, title, date }) =>
		Effect.gen(function* () {
			const body = DEFAULT_BODIES.find((b) => b.slug === bodySlug);
			if (!body) {
				yield* Console.error(
					`Unknown body slug: ${bodySlug}. Known slugs: ${DEFAULT_BODIES.map((b) => b.slug).join(", ")}`,
				);
				return;
			}

			const resolvedTitle = Option.getOrElse(
				title,
				() => `Manual drama:detect ${videoId}`,
			);
			const resolvedDate = Option.getOrElse(date, () =>
				new Date().toISOString().slice(0, 10),
			);

			yield* Console.log(
				`[drama:detect] body=${bodySlug} videoId=${videoId} date=${resolvedDate}`,
			);

			const layers = yield* Effect.try({
				try: () => buildProductionLayers({ dryRun: false }),
				catch: (error) =>
					new Error(
						`Failed to construct pipeline layers: ${error instanceof Error ? error.message : String(error)}`,
					),
			});

			const result = yield* runDramaDetectForVideo({
				body,
				video: {
					videoId,
					title: resolvedTitle,
					publishedAt: `${resolvedDate}T00:00:00Z`,
					hasCaptions: true,
				},
			}).pipe(Effect.provide(layers));

			yield* Console.log(
				`[drama:detect] done: processed=${result.processed} errors=${result.errors}`,
			);
		}),
);

const listBodiesCommand = Command.make("list-bodies", {}, () =>
	Effect.gen(function* () {
		for (const body of DEFAULT_BODIES) {
			const sources: string[] = [];
			if (body.egovSearchType) sources.push(`egov:${body.egovSearchType}`);
			if (body.finalsiteUrl) sources.push(`finalsite`);
			if (body.youtubePlaylistId) sources.push(`youtube`);
			yield* Console.log(
				`  ${body.slug.padEnd(40)} ${body.name} [${sources.join(", ")}]`,
			);
		}
	}),
);

// ---------------------------------------------------------------------------
// Command root and entrypoint
// ---------------------------------------------------------------------------

const rootCommand = Command.make("pipeline", {}, () =>
	Console.log(
		"Civic Mirror pipeline — run `pipeline run --help` or `pipeline list-bodies`.",
	),
).pipe(
	Command.withSubcommands([runCommand, listBodiesCommand, dramaDetectCommand]),
);

const cli = Command.run(rootCommand, {
	name: "Civic Mirror Pipeline",
	version: "0.1.0",
});

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
