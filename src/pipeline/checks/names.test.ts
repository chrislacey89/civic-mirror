import { describe, expect, it } from "vitest";
import { officialsFor, servingOn } from "#/pipeline/officials/index.ts";
import type { Official } from "#/pipeline/officials/types.ts";
import type { LabelledSource } from "#/pipeline/sources.ts";
import { feedbackFrom } from "./feedback.ts";
import { runCodeChecks } from "./index.ts";
import { extractNames, namesCheck } from "./names.ts";
import type { CheckContext, WriteUp } from "./types.ts";

function contextOf(sources: LabelledSource[]): CheckContext {
	return {
		input: { sources, meetingContext: "Town Council, May 27, 2025" },
		ledger: [],
		officials: [],
	};
}

function draftOf(prose: string, highlights: string[] = []): WriteUp {
	return { highlights, prose };
}

describe("namesCheck", () => {
	it("fails A1 and quotes a person who appears in no source", () => {
		const verdicts = namesCheck.run(
			draftOf("Fire Chief Kevin Palmer asked for a new engine."),
			contextOf([{ kind: "documents", text: "Kevin Patton presented." }]),
		);
		expect(verdicts.A1).toEqual({
			outcome: "fail",
			evidence:
				'"Kevin Palmer" is in no source: "Fire Chief Kevin Palmer asked for a new engine."',
		});
	});
});

describe("extractNames", () => {
	it("reads a first and last name without the title before it", () => {
		expect(
			extractNames(
				"Deputy Fire Marshal Ada Lovelace spoke to Clerk-Treasurer Bo Reed.",
			),
		).toEqual(["Ada Lovelace", "Bo Reed"]);
	});

	it("reads a last name after a title, and a possessive without its 's", () => {
		expect(extractNames("Mr. Reed read Chief Lovelace's report.")).toEqual([
			"Reed",
			"Lovelace",
		]);
	});

	it("keeps a middle initial inside the name", () => {
		expect(extractNames("Ada B. Lovelace spoke.")).toEqual(["Ada B. Lovelace"]);
	});

	it("reads a last name alone before an attribution verb, and not elsewhere", () => {
		expect(
			extractNames("Palmer said the Engine needs work. Palmer's Garage Reed."),
		).toEqual(["Palmer"]);
		expect(extractNames("Staff said so. Residents asked why.")).toEqual([]);
	});

	it("reads a person whose first name is a month or a surname is a direction or a grant", () => {
		expect(
			extractNames(
				"June Reed spoke with Adam West, Hugh Grant and Eugene Levy.",
			),
		).toEqual(["June Reed", "Adam West", "Hugh Grant", "Eugene Levy"]);
	});

	it("does not read a surname alone, a sentence opener or a date before a name as part of it", () => {
		expect(
			extractNames(
				"After Ada Lovelace spoke, Lovelace left. In May Bo Reed did.",
			),
		).toEqual(["Ada Lovelace", "Bo Reed"]);
	});

	it("does not join names across a sentence end", () => {
		expect(
			extractNames("The vote went to Ellettsville. Ada Lovelace left."),
		).toEqual(["Ada Lovelace"]);
	});

	it.each([
		["a body", "The Town Council met."],
		["a township", "They wrote to Richland Township."],
		["a street", "It is on Main Street."],
		["a pay policy", "They adopted the Pay Policy."],
		["a medical agreement", "They signed the Medical Reimbursement Agreement."],
		[
			"a job title alone",
			"The Utilities Billing Clerk and Town Manager spoke.",
		],
		["an organisation", "The Peoples State Bank and Rogers Group bid."],
		["letters in capitals", "CATS TV and the MVH fund were named."],
		["a street with a direction", "It is on South Ridge Lane."],
	])("does not read %s as a person", (_class, text) => {
		expect(extractNames(text)).toEqual([]);
	});

	it.each([
		["Fire Chief Ada Lovelace's Report was read.", ["Ada Lovelace"]],
		["Ada Lovelace's Fire Department budget rose.", ["Ada Lovelace"]],
		["Bo Reed's Fence Variance passed.", ["Bo Reed"]],
	])("ends a run at a possessive, so %j names the person before it", (text, names) => {
		expect(extractNames(text)).toEqual(names);
	});

	it("still reads a possessive organisation as no one", () => {
		expect(extractNames("The Town Council's Report was read.")).toEqual([]);
	});

	it("still reads a person whose surname is also a place word", () => {
		expect(extractNames("Sergeant Richard Hall spoke.")).toEqual([
			"Richard Hall",
		]);
	});
});

function official(name: string, variants: string[] = []): Official {
	return {
		name,
		variants,
		role: "Town Manager",
		served: { from: "2020-01-01", to: null },
	};
}

describe("namesCheck grounding", () => {
	const speaks = draftOf("Town Manager Ada Lovelace spoke.");

	function a1(
		draft: WriteUp,
		sources: LabelledSource[],
		officials: Official[] = [],
	) {
		return namesCheck.run(draft, { ...contextOf(sources), officials }).A1;
	}

	it("passes a name a document prints", () => {
		expect(
			a1(speaks, [{ kind: "documents", text: "Ada Lovelace reported." }]),
		).toEqual({ outcome: "pass" });
	});

	it("passes a name captions print in lower case and across a line", () => {
		expect(
			a1(speaks, [{ kind: "transcript", text: "thank you ada\nlovelace" }]),
		).toEqual({ outcome: "pass" });
	});

	it("passes a name a source prints with a middle initial", () => {
		expect(
			a1(speaks, [{ kind: "documents", text: "Ada B. Lovelace reported." }]),
		).toEqual({ outcome: "pass" });
	});

	it("does not ground a full name on its last name alone", () => {
		expect(
			a1(speaks, [{ kind: "documents", text: "Ms. Lovelace reported." }])
				?.outcome,
		).toBe("fail");
	});

	it("does not ground a name on the same letters inside other words", () => {
		expect(
			a1(draftOf("Chief Reed spoke."), [
				{ kind: "documents", text: "The board agreed on a reedbed." },
			])?.outcome,
		).toBe("fail");
	});

	it("passes a named official on the list, though no source prints the name", () => {
		expect(a1(speaks, [], [official("Ada Lovelace")])).toEqual({
			outcome: "pass",
		});
	});

	it("passes an accepted variant, and a last name after a title", () => {
		const list = [official("Adaline Lovelace", ["Ada Lovelace"])];
		expect(a1(speaks, [], list)).toEqual({ outcome: "pass" });
		expect(a1(draftOf("Ms. Lovelace spoke."), [], list)).toEqual({
			outcome: "pass",
		});
	});

	it("does not ground a different person with an official's last name", () => {
		expect(
			a1(draftOf("Chief Bo Lovelace spoke."), [], [official("Ada Lovelace")])
				?.outcome,
		).toBe("fail");
	});

	it.each([
		["after a title", "Chief Palmer spoke."],
		["before an attribution verb", "Palmer said the engine is late."],
		["after a sentence opener", "After Kevin Palmer spoke, the council met."],
		["after a date", "On Monday Kevin Palmer spoke."],
		["with a first name that is a month", "June Palmer spoke."],
		["with a surname that is a direction", "Adam West spoke."],
		["that is a direction, after a title", "Chief West spoke."],
		["after a hyphenated title", "Clerk-Treasurer Kevin Palmer spoke."],
	])("fails a name in no source %s", (_where, prose) => {
		expect(a1(draftOf(prose), [])?.outcome).toBe("fail");
	});

	it("reads the headline and highlights as well as the prose", () => {
		expect(
			a1(draftOf("The council met.", ["Chief Bo Reed resigned."]), [])?.outcome,
		).toBe("fail");
	});
});

describe("namesCheck against the town's list", () => {
	const onTranscript = (officials: readonly Official[]) =>
		namesCheck.run(
			draftOf("Town Manager Mike Farmer announced a public hearing."),
			{
				...contextOf([{ kind: "transcript", text: "the town manager said" }]),
				officials,
			},
		).A1;

	it("grounds the town manager on a transcript-only meeting whose captions never print the name", () => {
		expect(
			onTranscript(officialsFor("ellettsville-town-council", "2026-09-28")),
		).toEqual({ outcome: "pass" });
	});

	it("does not ground an official for a meeting after their service ended", () => {
		const served = {
			...official("Mike Farmer"),
			served: { from: "2020-01-01", to: "2026-09-27" },
		};
		expect(onTranscript(servingOn([served], "2026-09-28"))?.outcome).toBe(
			"fail",
		);
	});

	it("still fails the fire chief the records never name", () => {
		expect(
			namesCheck.run(draftOf("Fire Chief Kevin Palmer reported."), {
				...contextOf([]),
				officials: officialsFor("ellettsville-town-council", "2026-09-28"),
			}).A1?.outcome,
		).toBe("fail");
	});
});

describe("namesCheck with a possessive", () => {
	it.each([
		"Fire Chief Ada Lovelace's Report was read.",
		"Ada Lovelace's Fire Department budget rose.",
	])("fails A1 on an unsourced name in %j", (text) => {
		expect(namesCheck.run(draftOf(text), contextOf([])).A1?.outcome).toBe(
			"fail",
		);
	});
});

describe("namesCheck in the registry", () => {
	it("gives its A1 failure to the merged verdict, and feeds it back quoted", () => {
		const draft = draftOf(
			"Fire Chief Kevin Palmer asked for a new engine. The council agreed.",
		);
		const report = runCodeChecks(draft, contextOf([]));
		expect(report.verdicts.A1).toEqual({
			outcome: "fail",
			evidence:
				'"Kevin Palmer" is in no source: "Fire Chief Kevin Palmer asked for a new engine."',
		});
		expect(feedbackFrom(report, draft)).toContainEqual({
			checkId: "A1",
			quote: "Fire Chief Kevin Palmer asked for a new engine.",
			finding: '"Kevin Palmer" is in no document or transcript',
		});
	});
});
