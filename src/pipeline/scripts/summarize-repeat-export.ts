/** One summarization run's text, or why the model call failed. */
export type RepeatText =
	| {
			readonly summary: {
				readonly highlights: ReadonlyArray<string>;
				readonly prose: string;
			};
	  }
	| { readonly failure: string };

/**
 * The runs' highlights and prose in the shape the article compare page
 * (`.context/compare/index.html`) imports: one object per meeting date, one
 * named variant per run that finished. Runs keep their 1-based number so a
 * variant can be matched to the printed ledger for the same run.
 */
export function compareImport(
	date: string,
	modelId: string,
	runs: ReadonlyArray<RepeatText>,
): Record<
	string,
	Record<string, { highlights: ReadonlyArray<string>; prose: string }>
> {
	const variants: Record<
		string,
		{ highlights: ReadonlyArray<string>; prose: string }
	> = {};
	runs.forEach((run, index) => {
		if ("summary" in run) {
			variants[`${modelId} run ${index + 1}`] = {
				highlights: run.summary.highlights,
				prose: run.summary.prose,
			};
		}
	});
	return { [date]: variants };
}
