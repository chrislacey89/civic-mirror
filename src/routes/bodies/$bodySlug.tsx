import { createFileRoute, Link } from "@tanstack/react-router";
import type {
	BodyWithStats,
	FiscalByCategory,
	MeetingCardData,
} from "#/db/queries.ts";
import {
	aggregateFiscalByCategoryForBody,
	getBodyWithStatsBySlug,
	listRecentMeetings,
} from "#/server/meetings.ts";

type BodyProfileData = {
	body: BodyWithStats;
	meetings: MeetingCardData[];
	byCategory: FiscalByCategory[];
};

export const Route = createFileRoute("/bodies/$bodySlug")({
	loader: async ({ params }): Promise<BodyProfileData | null> => {
		const [body, meetings, byCategory] = await Promise.all([
			getBodyWithStatsBySlug({ data: { bodySlug: params.bodySlug } }),
			listRecentMeetings({ data: { bodySlug: params.bodySlug } }),
			aggregateFiscalByCategoryForBody({ data: { bodySlug: params.bodySlug } }),
		]);
		if (!body) return null;
		return { body, meetings, byCategory };
	},
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData?.body
					? `${loaderData.body.name} — Civic Mirror`
					: "Body Not Found — Civic Mirror",
			},
		],
	}),
	component: BodyProfilePage,
	notFoundComponent: () => (
		<main className="page-wrap px-4 pb-8 pt-14">
			<p className="text-center text-lg text-[var(--ink-soft)]">
				Governing body not found.
			</p>
		</main>
	),
});

function formatCurrency(amount: number): string {
	if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
	if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
	return `$${amount.toLocaleString()}`;
}

function formatDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	const date = new Date(Number(year), Number(month) - 1, Number(day));
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

function BodyProfilePage() {
	const data = Route.useLoaderData();

	if (!data) {
		return (
			<main className="page-wrap px-4 pb-8 pt-14">
				<p className="text-center text-lg text-[var(--ink-soft)]">
					Governing body not found.
				</p>
			</main>
		);
	}

	const { body, meetings, byCategory } = data;
	const maxCat = Math.max(...byCategory.map((c) => c.totalAmount), 1);

	return (
		<main className="page-wrap px-4 pb-8 pt-6">
			{/* Dateline */}
			<div className="mono flex flex-wrap justify-between gap-2 border-y border-[var(--rule)] bg-[var(--paper-alt)] px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--ink-soft)]">
				<span>
					<Link
						to="/bodies"
						className="font-bold text-[var(--accent)] no-underline hover:underline"
					>
						← BODIES
					</Link>
				</span>
				<span className="hidden sm:inline">Monroe Co., IN</span>
			</div>

			{/* Hero */}
			<section className="rise-in pt-10">
				<p className="kicker text-[var(--accent)]">
					Governing body ·{" "}
					{body.type === "town"
						? "Municipal"
						: body.type === "county"
							? "County"
							: "School District"}
				</p>
				<h1 className="display mt-3 text-[40px] leading-[1.0] tracking-[-0.025em] sm:text-[54px]">
					{body.name}
				</h1>

				{/* Quick stats */}
				<div className="rule-double mt-8 grid grid-cols-2 border-b-[3px] border-double border-[var(--rule)] sm:grid-cols-3">
					{[
						{ n: body.meetingCount, l: "Meetings YTD" },
						{ n: formatCurrency(body.totalSpending), l: "Approved YTD" },
						{ n: body.decisionCount, l: "Fiscal decisions" },
					].map((s, i, arr) => (
						<div
							key={s.l}
							className={`py-4 pr-4 ${i > 0 ? "pl-4" : ""} ${
								i < arr.length - 1
									? "sm:border-r sm:border-[var(--rule-soft)]"
									: ""
							}`}
						>
							<div className="display text-[28px] leading-none sm:text-[34px]">
								{s.n}
							</div>
							<div className="kicker mt-2">{s.l}</div>
						</div>
					))}
				</div>
			</section>

			{/* Roster placeholder */}
			<section className="mt-12">
				<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
					<p className="kicker">The Roster</p>
					<h2 className="display mt-1 text-[26px]">Who's on the dais</h2>
				</div>
				<div className="paper-card-alt mt-4 p-6">
					<p className="mono text-[11px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
						Roster data coming soon — member attendance and tenure will appear
						here once the pipeline includes structured roster ingestion.
					</p>
				</div>
			</section>

			{/* Recent meetings */}
			{meetings.length > 0 && (
				<section className="mt-12">
					<div className="rule-double flex items-end justify-between border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
						<div>
							<p className="kicker">Recent meetings</p>
							<h2 className="display mt-1 text-[26px]">
								Last {meetings.length} on file
							</h2>
						</div>
						<span className="mono hidden text-[11px] uppercase tracking-[0.12em] text-[var(--ink-soft)] sm:block">
							Newest first
						</span>
					</div>
					<div className="mt-2 border-t border-[var(--rule)]">
						{meetings.map((m, i) => (
							<Link
								key={m.id}
								to="/meetings/$bodySlug/$date"
								params={{ bodySlug: m.bodySlug, date: m.date }}
								className={`block py-4 no-underline hover:bg-[var(--paper-alt)] ${
									i < meetings.length - 1
										? "border-b border-dotted border-[var(--rule-dot)]"
										: ""
								}`}
							>
								<div className="mono mb-1 flex justify-between text-[10px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
									<span>{formatDate(m.date)}</span>
									<span>{m.meetingType}</span>
								</div>
								<p className="display m-0 text-[18px] leading-[1.2] text-[var(--ink)]">
									{m.highlights[0] ?? `${m.bodyName} — ${m.date}`}
								</p>
								<div className="mono mt-2 flex flex-wrap gap-3 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-soft)]">
									{m.totalSpending > 0 && (
										<span className="money-pill">
											{formatCurrency(m.totalSpending)}
										</span>
									)}
									<span>{m.fiscalDecisionCount} decisions</span>
								</div>
							</Link>
						))}
					</div>
				</section>
			)}

			{/* Spending by category */}
			{byCategory.length > 0 && (
				<section className="mt-12">
					<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
						<p className="kicker">Where this body spent</p>
						<h2 className="display mt-1 text-[26px]">
							YTD: {formatCurrency(body.totalSpending)}
						</h2>
					</div>
					<div className="mt-2 border-t border-[var(--rule)]">
						{byCategory.map((c, i) => (
							<div
								key={c.budgetCategory}
								className={`py-3 ${
									i < byCategory.length - 1
										? "border-b border-dotted border-[var(--rule-dot)]"
										: ""
								}`}
							>
								<div className="flex items-baseline justify-between gap-2">
									<span className="text-[14px] font-semibold capitalize text-[var(--ink)]">
										{c.budgetCategory}
									</span>
									<span className="mono text-[12px] font-bold text-[var(--ink)]">
										{formatCurrency(c.totalAmount)}
									</span>
								</div>
								<div className="mt-1.5 h-[8px] border border-[var(--rule-soft)] bg-[var(--paper-alt)]">
									<div
										style={{
											width: `${(c.totalAmount / maxCat) * 100}%`,
											height: "100%",
											background: i === 0 ? "var(--accent)" : "var(--ink)",
										}}
									/>
								</div>
								<div className="mono mt-1 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
									{c.decisionCount} decision{c.decisionCount !== 1 ? "s" : ""}
								</div>
							</div>
						))}
					</div>
				</section>
			)}

			{meetings.length === 0 && byCategory.length === 0 && (
				<div className="paper-card mt-10 p-8 text-center">
					<p className="text-[14px] text-[var(--ink-soft)]">
						No meeting data yet for this body.
					</p>
				</div>
			)}
		</main>
	);
}
