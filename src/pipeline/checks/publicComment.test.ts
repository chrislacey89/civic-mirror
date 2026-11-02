import { describe, expect, it } from "vitest";
import type { Official } from "#/pipeline/officials/types.ts";
import { publicCommentCheck, publicCommentSection } from "./publicComment.ts";
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
