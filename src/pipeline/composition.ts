import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Layer } from "effect";
import { Resend } from "resend";
import { resolveDatabaseUrl } from "#/db/database-url.ts";
import * as schema from "#/db/schema.ts";
import {
	type BodyConfig,
	PIPELINE_SOURCES,
	type PipelineSource,
} from "#/pipeline/orchestrator.ts";
import { AlertServiceLive } from "#/pipeline/services/AlertService.ts";
import { DramaDetectionServiceLive } from "#/pipeline/services/DramaDetectionService.ts";
import { FinalsiteScraperLive } from "#/pipeline/services/FinalsiteScraper.ts";
import { createGeminiDramaDetector } from "#/pipeline/services/GeminiDramaDetector.ts";
import { createGeminiMeetingMatcher } from "#/pipeline/services/GeminiMeetingMatcher.ts";
import { createGeminiSummarizer } from "#/pipeline/services/GeminiSummarizer.ts";
import { MeetingMatchServiceLive } from "#/pipeline/services/MeetingMatchService.ts";
import { extractPdfText } from "#/pipeline/services/PdfExtractor.ts";
import { EgovScraperLive } from "#/pipeline/services/ScraperService.ts";
import { StorageServiceLive } from "#/pipeline/services/StorageService.ts";
import { SummarizationServiceLive } from "#/pipeline/services/SummarizationService.ts";
import { YouTubeCaptionProviderLive } from "#/pipeline/services/TranscriptionService.ts";
import { YouTubeScraperLive } from "#/pipeline/services/YouTubeScraper.ts";
import { v2 as dramaProfile } from "../../evals/profiles/v2.ts";

/**
 * Effect teaching note: This file is the composition root — the single place
 * where every real service layer is constructed with production config and
 * merged into one big Layer that the orchestrator runs against. Everything
 * below the CLI boundary (orchestrator, services) has never heard of Resend,
 * Turso, or the YouTube API; they only see their injected dependencies.
 *
 * Separating the composition root from cli.ts means the CLI file owns only
 * command shapes and `NodeRuntime.runMain` wiring — the layer graph, the
 * body list, and the env binding all live here where they can be read and
 * maintained without navigating past `effect/cli` Flag/Command boilerplate.
 */

/**
 * Hardcoded governing body list for this initial CLI. Later iterations should
 * read this from the `governing_bodies` table so adding a body is a DB insert,
 * not a code change — but for the first end-to-end run, hardcoding keeps the
 * slice small.
 */
const DEFAULT_BODIES: BodyConfig[] = [
	{
		slug: "ellettsville-town-council",
		name: "Ellettsville Town Council",
		egovSearchType: "12",
		egovTitlePattern: /^Town Council/i,
		// The body's own CATS playlist. The start date is the first meeting
		// whose video is taken; earlier recordings in the playlist are ignored.
		youtubePlaylistId: "PLLKIocQNuYstrABBQ0PL_J-B_op4n6Mxo",
		youtubeTitlePrefix: "Ellettsville Town Council",
		youtubeSince: "2025-05-27",
	},
	{
		slug: "ellettsville-plan-commission",
		name: "Ellettsville Plan Commission",
		egovSearchType: "12",
		egovTitlePattern: /^Plan Commission/i,
	},
	{
		// Monroe County lives on its own eGov portal, not Ellettsville's — a
		// per-body base URL is a separate concern tracked outside #35. Until
		// that lands, this pattern guarantees zero cross-pollination: no row
		// on the Ellettsville portal starts with "Monroe County", so the
		// filter drops them all instead of misattributing them.
		slug: "monroe-county-commissioners",
		name: "Monroe County Commissioners",
		egovSearchType: "12",
		egovTitlePattern: /^Monroe County/i,
	},
	{
		slug: "rbb-school-board",
		name: "Richland-Bean Blossom School Board",
		finalsiteUrl: "https://www.rbbschools.net/school-board",
	},
];

function readEnv(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

// `aliases` are additional accepted names, tried in order after `name`. They
// exist so a canonical variable can be renamed without breaking a deployment
// that still sets the old name, and so the error names every name that works.
function requireEnv(name: string, ...aliases: string[]): string {
	for (const candidate of [name, ...aliases]) {
		const value = readEnv(candidate);
		if (value) return value;
	}
	throw new Error(
		`Missing required environment variable: ${[name, ...aliases].join(" or ")}. Set it in .env.local or the shell.`,
	);
}

type SourcesFlagReading =
	| { ok: true; sources: PipelineSource[] }
	| { ok: false; unknown: string[] };

/**
 * Reads the `--sources` value, a comma-separated list of source paths. A
 * list with an unknown entry, or with no entries, is refused whole; `unknown`
 * names the entries that are not source paths.
 */
function parseSourcesFlag(raw: string): SourcesFlagReading {
	const entries = [
		...new Set(
			raw
				.split(",")
				.map((entry) => entry.trim().toLowerCase())
				.filter((entry) => entry !== ""),
		),
	];
	const isSource = (entry: string): entry is PipelineSource =>
		(PIPELINE_SOURCES as readonly string[]).includes(entry);
	const sources = entries.filter(isSource);
	if (sources.length === 0 || sources.length !== entries.length) {
		return { ok: false, unknown: entries.filter((e) => !isSource(e)) };
	}
	return { ok: true, sources };
}

type BuildLayersInput = { dryRun: boolean };

function buildProductionLayers(input: BuildLayersInput) {
	// Resolved by the same shared helper as src/db/index.ts and
	// src/db/seed.ts, so the DATABASE_URL / TURSO_DATABASE_URL fallback rule
	// (including the empty-string case) can't diverge between them again.
	const databaseUrl = resolveDatabaseUrl();
	if (!databaseUrl) {
		throw new Error(
			"Missing required environment variable: DATABASE_URL or TURSO_DATABASE_URL. Set it in .env.local or the shell.",
		);
	}
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

	// Captions only: a caption failure surfaces as that failure. The Whisper
	// fallback in TranscriptionServiceLive shells out to yt-dlp/ffmpeg, which
	// is out of scope for the pipeline (and would mask a blocked fetch as a
	// spawn error).
	const transcription = YouTubeCaptionProviderLive();

	const summarization = SummarizationServiceLive({
		model: geminiModelId,
		generateFn: geminiGenerator,
	});

	const meetingMatch = MeetingMatchServiceLive({
		decideFn: createGeminiMeetingMatcher({ modelId: geminiModelId }),
	});

	const dramaDetector = createGeminiDramaDetector({
		modelId: geminiModelId,
		promptVersion: dramaProfile.promptVersion,
		systemPrompt: dramaProfile.systemPrompt,
		...(dramaProfile.temperature !== undefined
			? { temperature: dramaProfile.temperature }
			: {}),
		...(dramaProfile.thinkingBudget !== undefined
			? { thinkingBudget: dramaProfile.thinkingBudget }
			: {}),
		...(dramaProfile.includeThoughts !== undefined
			? { includeThoughts: dramaProfile.includeThoughts }
			: {}),
	});
	const dramaDetection = DramaDetectionServiceLive({
		model: geminiModelId,
		promptVersion: dramaProfile.promptVersion,
		generateFn: dramaDetector,
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
		meetingMatch,
		dramaDetection,
		storage,
		alert,
	);
}

export {
	DEFAULT_BODIES,
	extractPdfText,
	parseSourcesFlag,
	readEnv,
	requireEnv,
	buildProductionLayers,
};
export type { BuildLayersInput };
