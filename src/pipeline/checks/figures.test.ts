import { describe, expect, it } from "vitest";
import type { LabelledSource } from "#/pipeline/sources.ts";
import { figuresCheck, rollCallTally } from "./figures.ts";
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

const MINUTES = `
Michael Farmer, Town Manager discussed consolidation with Richland Township.
Pamela Samples made a motion to enter into an agreement to explore
reorganization with the Township of Richland. William Ellis seconded. Roll call
vote: Scott Oldham — no; Dan Swafford — yes; William Ellis —
yes; Trevor Sager — yes; Pamela Samples — yes. Motion carries.

Kevin Tolloty presented Ordinance 2025-25 creating a vehicle replacement fund
for the Stormwater Utility. Dan Swafford seconded. Roll call vote: Scott Oldham
— yes; Dan Swafford — yes; William Ellis — yes; Trevor Sager — yes; Pamela
Samples — yes. Motion Carries
Old Business - None
`;

describe("rollCallTally", () => {
	it("counts the yes and no votes of the roll call on the named motion, up to Motion carries", () => {
		expect(
			rollCallTally(
				MINUTES,
				"The council voted 4-1 to explore reorganization with Richland Township.",
			),
		).toEqual({ yes: 4, no: 1 });
		expect(
			rollCallTally(
				MINUTES,
				"The council created a vehicle replacement fund for the Stormwater Utility.",
			),
		).toEqual({ yes: 5, no: 0 });
	});

	it("is null when no roll call is on the motion", () => {
		expect(
			rollCallTally(
				MINUTES,
				"The council approved the Santa on Sale Street parade.",
			),
		).toBeNull();
		expect(
			rollCallTally(
				"Motion to approve the claims. All in favor, motion carries.",
				"The council approved the claims.",
			),
		).toBeNull();
	});
});

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

		it("checks the highlights as well as the prose (A1)", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council met.", ["Council approves $9,999 purchase."]),
				contextOf([documents("Purchase approved.")]),
			);
			expect(verdicts.A1?.outcome).toBe("fail");
		});
	});
	describe("G1, figures as the record writes them", () => {
		it("If a prose figure rounds a figure the record writes, then it fails G1 and names the record's figure", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council paid $139,775 for the truck."),
				contextOf([documents("Purchase of a truck for $139,775.03.")]),
			);
			expect(verdicts.G1).toEqual({
				outcome: "fail",
				evidence:
					'"$139,775" rounds "$139,775.03": "The council paid $139,775 for the truck."',
			});
		});

		it("fails G1 on a figure rounded to millions", () => {
			const verdicts = figuresCheck.run(
				draftOf("The budget is $2.2 million."),
				contextOf([documents("Total budget $2,213,400.")]),
			);
			expect(verdicts.G1?.outcome).toBe("fail");
		});

		it("passes G1 on a figure that drops only a trailing .00", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council paid $29,425 for the truck."),
				contextOf([documents("Purchase of a truck for $29,425.00.")]),
			);
			expect(verdicts.G1).toEqual({ outcome: "pass" });
		});

		it("If the prose writes one sum both as millions and in full, then it fails G1", () => {
			const verdicts = figuresCheck.run(
				draftOf(
					"The bond is $2.2 million. The council approved the $2,200,000 bond.",
				),
				contextOf([documents("Bond of $2,200,000.")]),
			);
			expect(verdicts.G1?.outcome).toBe("fail");
		});
	});
	describe("A1, votes", () => {
		it("If minutes carry a roll call, then a stated tally that disagrees with its count fails A1", () => {
			const verdicts = figuresCheck.run(
				draftOf(
					"The council voted 5-0 to explore reorganization with Richland Township.",
				),
				contextOf([documents(MINUTES)]),
			);
			expect(verdicts.A1).toEqual({
				outcome: "fail",
				evidence:
					'"5-0" disagrees with the roll call, 4 yes and 1 no: "The council voted 5-0 to explore reorganization with Richland Township."',
			});
		});

		it("passes a tally that agrees with the roll call, found through its paragraph", () => {
			const verdicts = figuresCheck.run(
				draftOf(
					"The council created a vehicle replacement fund for the Stormwater Utility. The council voted 5–0 to approve.\n\nThe council voted 4-1 to explore reorganization with Richland Township.",
				),
				contextOf([documents(MINUTES)]),
			);
			expect(verdicts.A1).toEqual({ outcome: "pass" });
		});

		it('fails "unanimously" when the roll call has a no', () => {
			const verdicts = figuresCheck.run(
				draftOf(
					"The council unanimously agreed to explore reorganization with Richland Township.",
				),
				contextOf([documents(MINUTES)]),
			);
			expect(verdicts.A1?.outcome).toBe("fail");
		});

		it('passes "unanimously" when the roll call has no no', () => {
			const verdicts = figuresCheck.run(
				draftOf(
					"The council unanimously created a vehicle replacement fund for the Stormwater Utility.",
				),
				contextOf([documents(MINUTES)]),
			);
			expect(verdicts.A1).toEqual({ outcome: "pass" });
		});

		it("If a transcript-only meeting's prose states a tally the transcript does not, then A1 is unchecked", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council voted 4-1 to buy a $30,000 truck."),
				contextOf([transcript("all in favor of the 30,000 truck say aye")]),
			);
			expect(verdicts.A1?.outcome).toBe("unchecked");
		});

		it.each([
			["4-1", "the motion passes 4-1"],
			["4-1", "the motion passes 4 to 1"],
			["unanimously", "it passes unanimously"],
		])("passes %s on a transcript that states it", (tally, said) => {
			const verdicts = figuresCheck.run(
				draftOf(`The council voted ${tally} to buy a truck.`),
				contextOf([transcript(said)]),
			);
			expect(verdicts.A1).toEqual({ outcome: "pass" });
		});

		it("passes A1 on figures when the prose states no tally", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council approved a $30,000 truck."),
				contextOf([transcript("the 30,000 truck, all in favor")]),
			);
			expect(verdicts.A1).toEqual({ outcome: "pass" });
		});

		it("fails rather than leaves unchecked when a figure fails and a tally cannot be counted", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council voted 4-1 to buy a $31,000 truck."),
				contextOf([transcript("the 30,000 truck")]),
			);
			expect(verdicts.A1?.outcome).toBe("fail");
		});
	});
	describe("G4, an unstated sum says so", () => {
		const claims = (
			originalAmount: string,
		): CheckContext["ledger"][number] => ({
			title: "Accounts Payable Vouchers and Payroll",
			description: "",
			amount: 0,
			originalAmount,
			status: "approved",
			confidence: 1,
			isRecurring: false,
		});
		const minutes = documents(
			"Motion to approve the accounts payable vouchers and payroll. All in favor.",
		);

		it("If the prose names a total the record does not state and does not say it is unstated, then it fails G4", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council paid $412,880 in payroll and vouchers."),
				contextOf([minutes], [claims("not stated")]),
			);
			expect(verdicts.G4).toEqual({
				outcome: "fail",
				evidence:
					'"$412,880" is given for "Accounts Payable Vouchers and Payroll", whose amount the record does not state: "The council paid $412,880 in payroll and vouchers."',
			});
		});

		it.each([
			[
				"says no total was read",
				"The council paid its payroll and vouchers; no total was read into the record.",
			],
			[
				"says the total was not stated",
				"The council paid $412,880 in payroll and vouchers, a total not stated in the record.",
			],
		])("passes G4 on prose that %s", (_label, prose) => {
			const verdicts = figuresCheck.run(
				draftOf(prose),
				contextOf([minutes], [claims("not stated")]),
			);
			expect(verdicts.G4).toEqual({ outcome: "pass" });
		});

		it("passes G4 when the record states the figure", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council paid $412,880 in payroll and vouchers."),
				contextOf(
					[documents("Payroll and vouchers of $412,880.00 approved.")],
					[claims("not stated")],
				),
			);
			expect(verdicts.G4).toEqual({ outcome: "pass" });
		});

		it("passes G4 when the ledger states an amount", () => {
			const verdicts = figuresCheck.run(
				draftOf("The council paid $412,880 in payroll and vouchers."),
				contextOf([minutes], [claims("$412,880.00")]),
			);
			expect(verdicts.G4).toEqual({ outcome: "pass" });
		});
	});
});
