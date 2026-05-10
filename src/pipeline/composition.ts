import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Layer } from "effect";
import { Resend } from "resend";
import * as schema from "#/db/schema.ts";
import { AlertServiceLive } from "#/pipeline/services/AlertService.ts";
import { DramaDetectionServiceLive } from "#/pipeline/services/DramaDetectionService.ts";
import { FinalsiteScraperLive } from "#/pipeline/services/FinalsiteScraper.ts";
import { createGeminiDramaDetector } from "#/pipeline/services/GeminiDramaDetector.ts";
import { createGeminiSummarizer } from "#/pipeline/services/GeminiSummarizer.ts";
import { extractPdfText } from "#/pipeline/services/PdfExtractor.ts";
import { EgovScraperLive } from "#/pipeline/services/ScraperService.ts";
import { StorageServiceLive } from "#/pipeline/services/StorageService.ts";
import { SummarizationServiceLive } from "#/pipeline/services/SummarizationService.ts";
import { TranscriptionServiceLive } from "#/pipeline/services/TranscriptionService.ts";
import { YouTubeScraperLive } from "#/pipeline/services/YouTubeScraper.ts";
import { v1 as dramaProfileV1 } from "../../evals/profiles/v1.ts";

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
 * maintained without navigating past `@effect/cli` Option/Command boilerplate.
 */

/**
 * A governing-body entry in the hardcoded list. Exactly one source field
 * should be present per body — the union is kept open-ended here rather
 * than via a discriminated union because bodies may eventually aggregate
 * multiple sources (e.g. a body with both an eGov listing and a YouTube
 * playlist).
 */
type BodyConfigEntry = {
	slug: string;
	name: string;
	egovSearchType?: string;
	/**
	 * Required for any body sharing an `egovSearchType` with another body. The
	 * eGov document-center page at searchType=12 returns every "minutes" row
	 * from the portal regardless of which body produced it, so the orchestrator
	 * uses this pattern to drop rows that belong to a sibling. See #35.
	 */
	egovTitlePattern?: RegExp;
	finalsiteUrl?: string;
	youtubePlaylistId?: string;
};

/**
 * Hardcoded governing body list for this initial CLI. Later iterations should
 * read this from the `governing_bodies` table so adding a body is a DB insert,
 * not a code change — but for the first end-to-end run, hardcoding keeps the
 * slice small.
 */
const DEFAULT_BODIES: BodyConfigEntry[] = [
	{
		slug: "ellettsville-town-council",
		name: "Ellettsville Town Council",
		egovSearchType: "12",
		egovTitlePattern: /^Town Council/i,
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

function requireEnv(name: string): string {
	const value = readEnv(name);
	if (!value) {
		throw new Error(
			`Missing required environment variable: ${name}. Set it in .env.local or the shell.`,
		);
	}
	return value;
}

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

	const dramaDetector = createGeminiDramaDetector({
		modelId: geminiModelId,
		promptVersion: dramaProfileV1.promptVersion,
		systemPrompt: dramaProfileV1.systemPrompt,
		...(dramaProfileV1.temperature !== undefined
			? { temperature: dramaProfileV1.temperature }
			: {}),
		...(dramaProfileV1.thinkingBudget !== undefined
			? { thinkingBudget: dramaProfileV1.thinkingBudget }
			: {}),
		...(dramaProfileV1.includeThoughts !== undefined
			? { includeThoughts: dramaProfileV1.includeThoughts }
			: {}),
	});
	const dramaDetection = DramaDetectionServiceLive({
		model: geminiModelId,
		promptVersion: dramaProfileV1.promptVersion,
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
		dramaDetection,
		storage,
		alert,
	);
}

export {
	DEFAULT_BODIES,
	extractPdfText,
	readEnv,
	requireEnv,
	buildProductionLayers,
};
export type { BodyConfigEntry, BuildLayersInput };
