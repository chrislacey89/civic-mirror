import type { MeetingCardData } from "#/db/queries.ts";

function formatDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	const date = new Date(Number(year), Number(month) - 1, Number(day));
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

function formatCurrency(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 0,
		maximumFractionDigits: 0,
	}).format(amount);
}

export function MeetingCard({ meeting }: { meeting: MeetingCardData }) {
	const isUnreadable = meeting.extractionMethod === "unreadable";
	const isOcr = meeting.extractionMethod === "ocr";

	return (
		<article className="paper-card flex h-full flex-col p-5">
			<a
				href={`/meetings/${meeting.bodySlug}/${meeting.date}`}
				className="flex h-full flex-col no-underline"
			>
				<div className="mono mb-3 flex flex-wrap justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
					<span>{meeting.bodyName}</span>
					<span>{formatDate(meeting.date)}</span>
				</div>

				{isUnreadable ? (
					<p className="text-[14px] italic leading-[1.55] text-[var(--ink-soft)]">
						Source document couldn't be extracted — open to view the original
						PDF.
					</p>
				) : (
					<>
						<ul className="m-0 mb-4 list-none space-y-2 p-0">
							{meeting.highlights.slice(0, 3).map((h, i) => (
								<li
									key={h}
									className="mono grid grid-cols-[22px_1fr] gap-2 text-[14px] leading-[1.5] text-[var(--ink-mid)]"
								>
									<span className="font-bold text-[var(--accent)]">
										{String(i + 1).padStart(2, "0")}
									</span>
									<span className="font-serif text-[15px] text-[var(--ink)]">
										{h}
									</span>
								</li>
							))}
						</ul>
						{meeting.fiscalDecisionCount > 0 && (
							<div className="mono mt-auto flex flex-wrap items-center gap-2 text-[11px] text-[var(--ink-soft)]">
								{meeting.totalSpending > 0 && (
									<span className="money-pill">
										{formatCurrency(meeting.totalSpending)}
									</span>
								)}
								<span>
									{meeting.fiscalDecisionCount} decision
									{meeting.fiscalDecisionCount !== 1 ? "s" : ""}
								</span>
								{isOcr && (
									<span className="text-[var(--accent)]">
										OCR<sup>?</sup>
									</span>
								)}
							</div>
						)}
					</>
				)}
			</a>
		</article>
	);
}
