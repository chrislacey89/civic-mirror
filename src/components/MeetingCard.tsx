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

	return (
		<article className="island-shell feature-card rounded-2xl p-5">
			<a
				href={`/meetings/${meeting.bodySlug}/${meeting.date}`}
				className="block no-underline"
			>
				<p className="island-kicker mb-1">{meeting.bodyName}</p>
				<h3 className="mb-2 text-lg font-semibold text-[var(--sea-ink)]">
					{formatDate(meeting.date)}
				</h3>
				{isUnreadable ? (
					<p className="text-sm italic text-[var(--sea-ink-soft)]">
						Source document couldn't be extracted — open to view the original
						PDF.
					</p>
				) : (
					<>
						<ul className="m-0 mb-3 list-disc space-y-1 pl-5 text-sm text-[var(--sea-ink-soft)]">
							{meeting.highlights.slice(0, 3).map((h) => (
								<li key={h}>{h}</li>
							))}
						</ul>
						{meeting.fiscalDecisionCount > 0 && (
							<div className="flex items-center gap-3 text-sm text-[var(--sea-ink-soft)]">
								<span className="font-semibold text-[var(--sea-ink)]">
									{formatCurrency(meeting.totalSpending)}
								</span>
								<span>
									{meeting.fiscalDecisionCount} decision
									{meeting.fiscalDecisionCount !== 1 ? "s" : ""}
								</span>
							</div>
						)}
					</>
				)}
			</a>
		</article>
	);
}
