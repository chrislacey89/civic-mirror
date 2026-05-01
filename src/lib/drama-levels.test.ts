import { describe, expect, it } from "vitest";
import { mapSumToLevel } from "./drama-levels";

describe("mapSumToLevel", () => {
	it("maps 0 to routine", () => {
		expect(mapSumToLevel(0)).toBe("routine");
	});

	it("maps 5 to routine (upper boundary)", () => {
		expect(mapSumToLevel(5)).toBe("routine");
	});

	it("maps 6 to bumpy (lower boundary)", () => {
		expect(mapSumToLevel(6)).toBe("bumpy");
	});

	it("maps 11 to bumpy (upper boundary)", () => {
		expect(mapSumToLevel(11)).toBe("bumpy");
	});

	it("maps 12 to heated (lower boundary)", () => {
		expect(mapSumToLevel(12)).toBe("heated");
	});

	it("maps 16 to heated (upper boundary)", () => {
		expect(mapSumToLevel(16)).toBe("heated");
	});

	it("maps 17 to off-the-rails (lower boundary)", () => {
		expect(mapSumToLevel(17)).toBe("off-the-rails");
	});

	it("maps 21 to off-the-rails (upper boundary)", () => {
		expect(mapSumToLevel(21)).toBe("off-the-rails");
	});
});
