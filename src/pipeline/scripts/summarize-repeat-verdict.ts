/** One summarization run: its fiscal decisions, or why the model call failed. */
export type RepeatRun =
	| {
			readonly decisions: ReadonlyArray<{
				readonly status: string;
				readonly amount: number | string;
				readonly ordinanceNumber?: string | null;
			}>;
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
		"decisions" in run
			? run.decisions
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
