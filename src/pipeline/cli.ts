import { Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { config as loadDotenv } from "dotenv";
import { Console, Effect, Option } from "effect";

loadDotenv({ path: [".env.local", ".env"] });

import {
	buildProductionLayers,
	DEFAULT_BODIES,
	placeholderPdfExtract,
} from "#/pipeline/composition.ts";
import { runPipeline } from "#/pipeline/orchestrator.ts";

/**
 * Effect teaching note: This file owns the CLI surface — `@effect/cli` Command
 * and Options definitions plus the `NodeRuntime.runMain` entrypoint — and
 * nothing else. The production layer graph, the hardcoded body list, the env
 * binding, and the placeholder PDF extractor all live in composition.ts, so
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
				extractPdfText: placeholderPdfExtract,
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
).pipe(Command.withSubcommands([runCommand, listBodiesCommand]));

const cli = Command.run(rootCommand, {
	name: "Civic Mirror Pipeline",
	version: "0.1.0",
});

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
