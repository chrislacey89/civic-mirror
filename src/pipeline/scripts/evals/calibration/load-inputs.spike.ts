/**
 * Throwaway spike for judge calibration (issue #195). For each already
 * published meeting named by the markdown snapshots in SNAPSHOT_DIR, caches
 * everything a judge needs to .context/calibration/inputs/<key>.json.
 *
 * READ ONLY: it reads the database through StorageService read methods and one
 * SELECT, and writes nothing but local files.
 *
 *   pnpm tsx src/pipeline/scripts/evals/calibration/load-inputs.spike.ts
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";
import { resolveDatabaseUrl } from "#/db/database-url.ts";
import * as schema from "#/db/schema.ts";
import { DEFAULT_BODIES } from "#/pipeline/composition.ts";
import { officialsFor } from "#/pipeline/officials/index.ts";
import { buildWritingPrompt } from "#/pipeline/services/GeminiSummarizer.ts";
import {
	StorageService,
	StorageServiceLive,
} from "#/pipeline/services/StorageService.ts";
import type { SummarizationInput } from "#/pipeline/services/SummarizationService.ts";
import { readableSources } from "#/pipeline/sources.ts";

config({ path: [".env.local", ".env"] });

const SNAPSHOT_DIR =
	"/Users/christopherlacey/conductor/workspaces/civic-mirror/biarritz-v3/.context/score/meetings";
const OUT_DIR = ".context/calibration/inputs";
mkdirSync(OUT_DIR, { recursive: true });

const client = createClient({
	url: resolveDatabaseUrl() ?? "",
	...(process.env.TURSO_AUTH_TOKEN
		? { authToken: process.env.TURSO_AUTH_TOKEN }
		: {}),
});
const db = drizzle(client, { schema });
const layer = StorageServiceLive(db);

function snapshotOf(md: string): { highlights: string[]; prose: string } {
	const section = (name: string): string => {
		const start = md.indexOf(`\n## ${name}`);
		if (start < 0) throw new Error(`no ${name} section`);
		const bodyStart = md.indexOf("\n", start + 1) + 1;
		const end = md.indexOf("\n## ", bodyStart);
		return md.slice(bodyStart, end < 0 ? undefined : end);
	};
	const highlights = section("HIGHLIGHTS")
		.split("\n")
		.filter((line) => /^\d+\. /.test(line))
		.map((line) => line.replace(/^\d+\. /, "").trim());
	return { highlights, prose: section("PROSE").trim() };
}

type Row = {
	key: string;
	hasDocuments: boolean;
	hasTranscript: boolean;
	draftMatchesSnapshot: boolean;
	writingPromptChars: number;
};
const index: Row[] = [];
const failures: { key: string; reason: string }[] = [];

const keys = readdirSync(SNAPSHOT_DIR)
	.filter((name) => name.endsWith(".md"))
	.map((name) => name.slice(0, -3))
	.sort();

for (const key of keys) {
	try {
		const md = readFileSync(`${SNAPSHOT_DIR}/${key}.md`, "utf8");
		const slug = /\/meetings\/([^/\s]+)\/\d{4}-\d{2}-\d{2}/.exec(md)?.[1];
		const date = key.slice(0, 10);
		const session = key.length > 10 ? key.slice(11) : "";
		const body = DEFAULT_BODIES.find((candidate) => candidate.slug === slug);
		if (!slug || !body) throw new Error(`unknown body slug ${slug}`);

		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const storage = yield* StorageService;
				const meeting = yield* storage.getMeetingSourceState({
					bodySlug: body.slug,
					date,
					session,
				});
				if (meeting === null) return null;
				const sources = readableSources(
					yield* storage.getMeetingSources(meeting.meetingId),
				);
				const stored = yield* storage.getStoredWriteUp(meeting.meetingId);
				return { meetingId: meeting.meetingId, sources, stored };
			}).pipe(Effect.provide(layer)),
		);
		if (loaded === null) throw new Error("no stored meeting");
		const { meetingId, sources, stored } = loaded;

		const summary = await db
			.select({
				highlights: schema.summaries.highlights,
				prose: schema.summaries.prose,
				status: schema.summaries.status,
			})
			.from(schema.summaries)
			.where(eq(schema.summaries.meetingId, meetingId))
			.get();
		const dbDraft = summary
			? {
					highlights: summary.highlights as string[],
					prose: summary.prose,
					status: summary.status as string,
				}
			: null;

		const input: SummarizationInput = {
			sources,
			meetingContext: `${body.name}, ${date}`,
			glossary: body.glossary,
		};
		const ledger = stored?.ledger ?? [];
		const writingPrompt = buildWritingPrompt(input, ledger);
		const snapshot = snapshotOf(md);
		const draftMatchesSnapshot =
			dbDraft !== null &&
			dbDraft.prose.trim() === snapshot.prose &&
			dbDraft.highlights.length === snapshot.highlights.length &&
			dbDraft.highlights.every((h, i) => h.trim() === snapshot.highlights[i]);
		const sourceKinds = [...new Set(sources.map((source) => source.kind))];
		const hasDocuments = sourceKinds.includes("documents");
		const hasTranscript = sourceKinds.includes("transcript");

		writeFileSync(
			`${OUT_DIR}/${key}.json`,
			JSON.stringify(
				{
					key,
					bodySlug: body.slug,
					date,
					session,
					meetingId,
					sourceKinds,
					hasDocuments,
					hasTranscript,
					input,
					ledger,
					officials: officialsFor(body.slug, date),
					writingPrompt,
					db: dbDraft,
					snapshot,
					draftMatchesSnapshot,
				},
				null,
				2,
			),
		);
		index.push({
			key,
			hasDocuments,
			hasTranscript,
			draftMatchesSnapshot,
			writingPromptChars: writingPrompt.length,
		});
	} catch (error) {
		failures.push({
			key,
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

writeFileSync(`${OUT_DIR}/_index.json`, JSON.stringify(index, null, 2));
console.log(`wrote ${index.length}/${keys.length} meetings`);
for (const failure of failures)
	console.log(`FAILED ${failure.key}: ${failure.reason}`);
console.log(
	`documents: ${index.filter((r) => r.hasDocuments).length}, transcript-only: ${index.filter((r) => !r.hasDocuments).length}`,
);
console.log(
	`draftMatchesSnapshot=false: ${
		index
			.filter((r) => !r.draftMatchesSnapshot)
			.map((r) => r.key)
			.join(", ") || "none"
	}`,
);
client.close();
