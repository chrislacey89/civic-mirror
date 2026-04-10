import { createFileRoute, Link } from "@tanstack/react-router";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	XAxis,
	YAxis,
} from "recharts";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "#/components/ui/chart.tsx";
import type {
	FiscalByBody,
	FiscalByCategory,
	FiscalByTimePeriod,
	FiscalDecisionRow,
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

const bodyChartConfig = {
	totalAmount: {
		label: "Total Spending",
		color: "var(--chart-1)",
	},
} satisfies ChartConfig;

const categoryChartConfig = {
	totalAmount: {
		label: "Total Spending",
		color: "var(--chart-2)",
	},
} satisfies ChartConfig;

const trendChartConfig = {
	totalAmount: {
		label: "Monthly Spending",
		color: "var(--chart-3)",
	},
} satisfies ChartConfig;

function SpendingRoute() {
	const data = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();

	const hasData =
		data.byBody.length > 0 ||
		data.byCategory.length > 0 ||
		data.byTimePeriod.length > 0;

	const activeFilters = [
		search.body && `Body: ${search.body}`,
		search.category && `Category: ${search.category}`,
		search.period && `Period: ${search.period}`,
	].filter(Boolean);

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
				<p className="island-kicker mb-3">Fiscal Transparency</p>
				<h1 className="display-title mb-3 text-3xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
					Spending Dashboard
				</h1>
				<p className="max-w-2xl text-base text-[var(--sea-ink-soft)]">
					Interactive charts showing fiscal decisions by governing body, budget
					category, and time period. Click any data point to explore the
					underlying decisions.
				</p>
			</section>

			{/* Active Filters */}
			{activeFilters.length > 0 && (
				<div className="mt-6 flex flex-wrap items-center gap-2">
					<span className="text-sm text-[var(--sea-ink-soft)]">
						Filtered by:
					</span>
					{activeFilters.map((filter) => (
						<span
							key={filter}
							className="rounded-full border border-[var(--line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-medium text-[var(--sea-ink)]"
						>
							{filter}
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
						className="rounded-full px-3 py-1 text-xs font-medium text-[var(--lagoon-deep)] transition hover:bg-[var(--link-bg-hover)]"
					>
						Clear all
					</button>
				</div>
			)}

			{!hasData ? (
				<section className="island-shell rise-in mt-8 rounded-2xl p-10 text-center">
					<p className="text-lg font-semibold text-[var(--sea-ink)]">
						No fiscal data available yet
					</p>
					<p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
						Spending data will appear here once the pipeline processes meeting
						minutes with fiscal decisions.
					</p>
				</section>
			) : (
				<>
					{/* Charts Grid */}
					<div className="mt-8 grid gap-6 lg:grid-cols-2">
						{/* Spending by Body */}
						{data.byBody.length > 0 && (
							<div className="island-shell rise-in rounded-2xl p-6">
								<h2 className="mb-1 text-base font-semibold text-[var(--sea-ink)]">
									Spending by Body
								</h2>
								<p className="mb-4 text-xs text-[var(--sea-ink-soft)]">
									Total fiscal decisions by governing body
								</p>
								<ChartContainer
									config={bodyChartConfig}
									className="min-h-[250px] w-full"
								>
									<BarChart
										accessibilityLayer
										data={data.byBody}
										layout="vertical"
										margin={{ left: 0, right: 16 }}
									>
										<CartesianGrid horizontal={false} />
										<YAxis
											dataKey="bodyName"
											type="category"
											tickLine={false}
											axisLine={false}
											width={140}
											tick={{ fontSize: 11 }}
										/>
										<XAxis
											type="number"
											tickFormatter={(v) => formatCurrency(v)}
											tickLine={false}
											axisLine={false}
										/>
										<ChartTooltip
											content={
												<ChartTooltipContent
													formatter={(value) => formatCurrency(value as number)}
												/>
											}
										/>
										<Bar
											dataKey="totalAmount"
											fill="var(--color-totalAmount)"
											radius={[0, 4, 4, 0]}
											className="cursor-pointer"
											onClick={(_data, _index, e) => {
												const payload = (
													e as unknown as {
														payload?: FiscalByBody;
													}
												).payload;
												if (payload?.bodySlug) {
													navigate({
														search: {
															...search,
															body: payload.bodySlug,
														},
													});
												}
											}}
										/>
									</BarChart>
								</ChartContainer>
							</div>
						)}

						{/* Spending by Category */}
						{data.byCategory.length > 0 && (
							<div className="island-shell rise-in rounded-2xl p-6">
								<h2 className="mb-1 text-base font-semibold text-[var(--sea-ink)]">
									Spending by Category
								</h2>
								<p className="mb-4 text-xs text-[var(--sea-ink-soft)]">
									Total fiscal decisions by budget category
								</p>
								<ChartContainer
									config={categoryChartConfig}
									className="min-h-[250px] w-full"
								>
									<BarChart
										accessibilityLayer
										data={data.byCategory}
										layout="vertical"
										margin={{ left: 0, right: 16 }}
									>
										<CartesianGrid horizontal={false} />
										<YAxis
											dataKey="budgetCategory"
											type="category"
											tickLine={false}
											axisLine={false}
											width={120}
											tick={{ fontSize: 11 }}
										/>
										<XAxis
											type="number"
											tickFormatter={(v) => formatCurrency(v)}
											tickLine={false}
											axisLine={false}
										/>
										<ChartTooltip
											content={
												<ChartTooltipContent
													formatter={(value) => formatCurrency(value as number)}
												/>
											}
										/>
										<Bar
											dataKey="totalAmount"
											fill="var(--color-totalAmount)"
											radius={[0, 4, 4, 0]}
											className="cursor-pointer"
											onClick={(_data, _index, e) => {
												const payload = (
													e as unknown as {
														payload?: FiscalByCategory;
													}
												).payload;
												if (payload?.budgetCategory) {
													navigate({
														search: {
															...search,
															category: payload.budgetCategory,
														},
													});
												}
											}}
										/>
									</BarChart>
								</ChartContainer>
							</div>
						)}
					</div>

					{/* Spending Over Time - Full Width */}
					{data.byTimePeriod.length > 0 && (
						<div className="island-shell rise-in mt-6 rounded-2xl p-6">
							<h2 className="mb-1 text-base font-semibold text-[var(--sea-ink)]">
								Spending Over Time
							</h2>
							<p className="mb-4 text-xs text-[var(--sea-ink-soft)]">
								Monthly spending trends across all governing bodies
							</p>
							<ChartContainer
								config={trendChartConfig}
								className="min-h-[250px] w-full"
							>
								<AreaChart
									accessibilityLayer
									data={[...data.byTimePeriod].reverse()}
									margin={{ left: 0, right: 16 }}
								>
									<CartesianGrid vertical={false} />
									<XAxis
										dataKey="period"
										tickFormatter={formatMonth}
										tickLine={false}
										axisLine={false}
										tick={{ fontSize: 11 }}
									/>
									<YAxis
										tickFormatter={(v) => formatCurrency(v)}
										tickLine={false}
										axisLine={false}
									/>
									<ChartTooltip
										content={
											<ChartTooltipContent
												labelFormatter={(label) => formatMonth(label as string)}
												formatter={(value) => formatCurrency(value as number)}
											/>
										}
									/>
									<defs>
										<linearGradient id="fillTrend" x1="0" y1="0" x2="0" y2="1">
											<stop
												offset="5%"
												stopColor="var(--color-totalAmount)"
												stopOpacity={0.8}
											/>
											<stop
												offset="95%"
												stopColor="var(--color-totalAmount)"
												stopOpacity={0.1}
											/>
										</linearGradient>
									</defs>
									<Area
										dataKey="totalAmount"
										type="monotone"
										fill="url(#fillTrend)"
										stroke="var(--color-totalAmount)"
										strokeWidth={2}
										className="cursor-pointer"
										activeDot={{
											r: 6,
											className: "cursor-pointer",
											onClick: (_e: unknown, payload: unknown) => {
												const p = payload as { payload?: { period?: string } };
												if (p.payload?.period) {
													navigate({
														search: { ...search, period: p.payload.period },
													});
												}
											},
										}}
									/>
								</AreaChart>
							</ChartContainer>
						</div>
					)}

					{/* Decisions Table */}
					<section className="island-shell rise-in mt-6 rounded-2xl p-6">
						<h2 className="mb-1 text-base font-semibold text-[var(--sea-ink)]">
							{activeFilters.length > 0
								? "Filtered Decisions"
								: "All Fiscal Decisions"}
						</h2>
						<p className="mb-4 text-xs text-[var(--sea-ink-soft)]">
							{data.decisions.length} decision
							{data.decisions.length !== 1 ? "s" : ""} found
							{activeFilters.length > 0 ? " matching current filters" : ""}
						</p>

						{data.decisions.length === 0 ? (
							<p className="py-6 text-center text-sm text-[var(--sea-ink-soft)]">
								No decisions match the current filters.
							</p>
						) : (
							<div className="space-y-2">
								{data.decisions.map((d) => {
									let statusColor: string;
									switch (d.status) {
										case "approved":
											statusColor = "text-emerald-700 bg-emerald-50";
											break;
										case "denied":
											statusColor = "text-red-700 bg-red-50";
											break;
										case "tabled":
											statusColor = "text-amber-700 bg-amber-50";
											break;
										default: {
											const _exhaustive: never = d.status;
											return _exhaustive;
										}
									}
									return (
										<Link
											key={`${d.title}-${d.date}-${d.bodySlug}`}
											to="/meetings/$bodySlug/$date"
											params={{ bodySlug: d.bodySlug, date: d.date }}
											className="flex items-center justify-between rounded-xl border border-[rgba(23,58,64,0.1)] px-4 py-3 no-underline transition hover:border-[color-mix(in_oklab,var(--lagoon-deep)_35%,var(--line))] hover:bg-[var(--surface)]"
										>
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium text-[var(--sea-ink)]">
													{d.title}
												</p>
												<p className="text-xs text-[var(--sea-ink-soft)]">
													{d.bodyName} &middot; {d.date} &middot;{" "}
													{d.budgetCategory}
												</p>
											</div>
											<div className="ml-4 flex shrink-0 items-center gap-2">
												<span className="text-sm font-semibold text-[var(--sea-ink)]">
													{formatCurrency(d.amount)}
												</span>
												<span
													className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor}`}
												>
													{d.status}
												</span>
											</div>
										</Link>
									);
								})}
							</div>
						)}
					</section>
				</>
			)}
		</main>
	);
}
