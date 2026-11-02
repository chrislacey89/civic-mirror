import { describe, expect, it } from "vitest";
import { DEFAULT_BODIES } from "#/pipeline/composition.ts";
import { OFFICIALS_BY_BODY, officialsFor, servingOn } from "./index.ts";
import type { Official } from "./types.ts";

function official(from: string, to: string | null): Official {
	return {
		name: "Ada Clerk",
		variants: [],
		role: "Clerk",
		served: { from, to },
	};
}

describe("servingOn", () => {
	it("keeps an official through the first and last day served", () => {
		const list = [official("2024-01-01", "2025-12-31")];
		expect(servingOn(list, "2024-01-01")).toEqual(list);
		expect(servingOn(list, "2025-12-31")).toEqual(list);
	});

	it("drops an official whose service ended before the meeting", () => {
		expect(
			servingOn([official("2024-01-01", "2025-12-31")], "2026-01-01"),
		).toEqual([]);
	});

	it("drops an official whose service began after the meeting", () => {
		expect(servingOn([official("2024-01-01", null)], "2023-12-31")).toEqual([]);
	});

	it("keeps an official still serving", () => {
		const list = [official("2024-01-01", null)];
		expect(servingOn(list, "2030-06-01")).toEqual(list);
	});
});

describe("officialsFor", () => {
	it("gives a body nobody has configured no officials", () => {
		expect(officialsFor("nowhere-town-council", "2026-01-01")).toEqual([]);
	});
});

describe("the officials lists", () => {
	it("has a list for every configured body", () => {
		expect(Object.keys(OFFICIALS_BY_BODY).sort()).toEqual(
			DEFAULT_BODIES.map((body) => body.slug).sort(),
		);
	});

	it("dates every entry in ISO form, ending no earlier than it starts", () => {
		const iso = /^\d{4}-\d{2}-\d{2}$/;
		for (const official of Object.values(OFFICIALS_BY_BODY).flat()) {
			expect(official.served.from).toMatch(iso);
			if (official.served.to !== null) {
				expect(official.served.to).toMatch(iso);
				expect(official.served.to >= official.served.from).toBe(true);
			}
		}
	});
});
