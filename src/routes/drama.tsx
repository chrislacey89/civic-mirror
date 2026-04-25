import { createFileRoute, Link } from "@tanstack/react-router";
import type { MeetingCardData } from "#/db/queries.ts";
import { listRecentMeetings } from "#/server/meetings.ts";

export const Route = createFileRoute("/drama")({
	loader: async (): Promise<MeetingCardData[]> => {
		return await listRecentMeetings({ data: {} });
	},
	head: () => ({
		meta: [{ title: "Drama Watch — Civic Mirror" }],
	}),
	component: DramaPage,
});

function formatDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	const date = new Date(Number(year), Number(month) - 1, Number(day));
	return date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

function DramaPage() {
	const meetings = Route.useLoaderData();

	return (
		<main className="page-wrap px-4 pb-8 pt-6">
			<div className="mono flex flex-wrap justify-between gap-2 border-y border-[var(--rule)] bg-[var(--paper-alt)] px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--ink-soft)]">
				<span>
					<span className="font-bold text-[var(--accent)]">DRAMA WATCH</span> —
					Archive
				</span>
				<span className="hidden sm:inline">
					Flagging circular debate · fixations · personal grievances
				</span>
			</div>

			<section className="rise-in pt-10">
				<p className="kicker text-[var(--accent)]">Drama Watch · Archive</p>
				<h1 className="display mt-3 text-[40px] leading-[1.0] tracking-[-0.025em] sm:text-[56px]">
					Every meeting that wasted your time, logged
				</h1>
				<p className="lede mt-5 max-w-[72ch] text-[18px] leading-[1.5]">
					We flag circular debate, fixations, and personal grievances that cost
					more than ten minutes. No gossip — just minutes spent on nothing.
				</p>
			</section>

			<section className="mt-12">
				<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
					<p className="kicker">Detection status</p>
					<h2 className="display mt-1 text-[26px]">Drama detection pipeline</h2>
				</div>

				<div className="paper-card-alt mt-6 p-8">
					<div className="mono mb-3 inline-block border border-[var(--ink)] bg-[var(--ink)] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--highlight)]">
						In progress
					</div>
					<p className="display text-[22px] leading-tight">
						Drama classification is being added to the pipeline
					</p>
					<p className="mt-3 max-w-[60ch] text-[14px] leading-[1.6] text-[var(--ink-mid)]">
						The AI will flag petty arguments, fixations, and circular debates
						with a drama level, headline, and minute count. Once the pipeline
						runs, incidents will appear here in chronological order with filters
						for Pettiness, Heated, and Unresolved.
					</p>
					<p className="mono mt-5 text-[11px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
						What we'll surface: fixation · circular debate · personal anecdote ·
						conflict of interest
					</p>
				</div>
			</section>

			{meetings.length > 0 && (
				<section className="mt-14">
					<div className="rule-double flex items-end justify-between border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
						<div>
							<p className="kicker">Recent meetings · Indexed</p>
							<h2 className="display mt-1 text-[26px]">
								Meetings on file — drama TBD
							</h2>
						</div>
						<span className="mono hidden text-[11px] uppercase tracking-[0.12em] text-[var(--ink-soft)] sm:block">
							{meetings.length} meetings
						</span>
					</div>

					<div className="mt-4 border-t border-[var(--rule)]">
						{meetings.map((m) => (
							<Link
								key={m.id}
								to="/meetings/$bodySlug/$date"
								params={{ bodySlug: m.bodySlug, date: m.date }}
								className="grid grid-cols-[64px_1fr] gap-4 border-b border-dotted border-[var(--rule-dot)] py-4 no-underline hover:bg-[var(--paper-alt)]"
							>
								<div className="mono border-r border-[var(--rule-soft)] pr-3 text-right">
									<div className="text-[10px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
										{formatDate(m.date).split(" ")[0].slice(0, 3).toUpperCase()}
									</div>
									<div className="display text-[22px] leading-none text-[var(--ink)]">
										{formatDate(m.date).split(" ")[1]}
									</div>
								</div>
								<div>
									<div className="mono mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--accent)]">
										{m.bodyName}
									</div>
									<p className="display m-0 text-[17px] leading-[1.2] text-[var(--ink)]">
										{m.highlights[0] ?? `${m.bodyName} — ${m.date}`}
									</p>
									<div className="mono mt-2 flex flex-wrap gap-3 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-soft)]">
										{m.totalSpending > 0 && (
											<span className="money-pill">
												{formatCurrency(m.totalSpending)}
											</span>
										)}
										<span>{m.fiscalDecisionCount} decisions</span>
										<span className="text-[var(--ink-faint)]">
											Drama: pending
										</span>
									</div>
								</div>
							</Link>
						))}
					</div>
				</section>
			)}
		</main>
	);
}

function formatCurrency(amount: number): string {
	if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
	if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
	return `$${amount.toLocaleString()}`;
}
