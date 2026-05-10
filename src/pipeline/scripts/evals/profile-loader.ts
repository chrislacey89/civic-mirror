import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Data, Effect } from "effect";
import type { EvalProfile } from "../../../../evals/profiles/v1.ts";

/**
 * Effect teaching note: `Data.TaggedError` mints a discriminated error class
 * we can pattern-match on with `Effect.catchTag("ProfileLoadError", ...)`.
 * The harness uses one error tag for every failure mode (missing dir, empty
 * prompt, duplicate version) because callers all want the same response —
 * fail fast before any API call. The `path` field surfaces *which* file
 * tripped the check so the operator doesn't have to grep.
 */
class ProfileLoadError extends Data.TaggedError("ProfileLoadError")<{
	readonly message: string;
	readonly path: string;
}> {}

type LoadedProfile = EvalProfile & { sourcePath: string };

/**
 * Heuristic: a profile is any exported value that has a string
 * `promptVersion` and a string `systemPrompt`. The optional fields
 * (`temperature`, `thinkingBudget`, `includeThoughts`) are coerced
 * by structural assignment if present and pass `EvalProfile` typing
 * downstream — we trust the TS shape at the import boundary.
 */
function findProfileExport(mod: Record<string, unknown>): EvalProfile | null {
	for (const value of Object.values(mod)) {
		if (
			value !== null &&
			typeof value === "object" &&
			typeof (value as { promptVersion?: unknown }).promptVersion ===
				"string" &&
			typeof (value as { systemPrompt?: unknown }).systemPrompt === "string"
		) {
			return value as EvalProfile;
		}
	}
	return null;
}

function listProfileFiles(
	dir: string,
): Effect.Effect<readonly string[], ProfileLoadError> {
	return Effect.tryPromise({
		try: async () => {
			const entries = await readdir(dir, { withFileTypes: true });
			return entries
				.filter((e) => e.isFile() && e.name.endsWith(".ts"))
				.map((e) => path.join(dir, e.name))
				.sort();
		},
		catch: (error) =>
			new ProfileLoadError({
				path: dir,
				message: `failed to read profiles directory: ${
					error instanceof Error ? error.message : String(error)
				}`,
			}),
	});
}

function importProfile(
	filePath: string,
): Effect.Effect<LoadedProfile, ProfileLoadError> {
	return Effect.tryPromise({
		try: async () => {
			const mod = (await import(pathToFileURL(filePath).href)) as Record<
				string,
				unknown
			>;
			const profile = findProfileExport(mod);
			if (!profile) {
				throw new Error(
					"no exported value with string `promptVersion` and `systemPrompt` found",
				);
			}
			if (profile.systemPrompt.trim().length === 0) {
				throw new Error(
					"systemPrompt is empty or whitespace — profile is not live",
				);
			}
			return { ...profile, sourcePath: filePath };
		},
		catch: (error) =>
			new ProfileLoadError({
				path: filePath,
				message: error instanceof Error ? error.message : String(error),
			}),
	});
}

function ensureUniqueVersions(
	profiles: readonly LoadedProfile[],
): Effect.Effect<readonly LoadedProfile[], ProfileLoadError> {
	const seen = new Map<string, string>();
	for (const p of profiles) {
		const prior = seen.get(p.promptVersion);
		if (prior !== undefined) {
			return Effect.fail(
				new ProfileLoadError({
					path: p.sourcePath,
					message: `duplicate promptVersion "${p.promptVersion}" — also defined in ${prior}`,
				}),
			);
		}
		seen.set(p.promptVersion, p.sourcePath);
	}
	return Effect.succeed(profiles);
}

const DEFAULT_PROFILE_DIR = path.resolve(process.cwd(), "evals/profiles");

/**
 * Load every `*.ts` profile under `dir`, validating that each is live
 * (non-empty systemPrompt) and that no two profiles share a `promptVersion`.
 * Defaults to `<cwd>/evals/profiles` when no directory is supplied.
 *
 * The harness calls this at the top of every `evals:run` so quota burn
 * never reaches a profile that imports cleanly but ships empty.
 */
function loadProfiles(
	dir: string = DEFAULT_PROFILE_DIR,
): Effect.Effect<readonly LoadedProfile[], ProfileLoadError> {
	return Effect.gen(function* () {
		const files = yield* listProfileFiles(dir);
		const profiles = yield* Effect.all(files.map(importProfile));
		return yield* ensureUniqueVersions(profiles);
	});
}

export { loadProfiles, ProfileLoadError };
export type { LoadedProfile };
