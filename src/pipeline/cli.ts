import { Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Console, Effect, Layer, Option } from "effect";
import { Resend } from "resend";
import * as schema from "#/db/schema.ts";
import { runPipeline } from "#/pipeline/orchestrator.ts";
import { AlertServiceLive } from "#/pipeline/services/AlertService.ts";
import { FinalsiteScraperLive } from "#/pipeline/services/FinalsiteScraper.ts";
import { createGeminiSummarizer } from "#/pipeline/services/GeminiSummarizer.ts";
import { EgovScraperLive } from "#/pipeline/services/ScraperService.ts";
import { StorageServiceLive } from "#/pipeline/services/StorageService.ts";
import { SummarizationServiceLive } from "#/pipeline/services/SummarizationService.ts";
import { TranscriptionServiceLive } from "#/pipeline/services/TranscriptionService.ts";
import { YouTubeScraperLive } from "#/pipeline/services/YouTubeScraper.ts";

/**
 * Effect teaching note: This file is the composition root — the single place
 * where every real service layer is constructed with production config and
 * merged into one big Layer that the orchestrator runs against. Everything
 * below the CLI boundary (orchestrator, services) has never heard of Resend,
 * Turso, or the YouTube API; they only see their injected dependencies.
 *
 * Command.run wraps the whole tree in argv parsing + help text, then
 * NodeRuntime.runMain handles process lifecycle and exit codes.
 */

/**
 * Hardcoded governing body list for this initial CLI. Later iterations should
 * read this from the `governing_bodies` table so adding a body is a DB insert,
 * not a code change — but for the first end-to-end run, hardcoding keeps the
 * slice small.
 */
const DEFAULT_BODIES = [
	{
		slug: "ellettsville-town-council",
		name: "Ellettsville Town Council",
		egovSearchType: "12",
	},
	{
		slug: "ellettsville-plan-commission",
		name: "Ellettsville Plan Commission",
		egovSearchType: "12",
	},
	{
		slug: "monroe-county-commissioners",
		name: "Monroe County Commissioners",
		egovSearchType: "12",
	},
	{
		slug: "richland-bean-blossom-school-board",
		name: "Richland-Bean Blossom School Board",
		finalsiteUrl: "https://www.rbbschools.net/school-board",
	},
];

/**
 * Placeholder PDF extractor. Production wiring should swap this for a real
 * extractor (pdf-parse, unpdf, pdfjs-dist). Kept inline here so the CLI
 * runs end-to-end in dry-run mode without adding a new dependency as part
 * of this slice — the follow-up PDF-extraction slice will replace it.
 */
async function placeholderPdfExtract(bytes: ArrayBuffer): Promise<string> {
	return `[PDF placeholder — ${bytes.byteLength} bytes; install a PDF extractor to see real text]`;
}

function readEnv(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

function requireEnv(name: string): string {
	const value = readEnv(name);
	if (!value) {
		throw new Error(
			`Missing required environment variable: ${name}. Set it in .env.local or the shell.`,
		);
	}
	return value;
}

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
			if ("finalsiteUrl" in body && body.finalsiteUrl)
				sources.push(`finalsite`);
			if ("youtubePlaylistId" in body && body.youtubePlaylistId)
				sources.push(`youtube`);
			yield* Console.log(
				`  ${body.slug.padEnd(40)} ${body.name} [${sources.join(", ")}]`,
			);
		}
	}),
);

// ---------------------------------------------------------------------------
// Layer composition
// ---------------------------------------------------------------------------

type BuildLayersInput = { dryRun: boolean };

function buildProductionLayers(input: BuildLayersInput) {
	const databaseUrl = requireEnv("DATABASE_URL");
	const authToken = readEnv("TURSO_AUTH_TOKEN");

	const client = createClient({
		url: databaseUrl,
		...(authToken ? { authToken } : {}),
	});
	const db = drizzle(client, { schema });

	const geminiModelId = readEnv("GEMINI_MODEL") ?? "gemini-2.5-flash";
	const geminiGenerator = createGeminiSummarizer({ modelId: geminiModelId });

	const resendApiKey = input.dryRun ? undefined : readEnv("RESEND_API_KEY");
	const resendFrom =
		readEnv("RESEND_FROM") ?? "civic-mirror@alerts.example.com";
	const resendTo = readEnv("ALERT_EMAIL") ?? "ops@example.com";

	const resendClient = resendApiKey ? new Resend(resendApiKey) : null;

	const egovBaseUrl =
		readEnv("EGOV_BASE_URL") ??
		"https://ellettsville.in.us/egov/apps/document/center.egov";

	const egov = EgovScraperLive({ baseUrl: egovBaseUrl });

	const finalsite = FinalsiteScraperLive({
		baseUrl: readEnv("FINALSITE_BASE_URL") ?? "https://www.rbbschools.net",
	});

	const youtube = YouTubeScraperLive({
		apiKey: readEnv("YOUTUBE_API_KEY") ?? "missing-key",
	});

	const transcription = TranscriptionServiceLive();

	const summarization = SummarizationServiceLive({
		model: geminiModelId,
		generateFn: geminiGenerator,
	});

	const storage = StorageServiceLive(db);

	const alert = AlertServiceLive({
		to: resendTo,
		from: resendFrom,
		sendFn: resendClient
			? async ({ to, from, subject, body }) => {
					await resendClient.emails.send({
						to,
						from,
						subject,
						text: body,
					});
				}
			: async ({ subject, body }) => {
					console.log(`[alert-stub] ${subject}\n${body}`);
				},
	});

	return Layer.mergeAll(
		egov,
		finalsite,
		youtube,
		transcription,
		summarization,
		storage,
		alert,
	);
}

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
