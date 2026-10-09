import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	jsonPathProblem,
	judgeRuns,
	parseRepeatArgs,
} from "./summarize-repeat-verdict.ts";

const decided = (amount: number) => ({
	summary: {
		fiscalDecisions: [{ status: "approved", amount, ordinanceNumber: "O-1" }],
		highlights: [],
		prose: "",
	},
});

describe("judgeRuns", () => {
	it("exits 0 when every run gives the same decisions", () => {
		expect(judgeRuns([decided(5), decided(5)])).toMatchObject({
			exitCode: 0,
			distinct: 1,
		});
	});

	it("exits 1 when the runs differ", () => {
		expect(judgeRuns([decided(5), decided(6)])).toMatchObject({
			exitCode: 1,
			distinct: 2,
		});
	});

	it("exits 3, not 0 or 1, when a run failed, even if the finished runs agree or differ", () => {
		const agree = judgeRuns([decided(5), { failure: "429" }, decided(5)]);
		expect(agree).toEqual({
			exitCode: 3,
			distinct: null,
			failedRuns: [{ run: 2, failure: "429" }],
		});
		expect(judgeRuns([decided(5), decided(6), { failure: "x" }]).exitCode).toBe(
			3,
		);
	});
});

describe("parseRepeatArgs", () => {
	it("defaults to 5 runs, no export and the regular session", () => {
		expect(parseRepeatArgs(["council", "2026-09-01"])).toEqual({
			ok: true,
			bodySlug: "council",
			date: "2026-09-01",
			runs: 5,
			jsonPath: null,
			session: "",
		});
	});

	it("refuses a trailing --json instead of skipping the export", () => {
		expect(parseRepeatArgs(["council", "2026-09-01", "--json"])).toMatchObject({
			ok: false,
		});
	});

	it("refuses a trailing --session instead of judging the regular meeting", () => {
		expect(
			parseRepeatArgs(["council", "2026-09-01", "--session"]),
		).toMatchObject({ ok: false });
	});

	it("refuses a flag followed by another flag, not taking the flag as its value", () => {
		expect(
			parseRepeatArgs(["council", "2026-09-01", "--json", "--session", "x"]),
		).toMatchObject({ ok: false });
		expect(
			parseRepeatArgs([
				"council",
				"2026-09-01",
				"--session",
				"--json",
				"a.json",
			]),
		).toMatchObject({ ok: false });
	});

	it("reads --json and --session in either order", () => {
		const expected = {
			ok: true,
			bodySlug: "council",
			date: "2026-09-01",
			runs: 5,
			jsonPath: "a.json",
			session: "budget",
		};
		expect(
			parseRepeatArgs([
				"council",
				"2026-09-01",
				"--json",
				"a.json",
				"--session",
				"budget",
			]),
		).toEqual(expected);
		expect(
			parseRepeatArgs([
				"council",
				"2026-09-01",
				"--session",
				"budget",
				"--json",
				"a.json",
			]),
		).toEqual(expected);
	});

	it("keeps positional order with flags interleaved", () => {
		expect(
			parseRepeatArgs([
				"--session",
				"budget",
				"council",
				"--json",
				"a.json",
				"2026-09-01",
				"3",
			]),
		).toEqual({
			ok: true,
			bodySlug: "council",
			date: "2026-09-01",
			runs: 3,
			jsonPath: "a.json",
			session: "budget",
		});
	});
});

describe("jsonPathProblem", () => {
	const directory = mkdtempSync(join(tmpdir(), "summarize-repeat-"));
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	it("accepts a new file in an existing directory", () => {
		expect(jsonPathProblem(join(directory, "new.json"))).toBeNull();
	});

	it("accepts an existing writable file", () => {
		const file = join(directory, "existing.json");
		writeFileSync(file, "{}");
		expect(jsonPathProblem(file)).toBeNull();
	});

	it("refuses a path whose directory does not exist", () => {
		expect(jsonPathProblem(join(directory, "missing", "out.json"))).toContain(
			"cannot write --json file",
		);
	});

	it("refuses a path whose parent is a file", () => {
		const file = join(directory, "plain.txt");
		writeFileSync(file, "");
		expect(jsonPathProblem(join(file, "out.json"))).not.toBeNull();
	});
});
