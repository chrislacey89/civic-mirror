import { ELLETTSVILLE_PLAN_COMMISSION } from "./ellettsville-plan-commission.ts";
import { ELLETTSVILLE_TOWN_COUNCIL } from "./ellettsville-town-council.ts";
import { MONROE_COUNTY_COMMISSIONERS } from "./monroe-county-commissioners.ts";
import { RBB_SCHOOL_BOARD } from "./rbb-school-board.ts";
import type { Official } from "./types.ts";

/** Each body's hand-maintained list, by body slug. */
export const OFFICIALS_BY_BODY: Readonly<Record<string, readonly Official[]>> =
	{
		"ellettsville-town-council": ELLETTSVILLE_TOWN_COUNCIL,
		"ellettsville-plan-commission": ELLETTSVILLE_PLAN_COMMISSION,
		"monroe-county-commissioners": MONROE_COUNTY_COMMISSIONERS,
		"rbb-school-board": RBB_SCHOOL_BOARD,
	};

/** Those of `officials` serving on an ISO `date`, both end dates included. */
export function servingOn(
	officials: readonly Official[],
	date: string,
): readonly Official[] {
	return officials.filter(
		({ served }) =>
			served.from <= date && (served.to === null || date <= served.to),
	);
}

/** The officials of a body who were serving on the date of a meeting. */
export function officialsFor(
	bodySlug: string,
	meetingDate: string,
): readonly Official[] {
	return servingOn(OFFICIALS_BY_BODY[bodySlug] ?? [], meetingDate);
}
