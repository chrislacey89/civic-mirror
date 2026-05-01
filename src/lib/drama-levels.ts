export type DramaLevel = "routine" | "bumpy" | "heated" | "off-the-rails";

export type DramaCategory =
	| "procedural_breakdown"
	| "question_looping"
	| "defensive_hedging"
	| "timeline_pressure"
	| "improvised_workarounds"
	| "visible_dissent"
	| "post_hoc_corrections";

export const DRAMA_LEVELS = [
	"routine",
	"bumpy",
	"heated",
	"off-the-rails",
] as const satisfies readonly DramaLevel[];

export const DRAMA_CATEGORIES = [
	"procedural_breakdown",
	"question_looping",
	"defensive_hedging",
	"timeline_pressure",
	"improvised_workarounds",
	"visible_dissent",
	"post_hoc_corrections",
] as const satisfies readonly DramaCategory[];

export const LEVEL_DISPLAY: Record<DramaLevel, string> = {
	routine: "Routine",
	bumpy: "Bumpy",
	heated: "Heated",
	"off-the-rails": "Off the Rails",
};

export const CATEGORY_DISPLAY: Record<DramaCategory, string> = {
	procedural_breakdown: "Procedural Breakdown",
	question_looping: "Question Looping",
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
