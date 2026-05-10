import { type DramaLevel, LEVEL_DISPLAY } from "#/lib/drama-levels.ts";
import type {
	AgreementSummary,
	PROMOTION_CRITERIA,
} from "#/pipeline/scripts/evals/agreement.ts";

type ReportInput = {
	runId: string;
	startedAt: string;
	completedAt: string;
	modelId: string;
	profiles: readonly string[];
	transcripts: readonly string[];
	cells: ReadonlyMap<string, AgreementSummary>;
	promotionCriteria: typeof PROMOTION_CRITERIA;
	/**
	 * The promptVersion of the production profile. When provided, each cell's
	 * MAE is auto-checked against the prod profile's MAE for the same
	 * transcript. When omitted, the MAE criterion shows as `manual` in the
	 * report and is excluded from the auto-checked Promote? column.
	 */
	prodProfile?: string;
};

/**
 * Canonical key for `ReportInput.cells`. Single-source the convention so
 * runner.ts and report.ts can never disagree about whether the separator is
 * `__`, `:`, or `/`.
 */
function cellKey(profile: string, transcript: string): string {
	return `${profile}__${transcript}`;
}

function fmtTier(tier: DramaLevel | null): string {
	return tier === null ? "—" : LEVEL_DISPLAY[tier];
}

function fmtTierRange(min: DramaLevel | null, max: DramaLevel | null): string {
	if (min === null || max === null) return "—";
	if (min === max) return LEVEL_DISPLAY[min];
	return `${LEVEL_DISPLAY[min]}–${LEVEL_DISPLAY[max]}`;
}

function fmtNum(n: number | null, decimals: number): string {
	return n === null ? "—" : n.toFixed(decimals);
}

/**
 * Auto-checks the four PRD #66 promotion criteria where the data is
 * available. Returns `false` when any criterion fails or when no ok trials
 * exist (cell has no evidence to evaluate). MAE check is skipped when
 * `prodMae` is `undefined` (no prod profile declared, or the prod cell
 * itself has null MAE).
 */
function passesPromotion(
	cell: AgreementSummary,
	prodMae: number | undefined,
	criteria: typeof PROMOTION_CRITERIA,
): boolean {
	if (cell.trialsCounted === 0) return false;
	const tierMatchFraction = cell.tierMatchCount / cell.trialsCounted;
	if (tierMatchFraction < criteria.minTierMatchFraction) return false;
	if (cell.emptyOutputCount > criteria.maxEmptyOutputs) return false;
	if (
		cell.offTheRailsBoundaryDriftCount > criteria.maxOffTheRailsBoundaryDrift
	) {
		return false;
	}
	if (
		prodMae !== undefined &&
		cell.totalCategoryMae !== null &&
		cell.totalCategoryMae > prodMae
	) {
		return false;
	}
	return true;
}

function lookupProdMae(
	input: ReportInput,
	transcript: string,
): number | undefined {
	if (input.prodProfile === undefined) return undefined;
	const prod = input.cells.get(cellKey(input.prodProfile, transcript));
	return prod?.totalCategoryMae ?? undefined;
}

function generateMarkdownReport(input: ReportInput): string {
	const lines: string[] = [];
	lines.push(`# Drama Eval Report — ${input.runId}`);
	lines.push("");
	lines.push("| Field | Value |");
	lines.push("| --- | --- |");
	lines.push(`| Started | ${input.startedAt} |`);
	lines.push(`| Completed | ${input.completedAt} |`);
	lines.push(`| Model | ${input.modelId} |`);
	lines.push(`| Profiles | ${input.profiles.join(", ")} |`);
	lines.push(`| Transcripts | ${input.transcripts.join(", ")} |`);
	lines.push(`| Prod profile | ${input.prodProfile ?? "(none)"} |`);
	lines.push("");
	lines.push("## Promotion Criteria");
	lines.push("");
	lines.push(
		"A profile may replace the production prompt iff, across ≥3 trials per transcript:",
	);
	lines.push("");
	const fracPct = Math.round(
		input.promotionCriteria.minTierMatchFraction * 100,
	);
	lines.push(
		`- Tier match in ≥ ${fracPct}% of trials (\`minTierMatchFraction = 2/3\`)`,
	);
	const maeText =
		input.prodProfile === undefined
			? "manual"
			: input.promotionCriteria.maeComparator;
	lines.push(
		`- Total category MAE ≤ prod profile MAE (\`maeComparator = ${maeText}\`)`,
	);
	lines.push(
		`- Zero empty-output trials (\`maxEmptyOutputs = ${input.promotionCriteria.maxEmptyOutputs}\`)`,
	);
	lines.push(
		`- No drift events crossing the off-the-rails boundary (\`maxOffTheRailsBoundaryDrift = ${input.promotionCriteria.maxOffTheRailsBoundaryDrift}\`)`,
	);
	lines.push("");
	lines.push("## Cells");
	lines.push("");
	lines.push(
		"| Profile | Transcript | GT Tier | Tier Mode | Tier Range | σ | MAE | Drift | OTR Drift | Empty | Tier Match | Trials | Promote? |",
	);
	lines.push(
		"| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | :---: | :---: | :---: |",
	);

	for (const profile of input.profiles) {
		for (const transcript of input.transcripts) {
			const cell = input.cells.get(cellKey(profile, transcript));
			if (!cell) continue;
			const prodMae = lookupProdMae(input, transcript);
			const promote = passesPromotion(cell, prodMae, input.promotionCriteria);
			const promoteStr = promote ? "✓" : "✗";
			const tierMatchStr = `${cell.tierMatchCount}/${cell.trialsCounted}`;
			const totalTrials = cell.trialsCounted + cell.trialsExcluded;
			const trialsStr = `${cell.trialsCounted}/${totalTrials}`;
			lines.push(
				`| ${profile} | ${transcript} | ${fmtTier(cell.groundTruthTier)} | ${fmtTier(cell.tierMode)} | ${fmtTierRange(cell.tierMin, cell.tierMax)} | ${fmtNum(cell.sigma, 2)} | ${fmtNum(cell.totalCategoryMae, 2)} | ${cell.driftEventCount} | ${cell.offTheRailsBoundaryDriftCount} | ${cell.emptyOutputCount} | ${tierMatchStr} | ${trialsStr} | ${promoteStr} |`,
			);
		}
	}
	lines.push("");
	return lines.join("\n");
}

const CSV_HEADER =
	"profile,transcript,gt_tier,tier_mode,tier_min,tier_max,sigma,total_category_mae,drift_event_count,otr_boundary_drift_count,empty_output_count,tier_match_count,trials_counted,trials_excluded,promote";

function csvNum(n: number | null): string {
	return n === null ? "" : n.toString();
}

function csvTier(t: DramaLevel | null): string {
	return t === null ? "" : t;
}

/**
 * One row per (profile × transcript) cell, ordered by `profiles` then
 * `transcripts`. Header included. Tier values use the raw ids (e.g.
 * `off-the-rails`) for spreadsheet sortability; numbers use full JS
 * precision via `toString()`. No quoting — the values cannot contain
 * commas or quotes (tier ids and ASCII identifiers only).
 */
function generateCsvReport(input: ReportInput): string {
	const lines: string[] = [CSV_HEADER];
	for (const profile of input.profiles) {
		for (const transcript of input.transcripts) {
			const cell = input.cells.get(cellKey(profile, transcript));
			if (!cell) continue;
			const prodMae = lookupProdMae(input, transcript);
			const promote = passesPromotion(cell, prodMae, input.promotionCriteria);
			lines.push(
				[
					profile,
					transcript,
					csvTier(cell.groundTruthTier),
					csvTier(cell.tierMode),
					csvTier(cell.tierMin),
					csvTier(cell.tierMax),
					csvNum(cell.sigma),
					csvNum(cell.totalCategoryMae),
					cell.driftEventCount,
					cell.offTheRailsBoundaryDriftCount,
					cell.emptyOutputCount,
					cell.tierMatchCount,
					cell.trialsCounted,
					cell.trialsExcluded,
					String(promote),
				].join(","),
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

export { cellKey, generateCsvReport, generateMarkdownReport };
export type { ReportInput };
