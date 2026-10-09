/** The full checklist the principles below condense. */
export const RUBRIC_URL =
	"https://github.com/chrislacey89/civic-mirror/blob/prod/docs/writing-rubric.md";

/** Where a reader reports a summary that misses the standard. */
export const REPORT_URL =
	"https://github.com/chrislacey89/civic-mirror/issues/new";

export const WRITING_PRINCIPLES: readonly string[] = [
	"Lead with the thing a neighbor would care about, not the first item on the agenda.",
	"Say who decided, in plain words: “the council voted 4–0,” not “it was approved.”",
	"Cut the ceremony: prayers, pledges, roll call, minutes and paying the bills.",
	"Translate the town’s jargon, and say what a thing does, not only what it is called.",
	"Never name residents who speak at public comment; officials and staff are named with their roles.",
	"Keep every figure exactly as the public record states it, with no estimates and no sums of our own.",
	"Short paragraphs, one item each.",
	"Length follows the meeting; keep anything a resident could act on, like a hearing date.",
];

export interface WriteUp {
	/** The first highlight is the headline. */
	highlights: readonly string[];
	/** Paragraphs separated by a blank line. */
	prose: string;
}

export interface WritingExample {
	bodyName: string;
	bodySlug: string;
	date: string;
	/** Set when the body met more than once on the date. */
	session?: string;
	context: string;
	sources: readonly { label: string; url: string }[];
	/** The machine-drafted summary as first published, unedited. */
	before: WriteUp;
	/** The same meeting rewritten by hand to the standard. */
	after: WriteUp;
}

/**
 * Meetings whose "before" text names no resident who spoke at public comment,
 * so it can be shown unedited.
 */
export const WRITING_EXAMPLES: readonly WritingExample[] = [
	{
		bodyName: "Ellettsville Town Council",
		bodySlug: "ellettsville-town-council",
		date: "2026-05-26",
		context:
			"A regular meeting: a street resurfacing bid, a zoning change and a planning contract.",
		sources: [
			{
				label: "Meeting minutes (PDF)",
				url: "https://ellettsville.in.us/egov/apps/document/center.egov?view=item&id=1756",
			},
			{
				label: "Meeting video",
				url: "https://www.youtube.com/watch?v=edrU7TqXhP8",
			},
		],
		before: {
			highlights: [
				"The Council approved a $139,775.03 bid from Milestone Contractors for street resurfacing.",
				"Ordinance 2026-09, rezoning two parcels at 5010 N. Lakeview Drive from Commercial 2 (C-2) to Residential 2 (R-2), was approved.",
				"A $29,425.00 proposal from Taylor, Siefker Williams Design Group to update the Comprehensive Plan, Unified Development Ordinance, and Zoning Map was approved, conditional on the reorganization approval by both the Ellettsville Town Council and the Richland Township Board.",
				"Accounts Payable Vouchers and Payroll were approved for payment.",
				"The passing of Anise Osborn, Ellettsville's oldest resident, was announced.",
			],
			prose:
				"The Ellettsville Town Council convened for a regular meeting on May 26, 2026, led by President Scott Oldham. The minutes from the May 11, 2026 meeting were approved, followed by the approval of Accounts Payable Vouchers and Payroll. DPW Director Kip Headdy presented the bids for the street resurfacing project, with Milestone Contractors submitting the lowest bid of $139,775.03, which the Council subsequently approved.\n\nNext, the Council addressed Ordinance 2026-09 on its second reading, concerning a petition for a zoning map amendment. Planning Director Denise Line explained the request by Kevin Farris to rezone two parcels at 5010 N. Lakeview Drive, totaling 2.03 acres, from Commercial 2 (C-2) to Residential 2 (R-2) Medium Density Residential. The Plan Commission had previously issued a unanimous favorable recommendation, and the Council approved the ordinance.\n\nUnder new business, Town Attorney Darla Brown introduced a proposal from Taylor, Siefker Williams Design Group for $29,425.00. This proposal aims to update and amend the Town's Comprehensive Plan, Unified Development Ordinance (UDO), and Official Zoning Map to integrate Richland Township, in anticipation of a reorganization. Following a discussion, particularly regarding the timing of this expenditure prior to the reorganization's final approval, the Council approved the proposal. This approval was made conditional on the reorganization receiving approval from both the Ellettsville Town Council and the Richland Township Board. The meeting concluded with Council comments, including President Oldham's announcement of the passing of Anise Osborn, who was 105 years old.",
		},
		after: {
			highlights: [
				"Council accepts $139,775.03 bid to resurface five streets",
				"Council votes 4–0 to pay $29,425 for zoning rules covering Richland Township, if the merger passes",
				"Two parcels at 5010 N. Lakeview Drive rezoned from commercial to residential for four homes",
				"Anise Osborn, the town's oldest resident, has died at 105",
			],
			prose:
				"Milestone Contractors was the lowest of three bidders for South Deer Run, East Benjamin Street, South Lantern Lane, East Appomattox Court and North Daisy Drive. Trevor Sager was absent, and every vote was 4–0.\n\nThe council also voted to pay Taylor, Siefker & Williams Design Group $29,425 to rewrite the town's comprehensive plan, zoning rules and zoning map so they take in Richland Township. That money is spent only if both the council and the Richland Township board approve the proposed merger of the town and the township. Dan Swafford asked why the town would commit it before the merger vote. Town Attorney Darla Brown said that without the rewrite the township would have no zoning code on the day a merger took effect, and Planning Director Denise Line said the last such rewrite took nine to ten months of meetings.\n\nThe council rezoned two parcels at 5010 N. Lakeview Drive, 2.03 acres in all, from commercial to medium-density residential so petitioner Kevin Farris can build four single-family lots. The Plan Commission had recommended the change unanimously.\n\nCouncil president Scott Oldham announced the death of Anise Osborn, the town's oldest resident, at 105.",
		},
	},
	{
		bodyName: "Ellettsville Town Council",
		bodySlug: "ellettsville-town-council",
		date: "2026-07-27",
		context:
			"A long meeting with twelve spending decisions, covered from the video alone.",
		sources: [
			{
				label: "Meeting video",
				url: "https://www.youtube.com/watch?v=vrUh8hv-Ey4",
			},
		],
		before: {
			highlights: [
				"The Town Council approved multiple additional appropriations and fund transfers for various departments, including MVH, Clerk's, DPW, Fire, Police, and Planning.",
				"A total of $29,566.82 was transferred from MVH restricted funds for a local roads and bridge matching grant.",
				"Additional appropriations were approved for the Clerk's Department ($111,767), DPW Department ($182,834.09), Fire Department ($52,000), Police Department ($111,031.40), and Planning Department ($65,127).",
				"Police Department funds were transferred across several lines to cover physicals/testing, radar equipment, and building maintenance (AC repair).",
				"A $10,000 transfer was approved for town improvements, specifically for paving at the fire department.",
				"Ordinance 2026-11, a wholesale water rate tracker ordinance to adjust water rates to reflect increased costs from Bloomington Utilities, was approved.",
				"A monthly retainer contract for engineering services with Copic SLT LLC was approved for $750 per month.",
				"Ordinance 2026-13 to amend the employee handbook for police department holiday hours was tabled for future review with other policy changes.",
				"The voluntary annexation of 5326 and 5328 West Woodyard Road, owned by Dan Rary, was conditionally approved pending township approval.",
				"A council member expressed concern regarding the high number of additional appropriations already made halfway through the year.",
			],
			prose:
				"The Ellettsville Town Council convened on Monday, July 27, 2026. Following the invocation, pledge, and roll call, the council postponed the approval of minutes from the July 13, 2026, meeting. The accounts payable, vouchers, and payroll were approved. The council then proceeded to address a series of resolutions concerning fund transfers and additional appropriations for various town departments. Resolution 13-2026 approved a transfer of $29,566.82 from MVH restricted funds to the local roads and bridge matching fund for a community crossings grant. Resolution 14-2026 approved an additional appropriation of $111,767 for the Clerk's Department, covering services from Baker Tilly, an increase in the Monroe County Animal Control contract, the Fields and Company communications contract, and a server update. For the DPW Department, Resolution 15-2026 approved an additional appropriation of $182,834.09 for paving and other work, clarifying an initially stated lower amount. Resolution 16-2026 allocated an additional $52,000 to the Fire Department for overtime due to staffing shortages and increased calls. The Police Department received an additional appropriation of $111,031.40 under Resolution 17-2026 to cover overtime and an open officer position. The Planning Department's Resolution 18-2026 approved an additional $65,127 for a Heritage Trail plan update and updates to the UDO, comprehensive plan, and zoning map. Resolution 19-2026 authorized several fund transfers within the Police Department, including $2,000 from uniforms to physicals, $22,000 from vehicles to radar equipment, and a combined $15,195 from body armor and tasers/camera equipment to building maintenance for an AC repair. Resolution 20-2026 adopted a fiscal plan for the annexation petition by Daniel Rary. Resolution 21-2026 approved a $10,000 transfer for town improvements to pave the fire department's approach. The council approved Ordinance 2026-12 for the voluntary annexation of 5326 and 5328 West Woodyard Road, conditional upon township approval. Ordinance 2026-10 was passed to amend the town code to add a three-way stop intersection. Ordinance 2026-11, a wholesale water rate tracker ordinance, was approved to adjust water rates to reflect increased costs from the City of Bloomington Utilities. Ordinance 2026-13, regarding police department holiday hours, was tabled for future discussion. A retainer contract for engineering services with Rick Copic (Copic SLT LLC) for $750 per month was also approved. During supervisor comments, upcoming budget meetings were announced, and a discussion occurred about the consolidated budget for reorganization and the need for township input. The condition of the wastewater plant and potential future replacement costs were mentioned, and the feasibility of reopening old wells was discussed and deemed economically unfeasible. A council member expressed concern about the numerous additional appropriations already approved. The meeting concluded with no further business.",
		},
		after: {
			highlights: [
				"Water rates to rise as council passes on Bloomington's wholesale increase",
				"Fire gets $52,000 and police $55,000 more for overtime, both short of full-time staff",
				"Public works gets $182,834.09 to pave streets the shrunken state road grant left out",
				"47.86 acres at 5326 and 5328 West Woodyard Road annexed, if the township board agrees",
				"South Ridge Lane at North Sycamore and North Wallace Harmon Way becomes a three-way stop",
				"Staff warn a clarifier at the 1997 wastewater plant will cost about half a million dollars to replace",
			],
			prose:
				"Five departments got permission to spend beyond this year's budget, from police overtime to a redesign of the Heritage Trail. Every vote was 4–0.\n\nThe water utility will raise what it charges per thousand gallons by the same amount that City of Bloomington Utilities, which supplies the town's water, raised its wholesale rate. Staff called it a penny-for-penny pass-through.\n\nThe fire department got $52,000 and the police $55,000 for overtime, both because full-time positions are unfilled. The police total of $111,031.40 also covers an officer's position left open by a retirement. The clerk's office got $59,000 for Baker Tilly's accounting work, $9,142 for a 61.9 percent increase in the Monroe County animal-control contract, $27,300 to carry the Fields and Company communications contract through December, and $6,325 toward new servers. Public works got $182,834.09, of which $147,834.09 is grant money passing through. Planning got $65,127: new engineered plans for the Heritage Trail, which the state required after the route changed, and the $29,425 zoning rewrite tied to the proposed merger with Richland Township.\n\nThe council put off a police holiday-pay ordinance to combine it with other personnel changes. One council member said the number of mid-year appropriations by July concerned them.",
		},
	},
	{
		bodyName: "Ellettsville Town Council",
		bodySlug: "ellettsville-town-council",
		date: "2026-10-05",
		session: "budget-pre-adoption-hearing",
		context:
			"A public hearing on the 2027 budget. Nobody voted; the town explained what it is proposing.",
		sources: [
			{
				label: "Meeting video",
				url: "https://www.youtube.com/watch?v=Pad6fA9ouyU",
			},
		],
		before: {
			highlights: [
				"Proposed 2027 budget for Ellettsville was presented during a public hearing, outlining departmental appropriations and funding sources.",
				"Two alternative scenarios for fire department funding were detailed, contingent on the November 3rd reorganization vote: a municipal fire structure and a special fire protection territory structure.",
				"Discussions covered the estimated property tax impacts of consolidation versus the fire territory, with varying figures presented for homes of different values in town and township.",
				"The next budget meeting is scheduled for October 19th at 6:30 p.m.",
			],
			prose:
				"The Ellettsville Town Council held a public hearing for the proposed 2027 budget on October 5, 2026. The meeting commenced at 6:30 p.m. with a presentation by the town manager and staff. The presentation detailed the overall financial plan, including estimated beginning cash, 2027 receipts, and proposed appropriations, while noting that a negative projected surplus or deficit does not automatically indicate insolvency but rather that proposed appropriations exceed revenue estimates. A significant portion of the discussion focused on the fire department budget, which presented two distinct scenarios: a municipal fire structure (totaling $4,242,455) if the November 3rd reorganization is approved, and a special fire protection territory structure (totaling $4,168,425) if it is not. Other departmental budgets presented included the police department ($2.2 million primary fund), township assistance ($530,000), administration (stated as '1 million JD460'), planning and zoning ($589,159), public works ($1,661,324), and parks and recreation ($112,400). Debt appropriations were proposed at $379,341. A lengthy discussion ensued regarding the property tax implications of consolidation versus fire territory creation. Estimates for a $200,000 home showed a small difference in annual increase between consolidation ($66+) and no consolidation ($64), though an internal contradiction in the transcript noted a '$150 difference' which was affirmed. For a $300,000 home in town, no additional tax cost was anticipated, while a $300,000 home in the township was estimated to see an increase of $173 with consolidation and $288 without. The council members noted that they had been involved in the budget process for months, expressing no surprises or immediate questions. The public was encouraged to review the proposed budget and submit questions before the next budget meeting on October 19th.",
		},
		after: {
			highlights: [
				"A $200,000 town home pays $66 or more a year with the merger, $64 without",
				"Fire costs $4,242,455 as a town department, or $4,168,425 as a separate fire territory",
				"A $300,000 home in the township pays $173 more with the merger, $288 without",
				"Next budget meeting is a special meeting October 19, 6:30 p.m.",
			],
			prose:
				'The town laid out two 2027 budgets, one for each outcome of the November 3 vote on merging with Richland Township. If voters approve the merger, the fire department becomes a town department with a $4,242,455 budget. If they reject it, a separate fire protection territory runs it for $4,168,425 and the town cuts its other budgets to match. Staff put the difference at about $74,000.\n\nOn a $200,000 home in town, staff said, taxes rise $66 a year or more with the merger and $64 without. A $300,000 home in town sees no increase either way. In the township the gap is wider: $173 more on a $300,000 home with the merger and $288 without, figures a council member asked staff to confirm. The presenter cautioned that each bill depends on assessed value, levies and state certification, so the estimates carry a margin of error.\n\nOther proposed budgets: police about $2.2 million from a new municipal police fund plus income-tax funds; township assistance $530,000; planning $589,159; parks $112,400; debt payments $379,341. The budget was posted at 6:30 p.m., and a council member asked residents to "take this budget apart" before October 19.',
		},
	},
];
