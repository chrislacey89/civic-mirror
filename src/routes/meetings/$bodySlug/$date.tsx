import { createFileRoute } from "@tanstack/react-router";
import type { FiscalDecisionDetail, MeetingDetail } from "#/db/queries.ts";
import { getMeetingByBodyAndDate } from "#/server/meetings.ts";

/**
 * Meeting detail page — the end of the tracer bullet.
 *
 * Route: `/meetings/:bodySlug/:date` (e.g. `/meetings/ellettsville-town-council/2026-03-23`)
 *
 * Three render branches keyed on `meeting.extractionMethod`:
 *   - `text-layer`: full Ledger layout (highlights, summary, receipts table)
 *   - `ocr`:        full layout plus OCR trust-disclosure banner and per-figure `?` badge
 *   - `unreadable`: status card + source PDF links only (no generated content)
 */
export const Route = createFileRoute("/meetings/$bodySlug/$date")({
	loader: ({ params }) =>
		getMeetingByBodyAndDate({
			data: { bodySlug: params.bodySlug, date: params.date },
		}),
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData
					? `${loaderData.bodyName} — ${loaderData.date} | Civic Mirror`
					: "Meeting Not Found | Civic Mirror",
			},
		],
	}),
	component: MeetingDetailPage,
	notFoundComponent: () => (
		<main className="page-wrap px-4 pb-8 pt-14">
			<p className="text-center text-lg text-[var(--ink-soft)]">
				Meeting not found.
			</p>
		</main>
	),
});

function MeetingDetailPage() {
	const meeting = Route.useLoaderData();

	if (!meeting) {
		return (
			<main className="page-wrap px-4 pb-8 pt-14">
				<p className="text-center text-lg text-[var(--ink-soft)]">
					Meeting not found.
				</p>
			</main>
		);
	}

	return <MeetingDetailView meeting={meeting} />;
}

/**
 * Pure render component, exported for testing. Branches on
 * `meeting.extractionMethod` to surface honest signals about content provenance.
 */
export function MeetingDetailView({ meeting }: { meeting: MeetingDetail }) {
	const isOcr = meeting.extractionMethod === "ocr";
	const isUnreadable = meeting.extractionMethod === "unreadable";

	return (
		<main className="page-wrap px-4 pb-8 pt-6">
			<Dateline meeting={meeting} />
			<MeetingHero meeting={meeting} />

			{isUnreadable ? (
				<UnreadableStatusCard bodyName={meeting.bodyName} date={meeting.date} />
			) : (
				<>
					{isOcr && <OcrBanner />}
					{meeting.summary && (
						<>
							<section className="mt-10">
								<SectionHead kicker="Highlights" title="Key Highlights" />
								<ol className="m-0 list-none p-0">
									{meeting.summary.highlights.map((h, i) => (
										<li
											key={h}
											className={`grid grid-cols-[36px_1fr] items-baseline gap-2 py-3 ${
												i === 0
													? "border-t border-[var(--rule)]"
													: "border-t border-dotted border-[var(--rule-dot)]"
											}`}
										>
											<span className="mono text-[13px] font-bold text-[var(--accent)]">
												{String(i + 1).padStart(2, "0")}
											</span>
											<span className="text-[17px] leading-[1.55] text-[var(--ink)]">
												{h}
											</span>
										</li>
									))}
								</ol>
							</section>

							<section className="mt-10">
								<SectionHead kicker="Written for residents" title="Summary" />
								<div className="drop-cap columns-1 gap-8 text-[16px] leading-[1.62] text-[var(--ink)] md:columns-2 md:[column-rule:1px_dotted_var(--rule-dot)]">
									<p className="m-0">{meeting.summary.prose}</p>
								</div>
							</section>
						</>
					)}

					{meeting.fiscalDecisions.length > 0 && (
						<section className="mt-10">
							<SectionHead kicker="The Receipts" title="Fiscal Decisions" />
							<FiscalReceiptsTable
								decisions={meeting.fiscalDecisions}
								ocrFlagged={isOcr}
							/>
						</section>
					)}

					{meeting.budgetDiscussions.length > 0 && (
						<section className="mt-10">
							<SectionHead
								kicker="Also discussed"
								title="Budget Discussions (No Vote Taken)"
							/>
							<div>
								{meeting.budgetDiscussions.map((bd, i) => (
									<div
										key={bd.topic}
										className={`py-4 ${
											i === 0
												? "border-t border-[var(--rule)]"
												: "border-t border-dotted border-[var(--rule-dot)]"
										}`}
									>
										<p className="display m-0 text-[18px]">{bd.topic}</p>
										{bd.estimatedAmount != null && (
											<p className="mono mt-1 text-[12px] uppercase tracking-[0.08em] text-[var(--ink-soft)]">
												Estimated:{" "}
												<FiscalFigure
													amount={bd.estimatedAmount}
													ocrFlagged={isOcr}
												/>
											</p>
										)}
										{bd.notes && (
											<p className="mt-2 text-[14px] leading-[1.55] text-[var(--ink-mid)]">
												{bd.notes}
											</p>
										)}
									</div>
								))}
							</div>
						</section>
					)}
				</>
			)}
		</main>
	);
}

function Dateline({ meeting }: { meeting: MeetingDetail }) {
	return (
		<div className="mono flex flex-wrap justify-between gap-2 border-y border-[var(--rule)] bg-[var(--paper-alt)] px-2 py-2 text-[11px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
			<span>
				<span className="font-bold text-[var(--accent)]">
					ELLETTSVILLE, IND.
				</span>{" "}
				— {formatDate(meeting.date).toUpperCase()}
			</span>
			<span className="hidden sm:inline">
				{meeting.bodyName} · {meeting.meetingType} session
			</span>
			<span className="hidden md:inline">Filed by AI · Verified</span>
		</div>
	);
}

function MeetingHero({ meeting }: { meeting: MeetingDetail }) {
	const totalSpending = meeting.fiscalDecisions.reduce(
		(sum, f) => sum + f.amount,
		0,
	);
	const firstHighlight = meeting.summary?.highlights[0];

	return (
		<section className="rise-in pt-10">
			<p className="kicker text-[var(--accent)]">
				Meeting Report · {meeting.bodyName}
			</p>
			<h1 className="display mt-3 text-[40px] leading-[1.02] tracking-[-0.025em] sm:text-[54px]">
				{firstHighlight ?? `${meeting.bodyName} — ${formatDate(meeting.date)}`}
			</h1>

			{meeting.summary?.prose && (
				<p className="lede mt-5 text-[18px] leading-[1.5]">
					{firstSentence(meeting.summary.prose)}
				</p>
			)}

			<div className="rule-double mt-8 grid grid-cols-2 border-b-[3px] border-double border-[var(--rule)] sm:grid-cols-4">
				{[
					{ n: formatCurrency(totalSpending), l: "Approved this meeting" },
					{ n: meeting.fiscalDecisions.length, l: "Fiscal decisions" },
					{ n: meeting.budgetDiscussions.length, l: "Discussed, no vote" },
					{ n: meeting.documents.length, l: "Source documents" },
				].map((s, i, arr) => (
					<div
						key={s.l}
						className={`py-4 pr-4 ${i > 0 ? "pl-4" : ""} ${
							i < arr.length - 1
								? "sm:border-r sm:border-[var(--rule-soft)]"
								: ""
						}`}
					>
						<div className="display text-[26px] leading-none sm:text-[32px]">
							{s.n}
						</div>
						<div className="kicker mt-2">{s.l}</div>
					</div>
				))}
			</div>

			{/* Primary sources */}
			{meeting.documents.length > 0 && (
				<div className="mt-6 border border-[var(--rule)] bg-[var(--paper)]">
					<div className="mono border-b border-[var(--rule)] bg-[var(--paper-alt)] px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ink)]">
						Primary sources
					</div>
					{meeting.documents.map((doc, i) => (
						<a
							key={doc.sourceUrl}
							href={doc.sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							className={`grid grid-cols-[52px_1fr_auto] items-center gap-3 px-4 py-3 no-underline hover:bg-[var(--paper-alt)] ${
								i < meeting.documents.length - 1
									? "border-b border-dotted border-[var(--rule-dot)]"
									: ""
							}`}
						>
							<span className="mono bg-[var(--ink)] px-1.5 py-1 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--paper)]">
								PDF
							</span>
							<span className="text-[14px] font-semibold text-[var(--ink)]">
								View {doc.documentType} PDF
							</span>
							<span className="mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-soft)]">
								{doc.extractionMethod}
							</span>
						</a>
					))}
				</div>
			)}
		</section>
	);
}

function SectionHead({ kicker, title }: { kicker: string; title: string }) {
	return (
		<div className="rule-double border-t-[3px] border-double border-[var(--rule)] pt-4">
			<p className="kicker">{kicker}</p>
			<h2 className="display mt-1 text-[26px] leading-tight tracking-[-0.01em]">
				{title}
			</h2>
		</div>
	);
}

function FiscalReceiptsTable({
	decisions,
	ocrFlagged,
}: {
	decisions: FiscalDecisionDetail[];
	ocrFlagged: boolean;
}) {
	const total = decisions
		.filter((d) => d.status === "approved")
		.reduce((sum, d) => sum + d.amount, 0);

	return (
		<div className="mt-4 border border-[var(--rule)] bg-[var(--paper)]">
			<div className="mono grid grid-cols-[minmax(0,1fr)_120px_90px_110px] gap-2 bg-[var(--ink)] px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--paper)]">
				<span>Line item</span>
				<span className="text-right">Amount</span>
				<span>Vote</span>
				<span>Status</span>
			</div>
			{decisions.map((d, i) => (
				<FiscalRow
					key={`${d.title}-${d.amount}-${d.status}`}
					decision={d}
					ocrFlagged={ocrFlagged}
					last={i === decisions.length - 1}
				/>
			))}
			<div className="rule-double mono grid grid-cols-[minmax(0,1fr)_120px_90px_110px] gap-2 border-t-[3px] border-double border-[var(--rule)] bg-[var(--paper-alt)] px-4 py-3 text-[12px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]">
				<span>Total approved, this meeting</span>
				<span className="text-right text-[14px]">{formatCurrency(total)}</span>
				<span />
				<span />
			</div>
		</div>
	);
}

function FiscalRow({
	decision,
	ocrFlagged,
	last,
}: {
	decision: FiscalDecisionDetail;
	ocrFlagged: boolean;
	last: boolean;
}) {
	const voteText = decision.voteRecord
		? `${decision.voteRecord.yea}–${decision.voteRecord.nay}${
				decision.voteRecord.abstain > 0 ? `–${decision.voteRecord.abstain}` : ""
			}`
		: "—";

	return (
		<div
			className={`grid grid-cols-[minmax(0,1fr)_120px_90px_110px] items-center gap-2 px-4 py-3 ${
				last ? "" : "border-b border-dotted border-[var(--rule-dot)]"
			}`}
		>
			<div>
				<p className="m-0 text-[15px] font-semibold text-[var(--ink)]">
					{decision.title}
				</p>
				{decision.description && (
					<p className="mt-0.5 text-[13px] leading-[1.45] text-[var(--ink-mid)]">
						{decision.description}
					</p>
				)}
				<div className="mono mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] uppercase tracking-[0.08em] text-[var(--ink-soft)]">
					{decision.budgetCategory && <span>{decision.budgetCategory}</span>}
					{decision.vendor && <span>Vendor: {decision.vendor}</span>}
					{decision.fundingSource && <span>{decision.fundingSource}</span>}
					{decision.ordinanceNumber && (
						<span>Ord. #{decision.ordinanceNumber}</span>
					)}
				</div>
			</div>
			<span className="mono text-right text-[14px] font-bold text-[var(--ink)]">
				<FiscalFigure amount={decision.amount} ocrFlagged={ocrFlagged} />
			</span>
			<span className="mono text-[13px] font-semibold text-[var(--ink)]">
				{voteText}
			</span>
			<StatusTag status={decision.status} />
		</div>
	);
}

function StatusTag({ status }: { status: FiscalDecisionDetail["status"] }) {
	switch (status) {
		case "approved":
			return <span className="tag tag--approved">{status}</span>;
		case "denied":
			return <span className="tag tag--denied">{status}</span>;
		case "tabled":
			return <span className="tag tag--tabled">{status}</span>;
	}
}

function OcrBanner() {
	// <output> has implicit role="status" — announces politely without interrupting
	return (
		<output className="rise-in ocr-stripes mt-6 block">
			<div className="mono flex items-center gap-3 bg-[var(--paper)] px-4 py-3 text-[12px] text-[var(--ink-mid)]">
				<span className="mono bg-[var(--ink)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--highlight)]">
					OCR'd
				</span>
				<span>
					Extracted via OCR from a scanned PDF. Verify figures against the
					original document.
				</span>
			</div>
		</output>
	);
}

function UnreadableStatusCard({
	bodyName,
	date,
}: {
	bodyName: string;
	date: string;
}) {
	return (
		<output className="rise-in mt-6 block border border-[var(--rule)] bg-[var(--paper-alt)] px-6 py-5 text-[14px] text-[var(--ink-mid)]">
			We couldn't extract readable text from this {formatDate(date)} {bodyName}{" "}
			meeting. The original document is available below.
		</output>
	);
}

/**
 * Wraps a formatted dollar amount. On OCR-sourced meetings, appends a `?`
 * superscript with an aria-label so the figure is flagged as provenance-uncertain.
 */
function FiscalFigure({
	amount,
	ocrFlagged,
}: {
	amount: number;
	ocrFlagged: boolean;
}) {
	return (
		<span>
			{formatCurrency(amount)}
			{ocrFlagged && (
				<sup className="ml-0.5 text-[10px] text-[var(--accent)]">
					<span
						role="img"
						aria-label="OCR-extracted figure, verify against source"
					>
						?
					</span>
				</sup>
			)}
		</span>
	);
}

function firstSentence(prose: string): string {
	const match = prose.split(/(?<=[.!?])\s/)[0];
	return match ?? prose;
}

/** Converts an ISO date string (YYYY-MM-DD) to a human-readable format. */
function formatDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	const date = new Date(Number(year), Number(month) - 1, Number(day));
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

/** Formats a number as USD with no decimal places (e.g. 50000 → "$50,000"). */
function formatCurrency(amount: number): string {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 0,
		maximumFractionDigits: 0,
	}).format(amount);
}
