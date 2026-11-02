import { describe, expect, it } from "vitest";
import type { Official } from "#/pipeline/officials/types.ts";
import {
	publicCommentCheck,
	publicCommentSection,
	unresolvedNames,
} from "./publicComment.ts";
import type { CheckContext, WriteUp } from "./types.ts";

/** Minutes whose public-comment section names an invented resident. */
const MARKED_MINUTES = [
	"Old Business",
	"The council approved the bid from Elm Paving.",
	"Privilege of the Floor",
	"Ada Lovelace, 12 Elm Street, asked about flooding on Elm Street.",
	"Supervisor Comments",
	"Town Manager Bo Reed reported on the move.",
].join("\n");

function contextOf(
	documents: string | null,
	officials: readonly Official[] = [],
): CheckContext {
	return {
		input: {
			sources:
				documents === null ? [] : [{ kind: "documents", text: documents }],
			meetingContext: "Town Council, May 27, 2025",
		},
		ledger: [],
		officials,
	};
}

function draftOf(prose: string, highlights: string[] = []): WriteUp {
	return { highlights, prose };
}

describe("publicCommentCheck on minutes that mark public comment", () => {
	it("fails A5 when the prose names a non-official who spoke there, without repeating the name", () => {
		const verdict = publicCommentCheck.run(
			draftOf("Ada Lovelace asked the council about flooding on Elm Street."),
			contextOf(MARKED_MINUTES),
		).A5;
		expect(verdict).toEqual({
			outcome: "fail",
			evidence:
				'a resident at public comment is named: "[name] asked the council about flooding on Elm Street." (name at 0)',
		});
	});

	it("passes a name the prose takes from outside the section", () => {
		expect(
			publicCommentCheck.run(
				draftOf("Town Manager Bo Reed reported on the move."),
				contextOf(MARKED_MINUTES),
			).A5,
		).toEqual({ outcome: "pass" });
	});

	it("passes an official on the list who spoke there", () => {
		const lovelace: Official = {
			name: "Ada Lovelace",
			variants: [],
			role: "Town Council member",
			served: { from: "2024-01-01", to: null },
		};
		expect(
			publicCommentCheck.run(
				draftOf("Ada Lovelace asked about flooding."),
				contextOf(MARKED_MINUTES, [lovelace]),
			).A5,
		).toEqual({ outcome: "pass" });
	});

	it.each([
		"County Commissioner Ada Lovelace spoke about the bridge.",
		"Ada Lovelace, Monroe County Highway Director, spoke about the bridge.",
		"Ada Lovelace of Elm Engineering Inc. spoke about the bridge.",
		"Ada Lovelace with the Richland Township Board spoke about the bridge.",
		"Ada Lovelace, representing Elm Paving, spoke about the bridge.",
	])("passes a name the section writes with a role or office beside it: %s", (line) => {
		const minutes = `Privilege of the Floor\n${line}\nSupervisor Comments`;
		expect(
			publicCommentCheck.run(
				draftOf("Ada Lovelace spoke about the bridge."),
				contextOf(minutes),
			).A5,
		).toEqual({ outcome: "pass" });
	});

	it("passes a street the extractor reads as a person when the record writes it after a place word", () => {
		const minutes =
			"Privilege of the Floor\nA resident on 792 Lantern Lane asked about speed limits.\nSupervisor Comments";
		expect(
			publicCommentCheck.run(
				draftOf("A resident asked for solutions to speeding on Lantern Lane."),
				contextOf(minutes),
			).A5,
		).toEqual({ outcome: "pass" });
	});

	it("still fails a person whose surname is a street word", () => {
		const minutes =
			"Privilege of the Floor\nDenise Lane, 12 Elm Street, asked about speeding.\nSupervisor Comments";
		expect(
			publicCommentCheck.run(
				draftOf("Denise Lane asked about speeding on Elm Street."),
				contextOf(minutes),
			).A5?.outcome,
		).toBe("fail");
	});

	it.each([
		"Ada Lovelace, 12 Elm Street, spoke about the bridge.",
		"Ada Lovelace of Elm Street spoke about the bridge.",
		"Ada Lovelace asked the Town Manager about the bridge.",
		"Ada Lovelace, who owns the bar on Main Street, spoke about the fine.",
	])("still fails a resident the section writes as %s", (line) => {
		const minutes = `Privilege of the Floor\n${line}\nSupervisor Comments`;
		expect(
			publicCommentCheck.run(
				draftOf("Ada Lovelace spoke about the bridge."),
				contextOf(minutes),
			).A5?.outcome,
		).toBe("fail");
	});
});

describe("publicCommentSection", () => {
	it("gives the lines between a Privilege of the Floor heading and the next heading", () => {
		const minutes = [
			"Old Business",
			"The council approved the bid.",
			"Privilege of the Floor",
			"Ada Lovelace, 12 Elm Street, asked about flooding.",
			"Bo Reed spoke on the same.",
			"Supervisor Comments",
			"Town Manager Mike Farmer reported on the move.",
		].join("\n");
		expect(publicCommentSection(minutes)).toBe(
			"Ada Lovelace, 12 Elm Street, asked about flooding.\nBo Reed spoke on the same.",
		);
	});

	it("is null when no heading marks public comment", () => {
		expect(
			publicCommentSection("Old Business\nThe council approved the bid."),
		).toBeNull();
	});

	it("is empty, not null, when the heading says no one spoke", () => {
		expect(
			publicCommentSection(
				"Privilege of the Floor — None\nSupervisor Comments\nThe manager spoke.",
			),
		).toBe("");
		expect(
			publicCommentSection("Privilege of the Floor - None\nAdjournment"),
		).toBe("");
	});

	it.each([
		"Privilege of the Floor §",
		"Privilege of the Floor:",
		"PUBLIC COMMENT",
		"Public Comments (3 minute limit)",
		"Citizen Comments",
	])("reads %j as the heading", (heading) => {
		expect(
			publicCommentSection(`${heading}\nAda Lovelace spoke.\nNew Business`),
		).toBe("Ada Lovelace spoke.");
	});

	it.each([
		"Nn Council Comments",
		"MN Council Comments",
		"Council Comments - None",
		"N Adjournment",
		"1 New Business",
		"Old Business",
		"Unfinished Business",
		"Reports",
		"Public Hearing",
		"Resolutions",
	])("closes the section at %j", (heading) => {
		expect(
			publicCommentSection(
				`Privilege of the Floor\nAda Lovelace spoke.\n${heading}\nBo Reed reported.`,
			),
		).toBe("Ada Lovelace spoke.");
	});

	it("does not read a mention inside a sentence as the heading", () => {
		expect(
			publicCommentSection(
				"He said public input is important to the plan.\nThe public comment period closed.\nNew Business",
			),
		).toBeNull();
	});

	it("runs to the end of the text when no heading closes it", () => {
		expect(
			publicCommentSection(
				"Privilege of the Floor\nAda Lovelace spoke.\nMotion carries.",
			),
		).toBe("Ada Lovelace spoke.\nMotion carries.");
	});

	it("keeps a section that a line like a heading interrupts", () => {
		expect(
			publicCommentSection(
				"Privilege of the Floor\nAda Lovelace spoke.\nCarries\nBo Reed spoke.\nAdjournment",
			),
		).toBe("Ada Lovelace spoke.\nCarries\nBo Reed spoke.");
	});
});

/** Minutes with no public-comment heading, naming an invented presenter. */
const UNMARKED_MINUTES = [
	"Old Business",
	"Ada Lovelace of Elm Engineering Inc. presented the bridge plans.",
	"Bo Reed asked about flooding on Elm Street.",
	"Adjournment",
].join("\n");

const CLERK: Official = {
	name: "Bo Reed",
	variants: [],
	role: "Clerk-Treasurer",
	served: { from: "2024-01-01", to: null },
};

describe("publicCommentCheck on a meeting with no marked public comment", () => {
	it("is unchecked for A5 when the prose names a person it cannot resolve, without repeating the name", () => {
		expect(
			publicCommentCheck.run(
				draftOf("Bo Reed asked about flooding on Elm Street."),
				contextOf(UNMARKED_MINUTES),
			).A5,
		).toEqual({
			outcome: "unchecked",
			reason:
				'a name is on no officials list and has no role in the documents: "[name] asked about flooding on Elm Street." (name at 0)',
		});
	});

	it("resolves an official on the list", () => {
		expect(
			publicCommentCheck.run(
				draftOf("Bo Reed asked about flooding on Elm Street."),
				contextOf(UNMARKED_MINUTES, [CLERK]),
			).A5,
		).toEqual({ outcome: "pass" });
	});

	it("resolves a person the documents write with a role or organisation beside", () => {
		expect(
			publicCommentCheck.run(
				draftOf("Engineer Ada Lovelace presented the bridge plans."),
				contextOf(UNMARKED_MINUTES),
			).A5,
		).toEqual({ outcome: "pass" });
	});

	it("is unchecked on a transcript-only meeting for anyone not on the list", () => {
		const ctx: CheckContext = {
			...contextOf(null, [CLERK]),
			input: {
				sources: [{ kind: "transcript", text: "ada lovelace said the bridge" }],
				meetingContext: "Town Council, May 27, 2025",
			},
		};
		expect(
			publicCommentCheck.run(
				draftOf("Bo Reed and Ada Lovelace discussed the bridge."),
				ctx,
			).A5?.outcome,
		).toBe("unchecked");
	});

	it("passes when every name is resolved or there is none", () => {
		expect(
			publicCommentCheck.run(
				draftOf("The council approved the bridge plans."),
				contextOf(UNMARKED_MINUTES),
			).A5,
		).toEqual({ outcome: "pass" });
	});
});

describe("unresolvedNames", () => {
	it("lists the names the check could not resolve, as the draft writes them", () => {
		expect(
			unresolvedNames(
				draftOf("Bo Reed and Ada Lovelace discussed the bridge. Reed said no."),
				contextOf(UNMARKED_MINUTES),
			),
		).toEqual(["Bo Reed", "Reed"]);
	});

	it("is empty when the minutes mark public comment", () => {
		expect(
			unresolvedNames(
				draftOf("Ada Lovelace asked about flooding."),
				contextOf(MARKED_MINUTES),
			),
		).toEqual([]);
	});
});

describe("A5 evidence", () => {
	const minutes = [
		"Privilege of the Floor",
		"Ada Lovelace and Bo Reed asked about flooding.",
		"Adjournment",
	].join("\n");

	it("replaces every flagged name in the sentence, each line at its own offset", () => {
		const verdict = publicCommentCheck.run(
			draftOf("Ada Lovelace and Bo Reed asked about flooding on Elm Street."),
			contextOf(minutes),
		).A5;
		expect(verdict).toEqual({
			outcome: "fail",
			evidence: [
				'a resident at public comment is named: "[name] and [name] asked about flooding on Elm Street." (name at 0)',
				'a resident at public comment is named: "[name] and [name] asked about flooding on Elm Street." (name at 17)',
			].join("\n"),
		});
	});

	it("blanks whole words only, and each word of a full name on its own", () => {
		const section = [
			"Privilege of the Floor",
			"Ada Lovelace and her spouse Ada spoke. Bo Reed spoke.",
			"Adjournment",
		].join("\n");
		const verdict = publicCommentCheck.run(
			draftOf(
				"Ada Lovelace, whose spouse Ada owns the Lovelaceville bar, spoke. Reed said the Reedsville road is bad.",
			),
			contextOf(section),
		).A5;
		expect(verdict?.outcome).toBe("fail");
		expect(verdict?.outcome === "fail" ? verdict.evidence : "").toBe(
			[
				'a resident at public comment is named: "[name], whose spouse [name] owns the Lovelaceville bar, spoke." (name at 0)',
				'a resident at public comment is named: "[name] said the Reedsville road is bad." (name at 0)',
			].join("\n"),
		);
	});

	it("leaves no part of a name behind when the prose also uses the surname alone, in a highlight or the prose", () => {
		const draft = draftOf(
			"Ada Lovelace asked about flooding. Lovelace said the creek rose.",
			["Ada Lovelace asks council to fix flooding"],
		);
		const unmarked = "Old Business\nAda Lovelace asked about flooding.";
		for (const ctx of [contextOf(minutes), contextOf(unmarked)]) {
			const verdict = publicCommentCheck.run(draft, ctx).A5;
			const text =
				verdict?.outcome === "fail"
					? verdict.evidence
					: verdict?.outcome === "unchecked"
						? verdict.reason
						: "";
			expect(text).not.toBe("");
			expect(text).not.toMatch(/Ada|Lovelace/);
			expect(text).toContain("[name] asks council to fix flooding");
		}
	});
});
