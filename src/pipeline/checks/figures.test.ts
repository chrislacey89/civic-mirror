import { describe, expect, it } from "vitest";
import type { LabelledSource } from "#/pipeline/sources.ts";
import {
	figuresCheck,
	groundedFigureCount,
	LEDGER_FIGURE_RULE,
	rollCallTally,
} from "./figures.ts";
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

	it('reads a roll call headed "Roll call for the original motion"', () => {
		const minutes = `William Ellis made a motion to explore reorganization with the
Township of Richland. Dan Swafford made an amendment that all meetings be
public. Roll call vote for the amendment: Scott Oldham — yes; Dan Swafford —
yes; William Ellis — yes. Motion carries. Roll call for the original motion:
Scott Oldham — no; Dan Swafford — yes; William Ellis — yes. Motion carries.`;
		expect(
			figuresCheck.run(
				draftOf(
					"The council voted 2-1 to explore reorganization with Richland Township.",
				),
				contextOf([documents(minutes)]),
			).A1,
		).toEqual({ outcome: "pass" });
	});

	it("does not let the attendance roll hide the motion of the roll call after it", () => {
		const minutes = `Roll Call: Members present were Scott Oldham — President, William
Ellis and Trevor Sager. Award Bid for Septic Receiving Station: the bid went to
the lowest bidder at $57,830.00. Roll call vote: Scott Oldham — yes; William
Ellis — yes; Trevor Sager — yes. Motion carries.`;
		expect(
			rollCallTally(
				minutes,
				"The council awarded the septic receiving station bid.",
			),
		).toEqual({ yes: 3, no: 0 });
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
				"a figure that is only the tail of a garbled token",
				"E & B Paving won the bid for $215.10.",
				"two bids from E & B Paving for fpaa-215.10 and Milestone Paving for $277,571.80.",
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
				"a tax-code section",
				"As a 501(c)(3) non-profit, it pays no property tax.",
				[documents("a non-profit")],
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
	describe("A1, prose the gate must not hold", () => {
		const a1 = (prose: string, ...sources: LabelledSource[]) =>
			figuresCheck.run(draftOf(prose), contextOf(sources)).A1;

		it("reads three decimals before a scale word as a decimal", () => {
			expect(
				a1("The bond is $1.375 million.", documents("The bond is $1,375,000.")),
			).toEqual({ outcome: "pass" });
			expect(
				a1("The bond is $1.375 million.", documents("The bond is $1,376,000.")),
			).toMatchObject({ outcome: "fail" });
		});

		it("does not read a range as a tally because a word like approved is near it", () => {
			expect(
				a1(
					"The council approved plans for 5-6 buildings.",
					documents("Plans for buildings."),
				),
			).toEqual({ outcome: "pass" });
		});

		it("does not look for a date in words in the record", () => {
			expect(
				a1(
					"The hearing is set for March 23.",
					documents("Hearing on 3/23/2026."),
				),
			).toEqual({ outcome: "pass" });
			expect(
				a1("On May 27 the board met.", transcript("The board met today.")),
			).toEqual({ outcome: "pass" });
			expect(
				a1("Comments are due January 19-25.", transcript("Comments are due.")),
			).toEqual({ outcome: "pass" });
		});

		it.each([
			["a day past 31", "Later in May 40 came to the hearing."],
			["a day past 31 and a plural noun", "Later in May 40 residents spoke."],
			[
				"a day followed by a plural noun",
				"In March 25 employees were laid off.",
			],
		])("does not read %s after a month as a date", (_label, prose) => {
			expect(
				a1(prose, documents("The board met and residents spoke."))?.outcome,
			).toBe("fail");
		});

		it("does not read a backward pair after a month as a date range", () => {
			const verdict = figuresCheck.run(
				draftOf(
					"The motion to explore reorganization with Richland Township was voted on May 3-2.",
				),
				contextOf([documents(MINUTES)]),
			).A1;
			expect(verdict?.outcome).toBe("fail");
		});

		// The roll call is chosen by two shared naming words, so a paragraph on a
		// second motion that mentions the first one's topic is counted against
		// it. Closing this needs a stricter match that the whole-paragraph
		// matching of tallyFinding would pay for with unchecked verdicts.
		it.todo(
			"does not check a paragraph on one motion against another motion's roll call that shares two words",
		);
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

		it.each([
			[
				"a range of counts",
				"The district plans 5-6 buildings with 10-20 employees per building.",
			],
			["a date range", "The road closes January 19-25, 2026 for paving."],
			["an ordinance number", "The council approved Ordinance 26-10."],
		])("does not read %s as a vote count", (_label, prose) => {
			const verdicts = figuresCheck.run(
				draftOf(prose),
				contextOf([documents(MINUTES)]),
			);
			expect(verdicts.A1).toEqual({ outcome: "pass" });
		});

		it("does not match a roll call on the members' names that most roll calls share", () => {
			const roll = (motion: string, votes: string) =>
				`${motion} Roll call vote: ${votes} Motion carries.`;
			const unanimous =
				"Scott Oldham — yes; Dan Swafford — yes; William Ellis — yes.";
			const minutes = [
				roll(
					"Council President Scott Oldham made a motion to pay the claims. Dan Swafford seconded.",
					unanimous,
				),
				roll(
					"Council President Scott Oldham called for a motion to approve the minutes. William Ellis seconded.",
					unanimous,
				),
				roll(
					"Dan Swafford made a motion to adopt Resolution 23-2025, opening a new checking account. William Ellis seconded.",
					"Scott Oldham — no; Dan Swafford — yes; William Ellis — yes.",
				),
				roll(
					"Council President Scott Oldham called for a motion to adjourn. William Ellis seconded.",
					unanimous,
				),
			].join("\n\n");
			const verdicts = figuresCheck.run(
				draftOf(
					"The council took up Resolution 23-2025 for the account. Council President Scott Oldham voted no, but the motion passed 2-1.",
				),
				contextOf([documents(minutes)]),
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

describe("groundedFigureCount", () => {
	it("counts the distinct figures the draft states that a source writes", () => {
		const draft = draftOf(
			"The council paid $45,000 for paving and $9,999 for salt. The $45,000 contract runs a year.",
			["Council approves $45,000 paving contract"],
		);
		expect(
			groundedFigureCount(
				draft,
				contextOf([documents("Paving contract $45,000.00. Three bids.")]),
			),
		).toBe(1);
	});
});

describe("LEDGER_FIGURE_RULE, the sentence the writer is given for A1", () => {
	const ledger: CheckContext["ledger"] = [
		{
			title: "Road salt",
			description: "",
			amount: 12000,
			originalAmount: "$12,000",
			status: "approved",
			confidence: 1,
			isRecurring: false,
		},
	];
	const verdictOn = (prose: string, source: string) =>
		figuresCheck.run(draftOf(prose), contextOf([documents(source)], ledger)).A1
			?.outcome;

	it("names LEDGER, the thing A1 does not treat as a source", () => {
		expect(LEDGER_FIGURE_RULE).toContain("LEDGER");
	});

	it(`${LEDGER_FIGURE_RULE} A1 fails the draft that uses it`, () => {
		expect(
			verdictOn(
				"The council paid $12,000 for salt.",
				"Motion to purchase road salt. Motion carries.",
			),
		).toBe("fail");
	});

	it("A1 passes the same draft once the figure is left out", () => {
		expect(
			verdictOn(
				"The council bought road salt.",
				"Motion to purchase road salt. Motion carries.",
			),
		).toBe("pass");
	});

	it("A1 passes the figure once a source writes it", () => {
		expect(
			verdictOn(
				"The council paid $12,000 for salt.",
				"Purchase of road salt for $12,000.",
			),
		).toBe("pass");
	});
});
