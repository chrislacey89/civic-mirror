import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { config as loadDotenv } from "dotenv";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

loadDotenv({ path: [".env.local", ".env"] });

import { resolveDatabaseUrl } from "#/db/database-url.ts";
import {
	buildProductionLayers,
	DEFAULT_BODIES,
	extractPdfText,
	parseSourcesFlag,
} from "#/pipeline/composition.ts";
import { detachDocumentAndRegenerate } from "#/pipeline/detach.ts";
import { resolveDetectMeeting } from "#/pipeline/detect-date.ts";
import { formatHeldVideoLine } from "#/pipeline/held.ts";
import {
	PIPELINE_SOURCES,
	runDramaDetectForVideo,
	runPipeline,
} from "#/pipeline/orchestrator.ts";
import { regenerateSummariesOnDates } from "#/pipeline/regenerate.ts";
import { StorageService } from "#/pipeline/services/StorageService.ts";

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

const sources = Flag.String("sources").pipe(
	Flag.optional,
	Flag.withDescription(
		`Comma-separated source paths to run: ${PIPELINE_SOURCES.join(", ")} (defaults to all).`,
	),
);

const runCommand = Command.make(
	"run",
	{ dryRun, skipCrawlDelay, bodySlug, sources },
	({ dryRun, skipCrawlDelay, bodySlug, sources }) =>
		Effect.gen(function* () {
			const sourcesReading = Option.match(sources, {
				onNone: () => ({ ok: true as const, sources: [...PIPELINE_SOURCES] }),
				onSome: parseSourcesFlag,
			});
			// A mistyped list fails the run. Exiting cleanly would let a dispatched
			// run that did nothing show as passed.
			if (!sourcesReading.ok) {
				const unknown =
					sourcesReading.unknown.length > 0
						? ` Not a source: ${sourcesReading.unknown.join(", ")}.`
						: "";
				return yield* Effect.fail(
					new Error(
						`--sources takes a comma-separated list of: ${PIPELINE_SOURCES.join(", ")}.${unknown}`,
					),
				);
			}

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
				`[pipeline] starting run: bodies=${bodies.length} sources=${sourcesReading.sources.join(",")} dryRun=${dryRun} skipCrawlDelay=${skipCrawlDelay}`,
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
				sources: sourcesReading.sources,
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
// `held:list` subcommand — prints the videos the pipeline holds and why, one
// per line.
// ---------------------------------------------------------------------------

const heldBodySlug = Flag.String("body").pipe(
	Flag.optional,
	Flag.withDescription(
		"Only list videos held for the body with this slug (defaults to all bodies).",
	),
);

const heldListCommand = Command.make(
	"held:list",
	{ bodySlug: heldBodySlug },
	({ bodySlug }) =>
		Effect.gen(function* () {
			const layers = yield* Effect.try({
				try: () => buildProductionLayers({ dryRun: false }),
				catch: (error) =>
					new Error(
						`Failed to construct pipeline layers: ${error instanceof Error ? error.message : String(error)}`,
					),
			});

			const held = yield* Effect.gen(function* () {
				const storage = yield* StorageService;
				return yield* storage.listHeldVideos(
					Option.match(bodySlug, {
						onNone: () => ({}),
						onSome: (slug) => ({ bodySlug: slug }),
					}),
				);
			}).pipe(Effect.provide(layers));

			if (held.length === 0) {
				yield* Console.error("No held videos.");
				return;
			}
			for (const video of held) {
				yield* Console.log(formatHeldVideoLine(video));
			}
		}),
);

// ---------------------------------------------------------------------------
// `document:detach` subcommand — removes one document from a meeting and
// rebuilds the meeting's summary from the sources that remain. For a document
// the source filed under the wrong meeting. Reports what it would do until
// `--confirm` is passed.
// ---------------------------------------------------------------------------

const detachBodySlug = Flag.String("body").pipe(
	Flag.withDescription("Slug of the body whose meeting holds the document."),
);

const detachMeetingDate = Flag.String("date").pipe(
	Flag.withDescription("ISO date (YYYY-MM-DD) of the meeting."),
);

const detachSession = Flag.String("session").pipe(
	Flag.withDefault(""),
	Flag.withDescription(
		"Session slug of the meeting (defaults to the meeting stored without one).",
	),
);

const detachUrl = Flag.String("url").pipe(
	Flag.withDescription("Source URL of the document, as stored."),
);

const detachConfirm = Flag.Boolean("confirm").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Delete the document and rebuild the summary. Without it, nothing is written.",
	),
);

const documentDetachCommand = Command.make(
	"document:detach",
	{
		bodySlug: detachBodySlug,
		date: detachMeetingDate,
		session: detachSession,
		url: detachUrl,
		confirm: detachConfirm,
	},
	({ bodySlug, date, session, url, confirm }) =>
		Effect.gen(function* () {
			const body = DEFAULT_BODIES.find((b) => b.slug === bodySlug);
			if (!body) {
				return yield* Effect.fail(
					new Error(
						`Unknown body slug: ${bodySlug}. Known slugs: ${DEFAULT_BODIES.map((b) => b.slug).join(", ")}`,
					),
				);
			}

			const layers = yield* Effect.try({
				try: () => buildProductionLayers({ dryRun: false }),
				catch: (error) =>
					new Error(
						`Failed to construct pipeline layers: ${error instanceof Error ? error.message : String(error)}`,
					),
			});

			yield* Effect.gen(function* () {
				const storage = yield* StorageService;
				const meeting = yield* storage.getMeetingSourceState({
					bodySlug,
					date,
					session,
				});
				if (meeting === null) {
					return yield* Effect.fail(
						new Error(
							`No meeting for ${bodySlug} on ${date} with session ${JSON.stringify(session)}.`,
						),
					);
				}

				const held = yield* storage.getMeetingSources(meeting.meetingId);
				yield* Console.log(
					`[document:detach] target=${(resolveDatabaseUrl() ?? "").replace(/\?.*$/, "")}`,
				);
				yield* Console.log(
					`[document:detach] meeting id=${meeting.meetingId} body=${bodySlug} date=${date} session=${JSON.stringify(session)}`,
				);
				for (const document of held.documents) {
					const action = document.sourceUrl === url ? "detach" : "keep  ";
					const opening = document.rawText.replace(/\s+/g, " ").slice(0, 60);
					yield* Console.log(
						`  ${action} ${document.sourceUrl} ${JSON.stringify(opening)}`,
					);
				}
				if (held.transcript) {
					yield* Console.log(`  keep   ${held.transcript.sourceUrl}`);
				}

				if (!confirm) {
					yield* Console.log(
						held.documents.some((d) => d.sourceUrl === url)
							? "[document:detach] dry run. Re-run with --confirm to detach and rebuild the summary."
							: "[document:detach] dry run. The meeting holds no document under that URL; --confirm would only rebuild a summary that is behind its sources.",
					);
					return;
				}

				const result = yield* detachDocumentAndRegenerate({
					meetingId: meeting.meetingId,
					sourceUrl: url,
					meetingContext: `${body.name}, ${date}`,
				});
				if (result.outcome === "last-source") {
					return yield* Effect.fail(
						new Error(
							"That document is the last source this meeting's summary can be built from. Nothing was removed; delete the meeting with src/pipeline/scripts/delete-meeting.ts instead.",
						),
					);
				}
				yield* Console.log(
					`[document:detach] done: outcome=${result.outcome} regenerated=${result.regenerated}`,
				);
			}).pipe(Effect.provide(layers));
		}),
);

// ---------------------------------------------------------------------------
// `summaries:regenerate` subcommand — rebuilds the stored summary of a body's
// meetings on the given dates from the sources they already hold. `run`
// leaves a summary alone while its sources are unchanged, so this is how
// summaries are rebuilt after the summarizer itself changes.
// ---------------------------------------------------------------------------

const regenerateBodySlug = Flag.String("body").pipe(
	Flag.withDescription("Slug of the body whose meetings to rebuild."),
);

const regenerateDates = Flag.String("dates").pipe(
	Flag.withDescription(
		"Comma-separated meeting dates (YYYY-MM-DD) whose summaries to rebuild.",
	),
);

const regenerateConfirm = Flag.Boolean("confirm").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Replace the stored summaries. Without it, the rebuilt decisions are shown beside the stored ones and nothing is written.",
	),
);

const summariesRegenerateCommand = Command.make(
	"summaries:regenerate",
	{
		bodySlug: regenerateBodySlug,
		dates: regenerateDates,
		confirm: regenerateConfirm,
	},
	({ bodySlug, dates, confirm }) =>
		Effect.gen(function* () {
			const body = DEFAULT_BODIES.find((b) => b.slug === bodySlug);
			if (body === undefined) {
				return yield* Effect.fail(
					new Error(
						`No body matched --body ${bodySlug}. Known slugs: ${DEFAULT_BODIES.map((b) => b.slug).join(", ")}`,
					),
				);
			}
			const dateList = dates
				.split(",")
				.map((date) => date.trim())
				.filter((date) => date !== "");
			const malformed = dateList.filter(
				(date) => !/^\d{4}-\d{2}-\d{2}$/.test(date),
			);
			if (dateList.length === 0 || malformed.length > 0) {
				return yield* Effect.fail(
					new Error(
						`--dates takes a comma-separated list of YYYY-MM-DD dates.${malformed.length > 0 ? ` Not a date: ${malformed.join(", ")}.` : ""}`,
					),
				);
			}

			const layers = yield* Effect.try({
				try: () => buildProductionLayers({ dryRun: false }),
				catch: (error) =>
					new Error(
						`Failed to construct pipeline layers: ${error instanceof Error ? error.message : String(error)}`,
					),
			});

			yield* Console.log(
				`[summaries:regenerate] target=${(resolveDatabaseUrl() ?? "").replace(/\?.*$/, "")}`,
			);
			const outcomes = yield* regenerateSummariesOnDates({
				body,
				dates: dateList,
				confirm,
			}).pipe(Effect.provide(layers));

			for (const outcome of outcomes) {
				yield* Console.log(
					`${outcome.date} ${outcome.outcome}${outcome.outcome === "failed" ? `: ${outcome.message}` : ""}`,
				);
				if (outcome.outcome === "previewed") {
					for (const label of outcome.stored) {
						yield* Console.log(
							`  stored  ${label}${outcome.rebuilt.includes(label) ? "" : "  (not in rebuilt)"}`,
						);
					}
					for (const label of outcome.rebuilt) {
						yield* Console.log(
							`  rebuilt ${label}${outcome.stored.includes(label) ? "" : "  (new)"}`,
						);
					}
				}
			}
			if (!confirm) {
				yield* Console.log(
					"[summaries:regenerate] preview. Re-run with --confirm to replace the stored summaries.",
				);
			}
			// Anything short of a rebuilt summary fails the command, so a run that
			// skipped a date cannot pass for one that rebuilt them all.
			const notRebuilt = outcomes.filter(
				(outcome) =>
					outcome.outcome !== (confirm ? "regenerated" : "previewed"),
			);
			if (notRebuilt.length > 0) {
				return yield* Effect.fail(
					new Error(
						`${notRebuilt.length} of ${outcomes.length} summaries were not rebuilt.`,
					),
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
	Command.withSubcommands([
		runCommand,
		listBodiesCommand,
		dramaDetectCommand,
		heldListCommand,
		documentDetachCommand,
		summariesRegenerateCommand,
	]),
);

Command.run(rootCommand, { version: "0.1.0" }).pipe(
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
