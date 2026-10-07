export type DramaLevel = "routine" | "bumpy" | "heated" | "off-the-rails";

/**
 * The categories the active rubric (`evals/profiles/v2.ts`) scores, in rubric
 * order. Each is checkable against the recording.
 */
export const DRAMA_CATEGORIES = [
	"procedural_breakdown",
	"question_looping",
	"unanswered_questions",
	"undecided_time",
	"repeat_deferrals",
	"improvised_workarounds",
	"post_hoc_corrections",
] as const;

export type ScoredDramaCategory = (typeof DRAMA_CATEGORIES)[number];

/**
 * Every category a stored score row can carry. Wider than
 * `ScoredDramaCategory`: assessments written under the v1 rubric keep the
 * three categories v2 no longer scores.
 */
export type DramaCategory =
	| ScoredDramaCategory
	| "defensive_hedging"
	| "timeline_pressure"
	| "visible_dissent";

export const DRAMA_LEVELS = [
	"routine",
	"bumpy",
	"heated",
	"off-the-rails",
] as const satisfies readonly DramaLevel[];

/**
 * What residents see for each tier. The keys are internal codes that are
 * stored with each assessment and never shown.
 */
export const LEVEL_DISPLAY: Record<DramaLevel, string> = {
	routine: "Routine",
	bumpy: "Some friction",
	heated: "Process problems",
	"off-the-rails": "Serious process problems",
};

export const CATEGORY_DISPLAY: Record<DramaCategory, string> = {
	procedural_breakdown: "Procedural Breakdown",
	question_looping: "Question Looping",
	unanswered_questions: "Unanswered Questions",
	undecided_time: "Time Without a Decision",
	repeat_deferrals: "Repeat Deferrals",
	defensive_hedging: "Defensive Hedging",
	timeline_pressure: "Timeline Pressure",
	improvised_workarounds: "Improvised Workarounds",
	visible_dissent: "Visible Dissent",
	post_hoc_corrections: "Post-Hoc Corrections",
};

export function mapSumToLevel(sum: number): DramaLevel {
	if (sum >= 17) return "off-the-rails";
	if (sum >= 12) return "heated";
	if (sum >= 6) return "bumpy";
	return "routine";
}
