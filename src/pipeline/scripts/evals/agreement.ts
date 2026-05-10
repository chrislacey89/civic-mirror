import {
	DRAMA_CATEGORIES,
	DRAMA_LEVELS,
	type DramaLevel,
	mapSumToLevel,
} from "#/lib/drama-levels.ts";
import type { LoadedCorpusEntry } from "#/pipeline/scripts/evals/corpus-loader.ts";
import {
	type DramaAssessmentOutput,
	sumCategoryScores,
} from "#/pipeline/services/DramaDetectionService.ts";

/**
 * Locked promotion criteria from PRD #66 §Promotion Criteria.
 *
 * `maeComparator` is symbolic ("≤ prod") because the actual MAE bound is set
 * per-run against the prod profile's MAE; the rule pins the comparator, not a
 * number. The other thresholds are absolute and locked.
 */
const PROMOTION_CRITERIA = {
	minTierMatchFraction: 2 / 3,
	maxEmptyOutputs: 0,
	maxOffTheRailsBoundaryDrift: 0,
	maeComparator: "<=prod" as const,
} as const;

type TrialStatus = "ok" | "empty_output" | "error";

type DriftEvent = {
	type: "level_override";
	llmEmitted: DramaLevel;
	computed: DramaLevel;
	sum: number;
};

type TrialResult = {
	profile: string;
	transcriptId: string;
	trial: number;
	status: TrialStatus;
	assessment?: DramaAssessmentOutput;
	driftEvent?: DriftEvent | null;
	durationMs: number;
};

type AgreementSummary = {
	tierMode: DramaLevel | null;
	tierMin: DramaLevel | null;
	tierMax: DramaLevel | null;
	sigma: number | null;
	totalCategoryMae: number | null;
	driftEventCount: number;
	emptyOutputCount: number;
	trialsCounted: number;
	trialsExcluded: number;
};

/**
 * Compares the LLM-emitted `level` against `mapSumToLevel(sum_of_scores)`.
 * Returns `null` when they match. Returns a `DriftEvent` when the LLM's tier
 * label disagrees with the mechanical mapping — these are the cases the prod
 * detector silently overrides, and the harness surfaces them as evidence
 * during prompt iteration.
 */
function detectDriftEvent(
	assessment: DramaAssessmentOutput,
): DriftEvent | null {
	const sum = sumCategoryScores(assessment.category_scores);
	const computed = mapSumToLevel(sum);
	if (computed === assessment.level) return null;
	return {
		type: "level_override",
		llmEmitted: assessment.level,
		computed,
		sum,
	};
}

const TIER_RANK: Record<DramaLevel, number> = (() => {
	const ranks = {} as Record<DramaLevel, number>;
	DRAMA_LEVELS.forEach((level, idx) => {
		ranks[level] = idx;
	});
	return ranks;
})();

/**
 * Bimodal tiebreak: when two tiers tie for most-frequent, the higher-ranked
 * tier wins. Locked by PRD acceptance criterion so the harness's verdict is
 * deterministic across reruns of the same trial set.
 */
function pickTierMode(tiers: readonly DramaLevel[]): DramaLevel {
	const counts = new Map<DramaLevel, number>();
	for (const t of tiers) counts.set(t, (counts.get(t) ?? 0) + 1);
	let best: DramaLevel = tiers[0];
	let bestCount = -1;
	for (const [tier, count] of counts) {
		if (count > bestCount) {
			best = tier;
			bestCount = count;
		} else if (count === bestCount && TIER_RANK[tier] > TIER_RANK[best]) {
			best = tier;
		}
	}
	return best;
}

function tierMin(tiers: readonly DramaLevel[]): DramaLevel {
	let min = tiers[0];
	for (const t of tiers) {
		if (TIER_RANK[t] < TIER_RANK[min]) min = t;
	}
	return min;
}

function tierMax(tiers: readonly DramaLevel[]): DramaLevel {
	let max = tiers[0];
	for (const t of tiers) {
		if (TIER_RANK[t] > TIER_RANK[max]) max = t;
	}
	return max;
}

function populationSigma(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const variance =
		values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
	return Math.sqrt(variance);
}

function totalAbsoluteError(
	trial: DramaAssessmentOutput["category_scores"],
	gt: DramaAssessmentOutput["category_scores"],
): number {
	let sum = 0;
	for (const cat of DRAMA_CATEGORIES) {
		sum += Math.abs(trial[cat].score - gt[cat].score);
	}
	return sum;
}

/**
 * Collapses one (profile × transcript) cell's trial outputs into the
 * distribution evidence the report renders.
 *
 * INVARIANT (PRD #66 §Key invariants): never reads `groundTruth.ground_truth.level`.
 * Per-trial tier labels come from `mapSumToLevel(sum_of_scores)`, not from the
 * LLM's emitted `level`; the LLM's `level` only feeds drift detection. MAE is
 * computed against `groundTruth.ground_truth.category_scores` directly.
 *
 * Both `empty_output` and `error` trials are excluded from numeric aggregates;
 * `emptyOutputCount` distinguishes the two so report drift between modes is
 * preserved (PRD #66 promotion criterion: zero empty outputs).
 */
function computeTrialSummary(
	trials: readonly TrialResult[],
	groundTruth: LoadedCorpusEntry,
): AgreementSummary {
	const okTrials = trials.filter(
		(t): t is TrialResult & { assessment: DramaAssessmentOutput } =>
			t.status === "ok" && t.assessment !== undefined,
	);
	const emptyOutputCount = trials.filter(
		(t) => t.status === "empty_output",
	).length;
	const trialsCounted = okTrials.length;
	const trialsExcluded = trials.length - trialsCounted;

	if (trialsCounted === 0) {
		return {
			tierMode: null,
			tierMin: null,
			tierMax: null,
			sigma: null,
			totalCategoryMae: null,
			driftEventCount: 0,
			emptyOutputCount,
			trialsCounted,
			trialsExcluded,
		};
	}

	const sums = okTrials.map((t) =>
		sumCategoryScores(t.assessment.category_scores),
	);
	const tiersPerTrial = sums.map((s) => mapSumToLevel(s));

	const driftEventCount = okTrials.reduce(
		(acc, t) => acc + (detectDriftEvent(t.assessment) === null ? 0 : 1),
		0,
	);

	const gtScores = groundTruth.ground_truth.category_scores;
	const perTrialAbsErr = okTrials.map((t) =>
		totalAbsoluteError(t.assessment.category_scores, gtScores),
	);
	const totalCategoryMae =
		perTrialAbsErr.reduce((a, b) => a + b, 0) / perTrialAbsErr.length;

	return {
		tierMode: pickTierMode(tiersPerTrial),
		tierMin: tierMin(tiersPerTrial),
		tierMax: tierMax(tiersPerTrial),
		sigma: populationSigma(sums),
		totalCategoryMae,
		driftEventCount,
		emptyOutputCount,
		trialsCounted,
		trialsExcluded,
	};
}

export { computeTrialSummary, detectDriftEvent, PROMOTION_CRITERIA };
export type { AgreementSummary, DriftEvent, TrialResult, TrialStatus };
