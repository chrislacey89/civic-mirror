import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { config as loadDotenv } from "dotenv";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

loadDotenv({ path: [".env.local", ".env"] });

import {
	buildProductionLayers,
	DEFAULT_BODIES,
	extractPdfText,
} from "#/pipeline/composition.ts";
import { resolveDetectMeeting } from "#/pipeline/detect-date.ts";
import {
	runDramaDetectForVideo,
	runPipeline,
} from "#/pipeline/orchestrator.ts";

/**
 * Effect teaching note: This file owns the CLI surface — `effect/cli` Command
 * and Flag definitions plus the `NodeRuntime.runMain` entrypoint — and
 * nothing else. The production layer graph, the hardcoded body list, the env
 * binding, and the real PDF extractor all live in composition.ts, so
 * changing how services are wired for production doesn't force edits past
 * a wall of Option / Command boilerplate.
 */

// ---------------------------------------------------------------------------
// `run` subcommand — full pipeline execution
// ---------------------------------------------------------------------------

const dryRun = Flag.Boolean("dry-run").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Run all stages except storage and alerts — safe smoke test.",
	),
);

const skipCrawlDelay = Flag.Boolean("skip-crawl-delay").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Skip the 300-second eGov crawl delay between downloads (local testing only).",
	),
);

const bodySlug = Flag.String("body").pipe(
	Flag.optional,
	Flag.withDescription(
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

const detectVideoId = Flag.String("video-id").pipe(
	Flag.withDescription("YouTube video ID (the part after `?v=`)."),
);

const detectBodySlug = Flag.String("body").pipe(
	Flag.withDescription(
		"Body slug to attribute the meeting to (must exist in governing_bodies).",
	),
);

const detectTitle = Flag.String("title").pipe(
	Flag.optional,
	Flag.withDescription(
		"Meeting title used as the prompt context (defaults to a stub).",
	),
);

const detectDate = Flag.String("date").pipe(
	Flag.optional,
	Flag.withDescription(
		"ISO date (YYYY-MM-DD) recorded as the meeting date. Required unless --title carries the date.",
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

			// The meeting date is half of the meeting's key, so a run with no
			// date to read stops here instead of filing the video under today.
			const { title: resolvedTitle, meetingDate: resolvedDate } =
				resolveDetectMeeting({ videoId, date, title });
			if (resolvedDate === null) {
				yield* Console.error(
					"No meeting date: pass --date YYYY-MM-DD, or a --title that carries the date.",
				);
				return;
			}

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
				video: { videoId, title: resolvedTitle },
				meetingDate: resolvedDate,
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

Command.run(rootCommand, { version: "0.1.0" }).pipe(
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
