import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type AgreementSummary,
	PROMOTION_CRITERIA,
} from "#/pipeline/scripts/evals/agreement.ts";
import {
	cellKey,
	generateCsvReport,
	generateMarkdownReport,
	type ReportInput,
} from "#/pipeline/scripts/evals/report.ts";

const fixture = (name: string): string =>
	fileURLToPath(new URL(`./__fixtures__/report/${name}`, import.meta.url));

const v1Cell: AgreementSummary = {
	groundTruthTier: "off-the-rails",
	tierMode: "off-the-rails",
	tierMin: "off-the-rails",
	tierMax: "off-the-rails",
	sigma: 0,
	totalCategoryMae: 0,
	driftEventCount: 0,
	offTheRailsBoundaryDriftCount: 0,
	emptyOutputCount: 0,
	tierMatchCount: 3,
	trialsCounted: 3,
	trialsExcluded: 0,
};

const v2Cell: AgreementSummary = {
	groundTruthTier: "off-the-rails",
	tierMode: "heated",
	tierMin: "bumpy",
	tierMax: "off-the-rails",
	sigma: 3.09,
	totalCategoryMae: 4.5,
	driftEventCount: 1,
	offTheRailsBoundaryDriftCount: 1,
	emptyOutputCount: 0,
	tierMatchCount: 1,
	trialsCounted: 3,
	trialsExcluded: 0,
};

const sampleInput: ReportInput = {
	runId: "test-run-2026-05-10",
	startedAt: "2026-05-10T12:00:00.000Z",
	completedAt: "2026-05-10T12:15:00.000Z",
	modelId: "gemini-2.5-flash",
	profiles: ["v1", "v2"],
	transcripts: ["rbb-hiring"],
	cells: new Map<string, AgreementSummary>([
		[cellKey("v1", "rbb-hiring"), v1Cell],
		[cellKey("v2", "rbb-hiring"), v2Cell],
	]),
	promotionCriteria: PROMOTION_CRITERIA,
	prodProfile: "v1",
};

describe("generateMarkdownReport", () => {
	it("renders the canonical golden REPORT.md exactly", async () => {
		const golden = await readFile(fixture("REPORT.golden.md"), "utf8");
		const actual = generateMarkdownReport(sampleInput);
		expect(actual).toBe(golden);
	});

	it("renders Promote=✗ when the cell has zero ok trials", () => {
		const emptyCell: AgreementSummary = {
			groundTruthTier: "heated",
			tierMode: null,
			tierMin: null,
			tierMax: null,
			sigma: null,
			totalCategoryMae: null,
			driftEventCount: 0,
			offTheRailsBoundaryDriftCount: 0,
			emptyOutputCount: 3,
			tierMatchCount: 0,
			trialsCounted: 0,
			trialsExcluded: 3,
		};
		const input: ReportInput = {
			...sampleInput,
			profiles: ["v1"],
			cells: new Map([[cellKey("v1", "rbb-hiring"), emptyCell]]),
			prodProfile: "v1",
		};
		const md = generateMarkdownReport(input);
		// Every metric column should render an em dash for null values
		expect(md).toContain("| — |");
		// Promote? cell should be ✗ when no trials succeeded
		expect(md).toContain("✗");
	});

	it("skips MAE comparison when prodProfile is omitted", () => {
		const input: ReportInput = {
			...sampleInput,
			prodProfile: undefined,
		};
		const md = generateMarkdownReport(input);
		expect(md).toContain("`maeComparator = manual`");
		// v1 row would otherwise be the prod baseline; without prodProfile, both
		// rows are evaluated by tier-match + empty + OTR-drift only.
		// v1 has tier match 3/3, 0 empty, 0 OTR drift → ✓.
		// v2 has tier match 1/3 (< 2/3) → ✗.
		expect(md).toMatch(/v1.*?\| ✓ \|/s);
		expect(md).toMatch(/v2.*?\| ✗ \|/s);
	});
});

describe("generateCsvReport", () => {
	it("renders the canonical golden REPORT.csv exactly", async () => {
		const golden = await readFile(fixture("REPORT.golden.csv"), "utf8");
		const actual = generateCsvReport(sampleInput);
		expect(actual).toBe(golden);
	});

	it("emits one header row plus one row per (profile × transcript) cell", () => {
		const csv = generateCsvReport(sampleInput);
		const lines = csv.trimEnd().split("\n");
		expect(lines).toHaveLength(3); // header + 2 cells
		expect(lines[0]).toContain("profile,transcript,gt_tier");
	});
});

describe("cellKey", () => {
	it("uses the canonical `<profile>__<transcript>` form", () => {
		expect(cellKey("v1", "rbb-hiring")).toBe("v1__rbb-hiring");
	});
});
