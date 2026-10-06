import { createFileRoute, Link } from "@tanstack/react-router";
import type {
	FiscalByBody,
	FiscalByCategory,
	FiscalByTimePeriod,
	FiscalDecisionRow,
	FiscalStatus,
} from "#/db/queries.ts";
import {
	aggregateFiscalByBody,
	aggregateFiscalByCategory,
	aggregateFiscalByTimePeriod,
	listFiscalDecisions,
} from "#/server/meetings.ts";

type SpendingData = {
	byBody: FiscalByBody[];
	byCategory: FiscalByCategory[];
	byTimePeriod: FiscalByTimePeriod[];
	decisions: FiscalDecisionRow[];
};

export const Route = createFileRoute("/spending")({
	validateSearch: (search: Record<string, unknown>) => ({
		body:
			typeof search.body === "string" ? search.body || undefined : undefined,
		category:
			typeof search.category === "string"
				? search.category || undefined
				: undefined,
		period:
			typeof search.period === "string"
				? search.period || undefined
				: undefined,
	}),
	loaderDeps: ({ search }) => ({
		body: search.body,
		category: search.category,
		period: search.period,
	}),
	loader: async ({ deps }): Promise<SpendingData> => {
		const [byBody, byCategory, byTimePeriod, decisions] = await Promise.all([
			aggregateFiscalByBody(),
			aggregateFiscalByCategory(),
			aggregateFiscalByTimePeriod(),
			listFiscalDecisions({
				data: {
					bodySlug: deps.body,
					category: deps.category,
					period: deps.period,
				},
			}),
		]);
		return { byBody, byCategory, byTimePeriod, decisions };
	},
	head: () => ({
		meta: [{ title: "Spending Dashboard — Civic Mirror" }],
	}),
	component: SpendingRoute,
});

function formatCurrency(amount: number): string {
	if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
	if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
	return `$${amount.toLocaleString()}`;
}

function formatCurrencyFull(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 0,
		maximumFractionDigits: 0,
	}).format(amount);
}

function formatMonth(period: string): string {
	const [year, month] = period.split("-");
	const date = new Date(Number(year), Number(month) - 1);
	return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function tagClass(status: FiscalStatus): string {
	switch (status) {
		case "approved":
			return "tag tag--approved";
		case "denied":
			return "tag tag--denied";
		case "tabled":
			return "tag tag--tabled";
	}
}

function SpendingRoute() {
	const data = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();

	const hasData =
		data.byBody.length > 0 ||
		data.byCategory.length > 0 ||
		data.byTimePeriod.length > 0;

	const activeFilters = [
		search.body && { key: "body", label: `Body: ${search.body}` },
		search.category && {
			key: "category",
			label: `Category: ${search.category}`,
		},
		search.period && { key: "period", label: `Period: ${search.period}` },
	].filter(Boolean) as { key: string; label: string }[];

	const totalTracked = data.byBody.reduce((sum, b) => sum + b.totalAmount, 0);
	const totalDecisions = data.byBody.reduce(
		(sum, b) => sum + b.decisionCount,
		0,
	);
	const maxByBody = Math.max(...data.byBody.map((b) => b.totalAmount), 1);
	const maxByCategory = Math.max(
		...data.byCategory.map((b) => b.totalAmount),
		1,
	);
	const timeOrdered = [...data.byTimePeriod].reverse();
	const maxTimePeriod = Math.max(...timeOrdered.map((t) => t.totalAmount), 1);

	return (
		<main className="page-wrap px-4 pb-8 pt-6">
			<div className="mono flex flex-wrap justify-between gap-2 border-y border-[var(--rule)] bg-[var(--paper-alt)] px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--ink-soft)]">
				<span>
					<span className="font-bold text-[var(--accent)]">THE LEDGER</span> —
					Fiscal transparency
				</span>
				<span className="hidden sm:inline">
					{formatCurrency(totalTracked)} tracked · {totalDecisions} decisions
				</span>
			</div>

			<section className="rise-in pt-10">
				<p className="kicker text-[var(--accent)]">Spending · FY to date</p>
				<h1 className="display mt-3 text-[40px] leading-[1.0] tracking-[-0.025em] sm:text-[56px]">
					Where the money went
				</h1>
				<p className="lede mt-5 max-w-[72ch] text-[18px] leading-[1.5]">
					Every fiscal decision by every governing body, broken out by body,
					category, and month. Click any row to drill into the meeting where the
					decision was made.
				</p>
			</section>

			{activeFilters.length > 0 && (
				<div className="mono mt-6 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-[var(--ink-soft)]">
					<span>Filtered by:</span>
					{activeFilters.map((filter) => (
						<span
							key={filter.key}
							className="border border-[var(--ink)] bg-[var(--paper)] px-2 py-1 font-bold text-[var(--ink)]"
						>
							{filter.label}
						</span>
					))}
					<button
						type="button"
						onClick={() =>
							navigate({
								search: {
									body: undefined,
									category: undefined,
									period: undefined,
								},
							})
						}
						className="mono px-2 py-1 font-bold tracking-[0.14em] text-[var(--accent)] underline decoration-[var(--accent)]/40 underline-offset-[3px] hover:decoration-[var(--accent)]"
					>
						Clear all
					</button>
				</div>
			)}

			{!hasData ? (
				<section className="paper-card mt-10 p-10 text-center">
					<p className="display text-[22px]">No fiscal data available yet</p>
					<p className="mt-2 text-[14px] text-[var(--ink-soft)]">
						Spending data will appear here once the pipeline processes meeting
						minutes with fiscal decisions.
					</p>
				</section>
			) : (
				<>
					{/* Three-column ledger ruling */}
					<div className="mt-12 grid gap-10 lg:grid-cols-[1.1fr_1fr_1fr]">
						{/* By body — horizontal bars */}
						{data.byBody.length > 0 && (
							<div>
								<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3">
									<p className="kicker">By Body</p>
									<h2 className="display mt-1 text-[22px]">Who spent what</h2>
								</div>
								<div className="mt-2">
									{data.byBody.map((row, i) => (
										<button
											key={row.bodySlug}
											type="button"
											onClick={() =>
												navigate({
													search: { ...search, body: row.bodySlug },
												})
											}
											className="block w-full border-b border-dotted border-[var(--rule-dot)] py-3 text-left hover:bg-[var(--paper-alt)]"
										>
											<div className="mono flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-soft)]">
												<span className="text-[13px] font-semibold normal-case tracking-normal text-[var(--ink)]">
													{row.bodyName}
												</span>
												<span className="font-bold">
													{formatCurrency(row.totalAmount)}
												</span>
											</div>
											<div className="mt-1.5 h-[8px] border border-[var(--rule-soft)] bg-[var(--paper-alt)]">
												<div
													style={{
														width: `${(row.totalAmount / maxByBody) * 100}%`,
														height: "100%",
														background:
															i === 0 ? "var(--accent)" : "var(--ink)",
													}}
												/>
											</div>
											<div className="mono mt-1 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
												{row.decisionCount} decision
												{row.decisionCount !== 1 ? "s" : ""}
											</div>
										</button>
									))}
								</div>
							</div>
						)}

						{/* Time series — column strip */}
						{timeOrdered.length > 0 && (
							<div>
								<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3">
									<p className="kicker">Monthly pace</p>
									<h2 className="display mt-1 text-[22px]">
										The cadence of the year
									</h2>
								</div>
								<div
									className="mt-6 grid items-end gap-2"
									style={{
										gridTemplateColumns: `repeat(${timeOrdered.length}, 1fr)`,
										height: 160,
									}}
								>
									{timeOrdered.map((row) => {
										const height = (row.totalAmount / maxTimePeriod) * 140;
										const isCurrent =
											row.period === timeOrdered[timeOrdered.length - 1].period;
										return (
											<button
												key={row.period}
												type="button"
												onClick={() =>
													navigate({
														search: { ...search, period: row.period },
													})
												}
												className="flex flex-col items-center justify-end gap-1 text-center hover:opacity-75"
											>
												<span className="mono text-[10px] font-bold text-[var(--ink)]">
													{formatCurrency(row.totalAmount)}
												</span>
												<span
													style={{
														width: "70%",
														height,
														background: isCurrent
															? "var(--accent)"
															: "var(--ink)",
													}}
												/>
												<span className="mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-soft)]">
													{formatMonth(row.period)}
												</span>
											</button>
										);
									})}
								</div>
								<div className="rule-dot mono mt-3 flex justify-between pt-2 text-[10px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
									<span>Approved value, total</span>
									<span>{timeOrdered.length} months</span>
								</div>
							</div>
						)}

						{/* By category — stacked rules */}
						{data.byCategory.length > 0 && (
							<div>
								<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3">
									<p className="kicker">By Category</p>
									<h2 className="display mt-1 text-[22px]">
										What it was spent on
									</h2>
								</div>
								<div className="mt-2">
									{data.byCategory.map((row, i) => (
										<button
											key={row.budgetCategory}
											type="button"
											onClick={() =>
												navigate({
													search: {
														...search,
														category: row.budgetCategory,
													},
												})
											}
											className="block w-full border-b border-dotted border-[var(--rule-dot)] py-3 text-left hover:bg-[var(--paper-alt)]"
										>
											<div className="flex items-baseline justify-between gap-2">
												<span className="text-[13px] font-semibold capitalize text-[var(--ink)]">
													{row.budgetCategory}
												</span>
												<span className="mono text-[11px] font-bold text-[var(--ink)]">
													{formatCurrency(row.totalAmount)}
												</span>
											</div>
											<div className="mt-1.5 h-[8px] border border-[var(--rule-soft)] bg-[var(--paper-alt)]">
												<div
													style={{
														width: `${(row.totalAmount / maxByCategory) * 100}%`,
														height: "100%",
														background:
															i === 0 ? "var(--accent)" : "var(--ink)",
													}}
												/>
											</div>
										</button>
									))}
								</div>
							</div>
						)}
					</div>

					{/* Receipts table */}
					<section className="mt-14">
						<div className="rule-double flex items-end justify-between border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
							<div>
								<p className="kicker">The Receipts</p>
								<h2 className="display mt-1 text-[26px]">
									{activeFilters.length > 0
										? "Filtered Decisions"
										: "All Fiscal Decisions"}
								</h2>
							</div>
							<span className="mono text-[11px] uppercase tracking-[0.12em] text-[var(--ink-soft)]">
								{data.decisions.length} decision
								{data.decisions.length !== 1 ? "s" : ""}
							</span>
						</div>

						{data.decisions.length === 0 ? (
							<p className="mt-6 py-6 text-center text-[14px] text-[var(--ink-soft)]">
								No decisions match the current filters.
							</p>
						) : (
							<div className="mt-4 border border-[var(--rule)] bg-[var(--paper)]">
								<div className="mono grid grid-cols-[minmax(0,1fr)_120px_120px_100px] gap-2 bg-[var(--ink)] px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--paper)]">
									<span>Line item</span>
									<span className="text-right">Amount</span>
									<span>Category</span>
									<span>Status</span>
								</div>
								{data.decisions.map((d, i) => (
									<Link
										key={`${d.title}-${d.date}-${d.bodySlug}`}
										to="/meetings/$bodySlug/$date"
										params={{ bodySlug: d.bodySlug, date: d.date }}
										className={`grid grid-cols-[minmax(0,1fr)_120px_120px_100px] items-center gap-2 px-4 py-3 no-underline hover:bg-[var(--paper-alt)] ${
											i < data.decisions.length - 1
												? "border-b border-dotted border-[var(--rule-dot)]"
												: ""
										}`}
									>
										<div>
											<p className="m-0 truncate text-[14px] font-semibold text-[var(--ink)]">
												{d.title}
											</p>
											<p className="mono mt-0.5 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-soft)]">
												{d.bodyName} · {d.date}
											</p>
										</div>
										<span className="mono text-right text-[13px] font-bold text-[var(--ink)]">
											{formatCurrencyFull(d.amount)}
										</span>
										<span className="mono text-[11px] uppercase tracking-[0.1em] text-[var(--ink-soft)]">
											{d.budgetCategory}
										</span>
										<span className={tagClass(d.status)}>{d.status}</span>
									</Link>
								))}
							</div>
						)}
					</section>
				</>
			)}
		</main>
	);
}
