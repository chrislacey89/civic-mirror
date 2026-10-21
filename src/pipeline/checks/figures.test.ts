import { describe, expect, it } from "vitest";
import type { LabelledSource } from "#/pipeline/sources.ts";
import { figuresCheck } from "./figures.ts";
import type { CheckContext, WriteUp } from "./types.ts";

function contextOf(
	sources: LabelledSource[],
	ledger: CheckContext["ledger"] = [],
): CheckContext {
	return {
		input: { sources, meetingContext: "Town Council, May 27, 2025" },
		ledger,
	};
}

function documents(text: string): LabelledSource {
	return { kind: "documents", text };
}

function transcript(text: string): LabelledSource {
	return { kind: "transcript", text };
}

function draftOf(prose: string, highlights: string[] = []): WriteUp {
	return { highlights, prose };
}

describe("figuresCheck", () => {
	it("owns A1, G1 and G4", () => {
		expect(figuresCheck.owns).toEqual(["A1", "G1", "G4"]);
	});

	describe("A1, figures", () => {
		it("If the prose states a figure in neither source, then it fails A1 and quotes the figure and its sentence", () => {
			const verdicts = figuresCheck.run(
				draftOf(
					"The council met. The council approved a $48,000 paving contract.",
				),
				contextOf([
					documents("Motion to approve the paving contract for $45,000."),
				]),
			);
			expect(verdicts.A1).toEqual({
				outcome: "fail",
				evidence:
					'"$48,000" is in no source: "The council approved a $48,000 paving contract."',
			});
		});

		it.each([
			[
				"a sum of three prices the record never adds up",
				"The three bids total $682,824.",
				"Bids: $227,608.00, $227,608.00 and $227,608.00.",
			],
			[
				"a figure found only inside a garbled token",
				"Town awards $57,830 bid for septic work.",
				"Bid from Smith Septic for $57830,000 was accepted.",
			],
			[
				"a figure found only after letters",
				"The grant is $460.",
				"Grant 1 million JD460 awarded.",
			],
			[
				"a figure with its cents dropped",
				"The council paid $139,775 for the truck.",
				"Purchase of a truck for $139,775.03.",
			],
			[
				"a figure only the ledger carries",
				"The council paid $12,000 for salt.",
				"Motion to purchase road salt. All in favor, motion carries.",
			],
		])("fails A1 on %s", (_label, prose, source) => {
			const verdicts = figuresCheck.run(
				draftOf(prose),
				contextOf(
					[documents(source)],
					[
						{
							title: "Road salt",
							description: "",
							amount: 12000,
							originalAmount: "$12,000",
							status: "approved",
							confidence: 1,
							isRecurring: false,
						},
					],
				),
			);
			expect(verdicts.A1?.outcome).toBe("fail");
		});

		it.each([
			[
				"a figure the documents write",
				"The council approved a $45,000 contract.",
				[documents("Contract for $45,000.00 approved.")],
			],
			[
				"a figure only the transcript states",
				"The council approved a $45,000 contract.",
				[documents("Contract approved."), transcript("that's 45,000 dollars")],
			],
			[
				'"$1.2 million" against "1,200,000"',
				"The bond is $1.2 million.",
				[documents("Bond in the amount of $1,200,000.")],
			],
			[
				'"1,200,000" against "$1.2 million"',
				"The bond is $1,200,000.",
				[documents("Bond of $1.2 million.")],
			],
			[
				"a percent written in words in the record",
				"Taxes rise 61.9%.",
				[documents("an increase of 61.9 percent")],
			],
			[
				"a phone number",
				"Call the clerk at 812-876-3860.",
				[documents("Contact the clerk.")],
			],
			[
				"an ordinance number",
				"The council adopted Ordinance 2026-14.",
				[documents("Ordinance 2026–14 adopted.")],
			],
			[
				"a resolution number",
				"The council adopted Resolution No. 12-2025.",
				[documents("Resolution adopted.")],
			],
			[
				"a street address",
				"The house at 1204 West Temperance Street was razed.",
				[documents("The house was razed.")],
			],
			[
				"a year after a month",
				"The referendum is set for November 2026.",
				[documents("A referendum next fall.")],
			],
			[
				"a clock time",
				"The meeting began at 6:30 p.m.",
				[documents("Called to order.")],
			],
			[
				"a number the record spells out",
				"Five members attended.",
				[documents("Present: five members.")],
			],
			[
				"a count the record spells out",
				"The council heard from 3 residents.",
				[documents("three residents spoke")],
			],
			[
				"an ordinal",
				"The corporation marks its 40th anniversary.",
				[documents("celebrating 40 years")],
			],
		])("passes A1 on %s", (_label, prose, sources) => {
			expect(figuresCheck.run(draftOf(prose), contextOf(sources)).A1).toEqual({
				outcome: "pass",
			});
		});

		it("checks the highlights as well as the prose", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council met.", ["Council approves $9,999 purchase."]),
				contextOf([documents("Purchase approved.")]),
			);
			expect(verdicts.A1?.outcome).toBe("fail");
		});
	});
});
