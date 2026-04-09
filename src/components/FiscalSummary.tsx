import type {
	FiscalByBody,
	FiscalByCategory,
	FiscalByTimePeriod,
	NotableFiscalDecision,
} from "#/db/queries.ts";

function formatCurrency(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 0,
		maximumFractionDigits: 0,
	}).format(amount);
}

type FiscalSummaryProps = {
	byBody: FiscalByBody[];
	byCategory: FiscalByCategory[];
	byTimePeriod: FiscalByTimePeriod[];
	notableDecisions: NotableFiscalDecision[];
};

export function FiscalSummary({
	byBody,
	byCategory,
	byTimePeriod,
	notableDecisions,
}: FiscalSummaryProps) {
	const hasData =
		byBody.length > 0 ||
		byCategory.length > 0 ||
		byTimePeriod.length > 0 ||
		notableDecisions.length > 0;

	if (!hasData) {
		return (
			<section className="island-shell rounded-2xl p-6">
				<p className="island-kicker mb-2">Fiscal Overview</p>
				<p className="text-sm text-[var(--sea-ink-soft)]">
					No fiscal data available yet.
				</p>
			</section>
		);
	}

	return (
		<section className="island-shell rounded-2xl p-6">
			<p className="island-kicker mb-4">Fiscal Overview</p>

			{/* Spending by Body */}
			{byBody.length > 0 && (
				<div className="mb-6">
					<h3 className="mb-3 text-base font-semibold text-[var(--sea-ink)]">
						Spending by Body
					</h3>
					<div className="space-y-2">
						{byBody.map((row) => (
							<div
								key={row.bodySlug}
								className="flex items-center justify-between rounded-xl border border-[rgba(23,58,64,0.1)] px-4 py-3"
							>
								<span className="text-sm font-medium text-[var(--sea-ink)]">
									{row.bodyName}
								</span>
								<div className="text-right">
									<span className="text-sm font-semibold text-[var(--sea-ink)]">
										{formatCurrency(row.totalAmount)}
									</span>
									<span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
										{row.decisionCount} decision
										{row.decisionCount !== 1 ? "s" : ""}
									</span>
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Spending by Category */}
			{byCategory.length > 0 && (
				<div className="mb-6">
					<h3 className="mb-3 text-base font-semibold text-[var(--sea-ink)]">
						Spending by Category
					</h3>
					<div className="space-y-2">
						{byCategory.map((row) => (
							<div
								key={row.budgetCategory}
								className="flex items-center justify-between rounded-xl border border-[rgba(23,58,64,0.1)] px-4 py-3"
							>
								<span className="text-sm font-medium text-[var(--sea-ink)]">
									{row.budgetCategory}
								</span>
								<span className="text-sm font-semibold text-[var(--sea-ink)]">
									{formatCurrency(row.totalAmount)}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Spending by Time Period */}
			{byTimePeriod.length > 0 && (
				<div className="mb-6">
					<h3 className="mb-3 text-base font-semibold text-[var(--sea-ink)]">
						Monthly Trends
					</h3>
					<div className="space-y-2">
						{byTimePeriod.map((row) => (
							<div
								key={row.period}
								className="flex items-center justify-between rounded-xl border border-[rgba(23,58,64,0.1)] px-4 py-3"
							>
								<span className="text-sm font-medium text-[var(--sea-ink)]">
									{row.period}
								</span>
								<div className="text-right">
									<span className="text-sm font-semibold text-[var(--sea-ink)]">
										{formatCurrency(row.totalAmount)}
									</span>
									<span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
										{row.decisionCount} decision
										{row.decisionCount !== 1 ? "s" : ""}
									</span>
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Notable Decisions */}
			{notableDecisions.length > 0 && (
				<div>
					<h3 className="mb-3 text-base font-semibold text-[var(--sea-ink)]">
						Notable Recent Decisions
					</h3>
					<div className="space-y-2">
						{notableDecisions.map((d) => {
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
								<div
									key={`${d.title}-${d.date}`}
									className="flex items-center justify-between rounded-xl border border-[rgba(23,58,64,0.1)] px-4 py-3"
								>
									<div>
										<p className="text-sm font-medium text-[var(--sea-ink)]">
											{d.title}
										</p>
										<p className="text-xs text-[var(--sea-ink-soft)]">
											{d.bodyName}
										</p>
									</div>
									<div className="flex items-center gap-2">
										<span className="text-sm font-semibold text-[var(--sea-ink)]">
											{formatCurrency(d.amount)}
										</span>
										<span
											className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor}`}
										>
											{d.status}
										</span>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</section>
	);
}
