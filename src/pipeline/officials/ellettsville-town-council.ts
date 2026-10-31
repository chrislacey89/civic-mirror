import type { Official } from "./types.ts";

/**
 * Seeded from the stored minutes by scripts/seed-officials.ts; a person reviews
 * every entry. `served.from` is the first meeting whose minutes print the name, not
 * the start of the term. Names here are spelled as the minutes usually spell them.
 */
export const ELLETTSVILLE_TOWN_COUNCIL: readonly Official[] = [
	{
		name: "Scott Oldham",
		variants: [],
		role: "Town Council President",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Dan Swafford",
		variants: [],
		role: "Town Council Vice President",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "William Ellis",
		variants: [],
		role: "Town Council member",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Trevor Sager",
		variants: [],
		role: "Town Council member",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Pamela Samples",
		variants: [],
		role: "Town Council member",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Noelle Conyer",
		variants: [],
		role: "Clerk Treasurer",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Kelley Cantrell",
		variants: [],
		role: "Deputy Clerk",
		served: { from: "2025-06-09", to: null },
	},
	{
		name: "Michael Farmer",
		variants: ["Mike Farmer"],
		role: "Town Manager",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Darla Brown",
		variants: [],
		role: "Town Attorney",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Denise Line",
		variants: [],
		role: "Planning Director",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Kevin Patton",
		variants: [],
		role: "Fire Chief",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Chris Clouse",
		variants: [],
		role: "Deputy Fire Chief",
		served: { from: "2025-07-24", to: null },
	},
	{
		name: "Jimmie Durnil",
		variants: [],
		role: "Town Marshal",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "George Robinson",
		variants: [],
		role: "Deputy Town Marshal",
		served: { from: "2025-07-24", to: null },
	},
	{
		name: "Kip Headdy",
		variants: [],
		role: "Street Commissioner and DPW Director",
		served: { from: "2025-05-27", to: null },
	},
	{
		name: "Jeff Farmer",
		variants: [],
		role: "Wastewater Supervisor",
		served: { from: "2025-05-27", to: null },
	},
];
