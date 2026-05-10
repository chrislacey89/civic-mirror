import { describe, expect, it } from "vitest";
import type { DramaLevel } from "#/lib/drama-levels.ts";
import { DRAMA_CATEGORIES } from "#/lib/drama-levels.ts";
import {
	type AgreementSummary,
	computeTrialSummary,
	detectDriftEvent,
	PROMOTION_CRITERIA,
	type TrialResult,
} from "#/pipeline/scripts/evals/agreement.ts";
import type { LoadedCorpusEntry } from "#/pipeline/scripts/evals/corpus-loader.ts";
import type { DramaAssessmentOutput } from "#/pipeline/services/DramaDetectionService.ts";

/**
 * Build a `category_scores` object that places `sum` worth of score evenly
 * across the 7 categories. With 7 categories scored 0–3 (max sum = 21), this
 * lets a test fix the sum exactly without caring how it's distributed.
 */
function scoresForSum(sum: number): DramaAssessmentOutput["category_scores"] {
	const result = {} as DramaAssessmentOutput["category_scores"];
	let remaining = sum;
	for (const cat of DRAMA_CATEGORIES) {
		const score = Math.min(3, remaining);
		result[cat] = { score, evidence_quotes: [] };
		remaining -= score;
	}
	return result;
}

function buildAssessment(
	sum: number,
	level: DramaLevel,
): DramaAssessmentOutput {
	return {
		category_scores: scoresForSum(sum),
		level,
		confidence: 0.8,
		headline: "test",
		narrative: "test narrative",
	};
}

function buildTrial(
	overrides: Partial<TrialResult> & {
		profile: string;
		transcriptId: string;
		trial: number;
	},
): TrialResult {
	return {
		status: "ok",
		durationMs: 1000,
		...overrides,
	};
}

function buildGroundTruth(
	scores: DramaAssessmentOutput["category_scores"],
	level: DramaLevel,
): LoadedCorpusEntry {
	return {
		schema_version: 1,
		id: "test-corpus",
		transcript_path: "transcripts/test.txt",
		meeting_context: "test",
		graded_at: "2026-05-10",
		graded_by: "test",
		ground_truth: {
			category_scores: scores,
			level,
			headline: "gt headline",
			narrative: "gt narrative",
		},
		sourcePath: "/tmp/corpus/test.json",
		transcriptText: "fake transcript",
	};
}

describe("detectDriftEvent", () => {
	it("returns null when LLM-emitted level matches mapSumToLevel(sum)", () => {
		// sum=18 → off-the-rails (≥17), LLM agrees
		const assessment = buildAssessment(18, "off-the-rails");
		expect(detectDriftEvent(assessment)).toBeNull();
	});

	it("returns null when LLM-emitted level matches at every tier boundary", () => {
		expect(detectDriftEvent(buildAssessment(0, "routine"))).toBeNull();
		expect(detectDriftEvent(buildAssessment(5, "routine"))).toBeNull();
		expect(detectDriftEvent(buildAssessment(6, "bumpy"))).toBeNull();
		expect(detectDriftEvent(buildAssessment(11, "bumpy"))).toBeNull();
		expect(detectDriftEvent(buildAssessment(12, "heated"))).toBeNull();
		expect(detectDriftEvent(buildAssessment(16, "heated"))).toBeNull();
		expect(detectDriftEvent(buildAssessment(17, "off-the-rails"))).toBeNull();
	});

	it("returns a DriftEvent when LLM emits a tier inconsistent with sum", () => {
		// sum=11 → bumpy mechanically; LLM said "heated"
		const assessment = buildAssessment(11, "heated");
		const drift = detectDriftEvent(assessment);
		expect(drift).toEqual({
			type: "level_override",
			llmEmitted: "heated",
			computed: "bumpy",
			sum: 11,
		});
	});

	it("returns a DriftEvent across the off-the-rails boundary", () => {
		// sum=18 → off-the-rails; LLM said "heated" (under-call)
		const assessment = buildAssessment(18, "heated");
		expect(detectDriftEvent(assessment)).toEqual({
			type: "level_override",
			llmEmitted: "heated",
			computed: "off-the-rails",
			sum: 18,
		});
	});
});

describe("computeTrialSummary", () => {
	const profile = "v1";
	const transcriptId = "rbb-hiring";

	it("recomputes ground-truth tier from category_scores, never reading groundTruth.level", () => {
		// Ground truth has level="routine" (wrong) but scores sum to 18 → off-the-rails
		const gt = buildGroundTruth(scoresForSum(18), "routine");

		// All trials emit off-the-rails (matching the *mechanical* gt tier)
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(18, "off-the-rails"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 2,
				assessment: buildAssessment(18, "off-the-rails"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 3,
				assessment: buildAssessment(18, "off-the-rails"),
			}),
		];

		const summary = computeTrialSummary(trials, gt);
		// If the function read gt.level it would conclude tier=routine vs trial-tier=off-the-rails
		// → MAE on tier would be huge; in fact the trial scores match gt scores so MAE is 0.
		expect(summary.totalCategoryMae).toBe(0);
		expect(summary.tierMode).toBe("off-the-rails");
	});

	it("computes tier mode/min/max across N=3 ok trials", () => {
		const gt = buildGroundTruth(scoresForSum(18), "off-the-rails");
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(18, "off-the-rails"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 2,
				assessment: buildAssessment(11, "bumpy"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 3,
				assessment: buildAssessment(18, "off-the-rails"),
			}),
		];

		const summary = computeTrialSummary(trials, gt);
		expect(summary.tierMode).toBe("off-the-rails");
		expect(summary.tierMin).toBe("bumpy");
		expect(summary.tierMax).toBe("off-the-rails");
		expect(summary.trialsCounted).toBe(3);
		expect(summary.trialsExcluded).toBe(0);
	});

	it("breaks bimodal tier-mode ties deterministically (higher tier wins)", () => {
		const gt = buildGroundTruth(scoresForSum(12), "heated");
		// Two heated, two bumpy → tied. Per locked tiebreak, higher tier (heated) wins.
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(12, "heated"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 2,
				assessment: buildAssessment(11, "bumpy"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 3,
				assessment: buildAssessment(12, "heated"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 4,
				assessment: buildAssessment(11, "bumpy"),
			}),
		];

		const summary = computeTrialSummary(trials, gt);
		expect(summary.tierMode).toBe("heated");
	});

	it("computes total category MAE on partial agreement", () => {
		// Build ground truth with score=2 in every category (sum=14 → heated)
		const gtScores = {} as DramaAssessmentOutput["category_scores"];
		for (const cat of DRAMA_CATEGORIES) {
			gtScores[cat] = { score: 2, evidence_quotes: [] };
		}
		const gt = buildGroundTruth(gtScores, "heated");

		// Trial 1: score=3 in every category → |3-2| × 7 = 7 absolute error
		const trialScores1 = {} as DramaAssessmentOutput["category_scores"];
		for (const cat of DRAMA_CATEGORIES) {
			trialScores1[cat] = { score: 3, evidence_quotes: [] };
		}
		// Trial 2: score=0 in every category → |0-2| × 7 = 14 absolute error
		const trialScores2 = {} as DramaAssessmentOutput["category_scores"];
		for (const cat of DRAMA_CATEGORIES) {
			trialScores2[cat] = { score: 0, evidence_quotes: [] };
		}

		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: {
					category_scores: trialScores1,
					level: "off-the-rails",
					confidence: 0.9,
					headline: "h",
					narrative: "n",
				},
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 2,
				assessment: {
					category_scores: trialScores2,
					level: "routine",
					confidence: 0.9,
					headline: "h",
					narrative: "n",
				},
			}),
		];

		const summary = computeTrialSummary(trials, gt);
		// Mean of [7, 14] per-trial absolute error sums = 10.5
		expect(summary.totalCategoryMae).toBe(10.5);
	});

	it("excludes empty_output trials from numeric aggregates and counts them separately", () => {
		const gt = buildGroundTruth(scoresForSum(12), "heated");
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(12, "heated"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 2,
				status: "empty_output",
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 3,
				assessment: buildAssessment(12, "heated"),
			}),
		];

		const summary = computeTrialSummary(trials, gt);
		expect(summary.trialsCounted).toBe(2);
		expect(summary.trialsExcluded).toBe(1);
		expect(summary.emptyOutputCount).toBe(1);
		// Numeric aggregates use only the 2 ok trials
		expect(summary.tierMode).toBe("heated");
		expect(summary.totalCategoryMae).toBe(0);
		expect(summary.sigma).toBe(0);
	});

	it("produces null metrics when every trial is empty_output", () => {
		const gt = buildGroundTruth(scoresForSum(12), "heated");
		const trials: TrialResult[] = [
			buildTrial({ profile, transcriptId, trial: 1, status: "empty_output" }),
			buildTrial({ profile, transcriptId, trial: 2, status: "empty_output" }),
			buildTrial({ profile, transcriptId, trial: 3, status: "empty_output" }),
		];

		const summary = computeTrialSummary(trials, gt);
		expect(summary.trialsCounted).toBe(0);
		expect(summary.trialsExcluded).toBe(3);
		expect(summary.emptyOutputCount).toBe(3);
		expect(summary.tierMode).toBeNull();
		expect(summary.tierMin).toBeNull();
		expect(summary.tierMax).toBeNull();
		expect(summary.sigma).toBeNull();
		expect(summary.totalCategoryMae).toBeNull();
		expect(summary.driftEventCount).toBe(0);
		expect(summary.tierMatchCount).toBe(0);
		// Ground-truth tier is still computed from corpus scores even when
		// no trial data is usable.
		expect(summary.groundTruthTier).toBe("heated");
	});

	it("recomputes groundTruthTier from corpus scores, ignoring corpus level", () => {
		// Corpus level says "routine" but scores sum to 18 → off-the-rails
		const gt = buildGroundTruth(scoresForSum(18), "routine");
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(18, "off-the-rails"),
			}),
		];
		const summary = computeTrialSummary(trials, gt);
		expect(summary.groundTruthTier).toBe("off-the-rails");
		// All 1 trial matches recomputed GT tier
		expect(summary.tierMatchCount).toBe(1);
	});

	it("tierMatchCount counts only trials whose mechanical tier equals groundTruthTier", () => {
		// GT scores sum to 12 → heated
		const gt = buildGroundTruth(scoresForSum(12), "heated");
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(12, "heated"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 2,
				// sum=11 → bumpy, doesn't match GT heated
				assessment: buildAssessment(11, "bumpy"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 3,
				assessment: buildAssessment(13, "heated"),
			}),
		];
		const summary = computeTrialSummary(trials, gt);
		expect(summary.groundTruthTier).toBe("heated");
		expect(summary.tierMatchCount).toBe(2);
		expect(summary.trialsCounted).toBe(3);
		// 2/3 ≥ 2/3 → meets PROMOTION_CRITERIA.minTierMatchFraction
		expect(
			summary.tierMatchCount / summary.trialsCounted,
		).toBeGreaterThanOrEqual(PROMOTION_CRITERIA.minTierMatchFraction);
	});

	it("counts drift events from trial assessments", () => {
		const gt = buildGroundTruth(scoresForSum(11), "bumpy");
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				// LLM said heated, sum=11 → bumpy: drift
				assessment: buildAssessment(11, "heated"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 2,
				// LLM said bumpy, sum=11 → bumpy: no drift
				assessment: buildAssessment(11, "bumpy"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 3,
				// LLM said routine, sum=11 → bumpy: drift
				assessment: buildAssessment(11, "routine"),
			}),
		];

		const summary = computeTrialSummary(trials, gt);
		expect(summary.driftEventCount).toBe(2);
	});

	it("computes population sigma of category-score sums across ok trials", () => {
		const gt = buildGroundTruth(scoresForSum(12), "heated");
		// Sums: 11, 12, 18 → mean = 41/3 ≈ 13.667
		// Population variance = ((11-13.667)² + (12-13.667)² + (18-13.667)²) / 3
		//                     = (7.111 + 2.778 + 18.778) / 3 = 28.667 / 3 ≈ 9.556
		// σ ≈ 3.0912
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(11, "bumpy"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 2,
				assessment: buildAssessment(12, "heated"),
			}),
			buildTrial({
				profile,
				transcriptId,
				trial: 3,
				assessment: buildAssessment(18, "off-the-rails"),
			}),
		];

		const summary = computeTrialSummary(trials, gt);
		expect(summary.sigma).not.toBeNull();
		expect(summary.sigma as number).toBeCloseTo(3.0912, 3);
	});

	it("returns sigma=0 for a single ok trial (N=1 still defined)", () => {
		const gt = buildGroundTruth(scoresForSum(12), "heated");
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(12, "heated"),
			}),
		];
		const summary: AgreementSummary = computeTrialSummary(trials, gt);
		expect(summary.sigma).toBe(0);
	});

	it("treats `error`-status trials the same as empty for exclusion", () => {
		const gt = buildGroundTruth(scoresForSum(12), "heated");
		const trials: TrialResult[] = [
			buildTrial({
				profile,
				transcriptId,
				trial: 1,
				assessment: buildAssessment(12, "heated"),
			}),
			buildTrial({ profile, transcriptId, trial: 2, status: "error" }),
		];
		const summary = computeTrialSummary(trials, gt);
		expect(summary.trialsCounted).toBe(1);
		expect(summary.trialsExcluded).toBe(1);
		// emptyOutputCount counts only `empty_output` status, not `error`
		expect(summary.emptyOutputCount).toBe(0);
	});
});

describe("PROMOTION_CRITERIA", () => {
	it("locks the four documented thresholds in a single revisable place", () => {
		expect(PROMOTION_CRITERIA.minTierMatchFraction).toBeCloseTo(2 / 3, 5);
		expect(PROMOTION_CRITERIA.maxEmptyOutputs).toBe(0);
		// "No off-the-rails-boundary drift" means: zero drift events that
		// cross the off-the-rails boundary in either direction.
		expect(PROMOTION_CRITERIA.maxOffTheRailsBoundaryDrift).toBe(0);
		// MAE threshold is set per-run against the prod profile baseline,
		// so the constant only fixes the comparator (≤), not a number.
		expect(PROMOTION_CRITERIA.maeComparator).toBe("<=prod");
	});
});
