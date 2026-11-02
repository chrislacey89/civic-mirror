import { describe, expect, it } from "vitest";
import { publicCommentSection } from "./publicComment.ts";

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
