import { describe, expectTypeOf, it } from "vitest";
import type { DramaCategory, DramaLevel } from "../lib/drama-levels";
import type { dramaAssessments, dramaCategoryScores } from "./schema";

type AssessmentRow = typeof dramaAssessments.$inferSelect;
type CategoryRow = typeof dramaCategoryScores.$inferSelect;

describe("drama schema brands", () => {
	it("dramaAssessments.level narrows to DramaLevel", () => {
		expectTypeOf<AssessmentRow["level"]>().toEqualTypeOf<DramaLevel>();
	});

	it("dramaCategoryScores.category narrows to DramaCategory", () => {
		expectTypeOf<CategoryRow["category"]>().toEqualTypeOf<DramaCategory>();
	});

	it("dramaCategoryScores.evidenceQuotes narrows to string[]", () => {
		expectTypeOf<CategoryRow["evidenceQuotes"]>().toEqualTypeOf<string[]>();
	});
});
