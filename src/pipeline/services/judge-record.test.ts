import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	type CalibrationRecord,
	clearsBars,
} from "#/pipeline/checks/calibration.ts";
import { JUDGE_GATED, judgeFingerprint } from "#/pipeline/checks/judge.ts";
import {
	geminiJudgeFingerprint,
	JUDGE_CLOSING,
	JUDGE_INSTRUCTIONS,
	JUDGE_MODEL_ID,
} from "./GeminiJudge.ts";

// Pass-throughs that let a test see what the fingerprint hashes and change
// what the writer prompt returns, without a parameter the product code lacks.
const writer = vi.hoisted(() => ({ suffix: "" }));

vi.mock("#/pipeline/checks/judge.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("#/pipeline/checks/judge.ts")>();
	return { ...original, judgeFingerprint: vi.fn(original.judgeFingerprint) };
});

vi.mock("./GeminiSummarizer.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("./GeminiSummarizer.ts")>();
	return {
		...original,
		buildWritingPrompt: (
			...args: Parameters<typeof original.buildWritingPrompt>
		) => {
			const prompt = original.buildWritingPrompt(...args);
			return prompt.replace(
				"Write the highlights and prose",
				`${writer.suffix}Write the highlights and prose`,
			);
		},
	};
});

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

	it("hashes the whole judge prompt as built, not only its fixed text", () => {
		geminiJudgeFingerprint(JUDGE_MODEL_ID);
		const hashed = vi.mocked(judgeFingerprint).mock.lastCall?.[0];
		expect(hashed?.prompt).toContain(JUDGE_INSTRUCTIONS);
		// The judge's own template, and the closing line.
		expect(hashed?.prompt).toContain("OFFICIALS:");
		expect(hashed?.prompt).toContain("DRAFT:");
		expect(hashed?.prompt).toContain("HEADLINE: ");
		expect(hashed?.prompt).toContain(JUDGE_CLOSING);
		// The writer's inputs, as `buildWritingPrompt` renders them.
		for (const label of ["DOCUMENTS:", "TRANSCRIPT:", "LEDGER:", "GLOSSARY:"]) {
			expect(hashed?.prompt).toContain(label);
		}
	});

	it("hashes the prompt's other branches: several documents, an empty ledger and roster, a roster line without variants, a headline-only draft", () => {
		geminiJudgeFingerprint(JUDGE_MODEL_ID);
		const prompt = vi.mocked(judgeFingerprint).mock.lastCall?.[0].prompt ?? "";
		// Two documents of one kind, joined by a blank line.
		expect(prompt).toContain(
			"Council approved the paving bid.\n\nSecond document",
		);
		// An empty ledger and an empty roster, each with its placeholder.
		expect(prompt).toContain("(no fiscal decisions)");
		expect(prompt).toContain("(none listed)");
		// A roster line with variants and one without.
		expect(prompt).toContain("; also written Daniel Swafford");
		expect(prompt).toMatch(/^- \w[^;\n]* \([^)\n]*\)$/m);
		// A headline-only draft: nothing between the headline and the prose.
		expect(prompt).toMatch(/HEADLINE: [^\n]+\n\n\n[^-\n]/);
	});

	it("hashes the output schema as the model receives it, descriptions included", () => {
		geminiJudgeFingerprint(JUDGE_MODEL_ID);
		const hashed = vi.mocked(judgeFingerprint).mock.lastCall?.[0];
		expect(JSON.stringify(hashed?.settings.outputSchema)).toContain(
			"the failing words of the draft, quoted exactly",
		);
	});

	it("changes when the writer's inputs are rendered differently", () => {
		const before = geminiJudgeFingerprint(JUDGE_MODEL_ID);
		writer.suffix = "NEW WRITER INPUT\n\n";
		try {
			expect(geminiJudgeFingerprint(JUDGE_MODEL_ID)).not.toBe(before);
		} finally {
			writer.suffix = "";
		}
	});

	it.each(
		(Object.keys(JUDGE_GATED) as (keyof typeof JUDGE_GATED)[]).flatMap(
			(split) => JUDGE_GATED[split].map((check) => [split, check] as const),
		),
	)("shows the %s split's gated %s clearing every bar", (split, check) => {
		const score = record().scores[split][check];
		expect(clearsBars(score), JSON.stringify(score)).toBe(true);
	});

	it("shows no gated check flipped by an instruction inside a source", () => {
		const { injection } = record();
		expect(injection.probed).toBeGreaterThan(0);
		// An entry is "<id> <check>"; a check gated on either split counts.
		const gated = new Set<string>(Object.values(JUDGE_GATED).flat());
		expect(
			injection.flipped.filter((entry) => gated.has(entry.split(" ")[1] ?? "")),
		).toEqual([]);
	});
});
