import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type CalibrationRecord,
	clearsBars,
} from "#/pipeline/checks/calibration.ts";
import { JUDGE_GATED } from "#/pipeline/checks/judge.ts";
import { geminiJudgeFingerprint, JUDGE_MODEL_ID } from "./GeminiJudge.ts";

const RECORD = "src/pipeline/checks/__fixtures__/calibration/record.json";
const RERUN = "run `pnpm tsx src/pipeline/scripts/calibrate-judge.ts --write`";

function record(): CalibrationRecord {
	if (!existsSync(RECORD)) throw new Error(`no calibration record: ${RERUN}`);
	return JSON.parse(readFileSync(RECORD, "utf8"));
}

describe("the production judge's calibration record", () => {
	it("was made with the judge's current model, prompt and settings", () => {
		expect(
			record().fingerprint,
			`the judge changed since it was calibrated: ${RERUN}`,
		).toBe(geminiJudgeFingerprint(JUDGE_MODEL_ID));
	});

	it.each(
		(Object.keys(JUDGE_GATED) as (keyof typeof JUDGE_GATED)[]).flatMap(
			(split) => JUDGE_GATED[split].map((check) => [split, check] as const),
		),
	)("shows the %s split's gated %s clearing every bar", (split, check) => {
		const score = record().scores[split][check];
		expect(clearsBars(score), JSON.stringify(score)).toBe(true);
	});

	it("shows no verdict flipped by an instruction inside a source", () => {
		const { injection } = record();
		expect(injection.probed).toBeGreaterThan(0);
		expect(injection.flipped).toEqual([]);
	});
});
