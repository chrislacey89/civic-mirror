import type {
	FiscalByBody,
	FiscalByCategory,
	FiscalByTimePeriod,
	FiscalStatus,
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
			<section className="paper-card p-6">
				<p className="kicker mb-2">Fiscal Overview</p>
				<p className="text-[14px] text-[var(--ink-soft)]">
					No fiscal data available yet.
				</p>
			</section>
		);
	}

	const maxByBody = Math.max(...byBody.map((b) => b.totalAmount), 1);
	const maxByCategory = Math.max(...byCategory.map((b) => b.totalAmount), 1);

	return (
		<section>
			<div className="rule-double mb-4 pt-4">
				<p className="kicker">Fiscal Overview</p>
				<h2 className="display mt-1 text-[26px] leading-tight tracking-[-0.01em]">
					Where the money went
				</h2>
			</div>

			<div className="grid gap-10 lg:grid-cols-2">
				{byBody.length > 0 && (
					<div>
						<p className="kicker mb-2">Spending by Body</p>
						<div className="rule-hair border-b border-[var(--rule)]">
							{byBody.map((row, i) => (
								<div
									key={row.bodySlug}
									className="grid grid-cols-[minmax(0,1fr)_120px_110px] items-center gap-4 border-t border-dotted border-[var(--rule-dot)] py-3"
								>
									<div>
										<p className="m-0 text-[14px] font-semibold text-[var(--ink)]">
											{row.bodyName}
										</p>
										<p className="mono mt-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--ink-soft)]">
											{row.decisionCount} decision
											{row.decisionCount !== 1 ? "s" : ""}
										</p>
									</div>
									<div className="h-[10px] border border-[var(--rule-soft)] bg-[var(--paper-alt)]">
										<div
											style={{
												width: `${(row.totalAmount / maxByBody) * 100}%`,
												height: "100%",
												background: i === 0 ? "var(--accent)" : "var(--ink)",
											}}
										/>
									</div>
									<span className="mono text-right text-[12px] font-bold text-[var(--ink)]">
										{formatCurrency(row.totalAmount)}
									</span>
								</div>
							))}
						</div>
					</div>
				)}

				{byCategory.length > 0 && (
					<div>
						<p className="kicker mb-2">Spending by Category</p>
						<div className="rule-hair border-b border-[var(--rule)]">
							{byCategory.map((row, i) => (
								<div
									key={row.budgetCategory}
									className="grid grid-cols-[minmax(0,1fr)_120px_110px] items-center gap-4 border-t border-dotted border-[var(--rule-dot)] py-3"
								>
									<span className="text-[14px] font-semibold text-[var(--ink)]">
										{row.budgetCategory}
									</span>
									<div className="h-[10px] border border-[var(--rule-soft)] bg-[var(--paper-alt)]">
										<div
											style={{
												width: `${(row.totalAmount / maxByCategory) * 100}%`,
												height: "100%",
												background: i === 0 ? "var(--accent)" : "var(--ink)",
											}}
										/>
									</div>
									<span className="mono text-right text-[12px] font-bold text-[var(--ink)]">
										{formatCurrency(row.totalAmount)}
									</span>
								</div>
							))}
						</div>
					</div>
				)}
			</div>

			{byTimePeriod.length > 0 && (
				<div className="mt-10">
					<p className="kicker mb-2">Monthly pace</p>
					<div className="rule-hair border-b border-[var(--rule)]">
						{byTimePeriod.map((row) => (
							<div
								key={row.period}
								className="flex items-center justify-between border-t border-dotted border-[var(--rule-dot)] py-3"
							>
								<span className="mono text-[13px] uppercase tracking-[0.08em] text-[var(--ink)]">
									{row.period}
								</span>
								<div className="flex items-baseline gap-3">
									<span className="mono text-[12px] text-[var(--ink-soft)]">
										{row.decisionCount} decision
										{row.decisionCount !== 1 ? "s" : ""}
									</span>
									<span className="mono text-[13px] font-bold text-[var(--ink)]">
										{formatCurrency(row.totalAmount)}
									</span>
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{notableDecisions.length > 0 && (
				<div className="mt-10">
					<p className="kicker mb-2">Notable Recent Decisions</p>
					<div className="paper-card">
						<div className="grid grid-cols-[minmax(0,1fr)_110px_110px] items-center gap-4 bg-[var(--ink)] px-4 py-2.5 text-[var(--paper)]">
							<span className="mono text-[10px] font-bold uppercase tracking-[0.18em]">
								Line item
							</span>
							<span className="mono text-right text-[10px] font-bold uppercase tracking-[0.18em]">
								Amount
							</span>
							<span className="mono text-[10px] font-bold uppercase tracking-[0.18em]">
								Status
							</span>
						</div>
						{notableDecisions.map((d, i) => (
							<div
								key={`${d.title}-${d.date}`}
								className={`grid grid-cols-[minmax(0,1fr)_110px_110px] items-center gap-4 px-4 py-3 ${
									i < notableDecisions.length - 1
										? "border-b border-dotted border-[var(--rule-dot)]"
										: ""
								}`}
							>
								<div>
									<p className="m-0 text-[14px] font-semibold text-[var(--ink)]">
										{d.title}
									</p>
									<p className="mono mt-0.5 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-soft)]">
										{d.bodyName} · {d.date}
									</p>
								</div>
								<span className="mono text-right text-[13px] font-bold text-[var(--ink)]">
									{formatCurrency(d.amount)}
								</span>
								<span className={tagClass(d.status)}>{d.status}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</section>
	);
}
