import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { Data, Effect } from "effect";
import { z } from "zod";
import {
	DRAMA_CATEGORIES,
	DRAMA_LEVELS,
	type DramaCategory,
	type DramaLevel,
} from "#/lib/drama-levels.ts";

class CorpusLoadError extends Data.TaggedError("CorpusLoadError")<{
	readonly message: string;
	readonly path: string;
}> {}

const CategoryScoreSchema = z.object({
	score: z.number().int().min(0).max(3),
	evidence_quotes: z.array(z.string()),
});

const CategoryScoresSchema = z
	.object(
		Object.fromEntries(
			DRAMA_CATEGORIES.map((c) => [c, CategoryScoreSchema]),
		) as Record<DramaCategory, typeof CategoryScoreSchema>,
	)
	.strict();

const CorpusEntrySchema = z.object({
	schema_version: z.literal(1),
	id: z.string().min(1),
	transcript_path: z.string().min(1),
	meeting_context: z.string(),
	graded_at: z.string(),
	graded_by: z.string(),
	ground_truth: z.object({
		category_scores: CategoryScoresSchema,
		level: z.enum(DRAMA_LEVELS as readonly [DramaLevel, ...DramaLevel[]]),
		headline: z.string(),
		narrative: z.string(),
		notes: z.string().optional(),
	}),
});

type CorpusEntry = z.infer<typeof CorpusEntrySchema>;

type LoadedCorpusEntry = CorpusEntry & {
	readonly sourcePath: string;
	readonly transcriptText: string;
};

function listCorpusFiles(
	dir: string,
): Effect.Effect<readonly string[], CorpusLoadError> {
	return Effect.tryPromise({
		try: async () => {
			const entries = await readdir(dir, { withFileTypes: true });
			return entries
				.filter((e) => e.isFile() && e.name.endsWith(".json"))
				.map((e) => path.join(dir, e.name))
				.sort();
		},
		catch: (error) =>
			new CorpusLoadError({
				path: dir,
				message: `failed to read corpus directory: ${
					error instanceof Error ? error.message : String(error)
				}`,
			}),
	});
}

function loadCorpusEntry(
	filePath: string,
	corpusDir: string,
): Effect.Effect<LoadedCorpusEntry, CorpusLoadError> {
	return Effect.tryPromise({
		try: async () => {
			const raw = await readFile(filePath, "utf8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (e) {
				throw new Error(
					`malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			const result = CorpusEntrySchema.safeParse(parsed);
			if (!result.success) {
				throw new Error(`schema validation failed: ${result.error.message}`);
			}
			const entry = result.data;
			const transcriptResolved = path.resolve(
				path.dirname(corpusDir),
				entry.transcript_path,
			);
			let transcriptText: string;
			try {
				transcriptText = await readFile(transcriptResolved, "utf8");
			} catch (e) {
				throw new Error(
					`transcript file not found at ${transcriptResolved}: ${
						e instanceof Error ? e.message : String(e)
					}`,
				);
			}
			return { ...entry, sourcePath: filePath, transcriptText };
		},
		catch: (error) =>
			new CorpusLoadError({
				path: filePath,
				message: error instanceof Error ? error.message : String(error),
			}),
	});
}

const DEFAULT_CORPUS_DIR = path.resolve(process.cwd(), "evals/corpus");

function loadCorpus(
	dir: string = DEFAULT_CORPUS_DIR,
): Effect.Effect<readonly LoadedCorpusEntry[], CorpusLoadError> {
	return Effect.gen(function* () {
		const files = yield* listCorpusFiles(dir);
		return yield* Effect.all(files.map((f) => loadCorpusEntry(f, dir)));
	});
}

export { loadCorpus, CorpusLoadError };
export type { LoadedCorpusEntry };
