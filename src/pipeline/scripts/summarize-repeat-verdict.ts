/** One summarization run: what it produced, or why the model call failed. */
export type RepeatRun =
	| {
			readonly summary: {
				readonly fiscalDecisions: ReadonlyArray<{
					readonly status: string;
					readonly amount: number | string;
					readonly ordinanceNumber?: string | null;
				}>;
				readonly highlights: ReadonlyArray<string>;
				readonly prose: string;
			};
	  }
	| { readonly failure: string };

export const EXIT_SAME = 0;
export const EXIT_DIFFERENT = 1;
export const EXIT_FAILED = 3;

/**
 * The exit code for a set of runs. Any failed run makes the whole comparison
 * unusable, so it returns EXIT_FAILED and `distinct` is null: the runs that did
 * finish are never compared as if they were all of them.
 */
export function judgeRuns(runs: ReadonlyArray<RepeatRun>): {
	readonly exitCode: number;
	readonly distinct: number | null;
	readonly failedRuns: ReadonlyArray<{ run: number; failure: string }>;
} {
	const failedRuns = runs.flatMap((run, index) =>
		"failure" in run ? [{ run: index + 1, failure: run.failure }] : [],
	);
	if (failedRuns.length > 0) {
		return { exitCode: EXIT_FAILED, distinct: null, failedRuns };
	}
	/** A run's decisions as comparable lines: what was decided and for how much, without the wording. */
	const fingerprints = runs.map((run) =>
		"summary" in run
			? run.summary.fiscalDecisions
					.map(
						(decision) =>
							`${decision.status} ${decision.amount} ${decision.ordinanceNumber ?? ""}`,
					)
					.sort()
					.join("\n")
			: "",
	);
	const distinct = new Set(fingerprints).size;
	return {
		exitCode: distinct === 1 ? EXIT_SAME : EXIT_DIFFERENT,
		distinct,
		failedRuns,
	};
}

export type RepeatArgs =
	| {
			readonly ok: true;
			readonly bodySlug: string;
			readonly date: string;
			readonly runs: number;
			readonly jsonPath: string | null;
			readonly session: string;
	  }
	| { readonly ok: false; readonly reason: string };

/**
 * Reads the script's arguments: up to three positionals (body slug, date,
 * runs; a missing one comes back as "" for the caller to reject) with --json <path> and --session <name> allowed anywhere among them.
 * A flag with nothing after it, or followed by another --flag, is refused
 * rather than skipped: a dropped --session would judge the regular meeting
 * and a dropped --json would skip the export, both without a word.
 */
export function parseRepeatArgs(argv: ReadonlyArray<string>): RepeatArgs {
	const positional: string[] = [];
	let jsonPath: string | null = null;
	let session = "";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg !== "--json" && arg !== "--session") {
			positional.push(arg);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) {
			return { ok: false, reason: `${arg} needs a value after it` };
		}
		if (arg === "--json") jsonPath = value;
		else session = value;
		i++;
	}
	const [bodySlug, date, runsArg] = positional;
	return {
		ok: true,
		bodySlug: bodySlug ?? "",
		date: date ?? "",
		runs: Number(runsArg ?? 5),
		jsonPath,
		session,
	};
}
