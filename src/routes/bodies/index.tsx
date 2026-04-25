import { createFileRoute, Link } from "@tanstack/react-router";
import type { BodyWithStats } from "#/db/queries.ts";
import { listBodiesWithStats } from "#/server/meetings.ts";

export const Route = createFileRoute("/bodies/")({
	loader: async (): Promise<BodyWithStats[]> => {
		return await listBodiesWithStats({ data: undefined });
	},
	head: () => ({
		meta: [{ title: "Governing Bodies — Civic Mirror" }],
	}),
	component: BodiesIndexPage,
});

function formatCurrency(amount: number): string {
	if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
	if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
	return `$${amount.toLocaleString()}`;
}

function BodiesIndexPage() {
	const bodies = Route.useLoaderData();

	return (
		<main className="page-wrap px-4 pb-8 pt-6">
			<div className="mono flex flex-wrap justify-between gap-2 border-y border-[var(--rule)] bg-[var(--paper-alt)] px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--ink-soft)]">
				<span>
					<span className="font-bold text-[var(--accent)]">
						GOVERNING BODIES
					</span>{" "}
					— Monroe Co., IN
				</span>
				<span className="hidden sm:inline">{bodies.length} bodies indexed</span>
			</div>

			<section className="rise-in pt-10">
				<p className="kicker text-[var(--accent)]">Bodies · Indexed</p>
				<h1 className="display mt-3 text-[40px] leading-[1.0] tracking-[-0.025em] sm:text-[56px]">
					Who governs Ellettsville
				</h1>
				<p className="lede mt-5 max-w-[72ch] text-[18px] leading-[1.5]">
					Eight local governing bodies — every meeting summarized, every dollar
					tracked.
				</p>
			</section>

			{bodies.length === 0 ? (
				<div className="paper-card mt-10 p-8 text-center">
					<p className="text-[14px] text-[var(--ink-soft)]">
						No governing bodies on file yet. Check back after the pipeline
						processes its first batch.
					</p>
				</div>
			) : (
				<section className="mt-12">
					<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
						<p className="kicker">All bodies · {bodies.length} on file</p>
						<h2 className="display mt-1 text-[26px]">
							Every gavel, every body
						</h2>
					</div>

					<div className="mt-2 border-t border-[var(--rule)]">
						{bodies.map((body, i) => (
							<Link
								key={body.slug}
								to="/bodies/$bodySlug"
								params={{ bodySlug: body.slug }}
								className={`grid grid-cols-[1fr_auto] items-center gap-4 py-5 no-underline hover:bg-[var(--paper-alt)] ${
									i < bodies.length - 1
										? "border-b border-dotted border-[var(--rule-dot)]"
										: ""
								}`}
							>
								<div>
									<div className="mono mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--ink-soft)]">
										{body.type === "town"
											? "Municipal"
											: body.type === "county"
												? "County"
												: "School District"}{" "}
										· Monroe Co., IN
									</div>
									<h3 className="display m-0 text-[22px] leading-tight text-[var(--ink)]">
										{body.name}
									</h3>
									<div className="mono mt-2 flex flex-wrap gap-4 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-soft)]">
										<span>{body.meetingCount} meetings</span>
										<span>{body.decisionCount} decisions</span>
									</div>
								</div>
								<div className="text-right">
									{body.totalSpending > 0 && (
										<div className="money-pill">
											{formatCurrency(body.totalSpending)}
										</div>
									)}
									<div className="mono mt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--ink-soft)]">
										YTD approved
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
