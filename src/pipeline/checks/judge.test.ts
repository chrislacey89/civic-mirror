import { describe, expect, it } from "vitest";
import { gatedFor, judgeFingerprint } from "./judge.ts";

const base = {
	model: "gemini-2.5-pro",
	prompt: "Check the draft.",
	settings: { temperature: 0 },
};

describe("judgeFingerprint", () => {
	it("is the same for the same model, prompt and settings, whatever their key order", () => {
		expect(
			judgeFingerprint({
				...base,
				settings: { temperature: 0, topP: 1 },
			}),
		).toBe(
			judgeFingerprint({
				...base,
				settings: { topP: 1, temperature: 0 },
			}),
		);
	});

	it.each([
		["model", { ...base, model: "gemini-2.5-flash" }],
		["prompt", { ...base, prompt: "Check the draft again." }],
		["settings", { ...base, settings: { temperature: 0.2 } }],
	])("changes when the %s changes", (_, changed) => {
		expect(judgeFingerprint(changed)).not.toBe(judgeFingerprint(base));
	});
});

describe("gatedFor", () => {
	it("gates A2 on a meeting with documents", () => {
		expect(
			gatedFor({
				meetingContext: "Town Council, 2026-05-11",
				sources: [
					{ kind: "documents", text: "Minutes." },
					{ kind: "transcript", text: "Captions." },
				],
			}),
		).toEqual(["A2"]);
	});

	it("gates nothing on a transcript-only meeting", () => {
		expect(
			gatedFor({
				meetingContext: "Town Council, 2026-05-11",
				sources: [{ kind: "transcript", text: "Captions." }],
			}),
		).toEqual([]);
	});
});
