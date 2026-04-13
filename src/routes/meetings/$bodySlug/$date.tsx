import { createFileRoute } from "@tanstack/react-router";
import type { FiscalDecisionDetail } from "#/db/queries.ts";
import { getMeetingByBodyAndDate } from "#/server/meetings.ts";

/**
 * Meeting detail page — the end of the tracer bullet.
 *
 * Route: `/meetings/:bodySlug/:date` (e.g. `/meetings/ellettsville-town-council/2026-03-23`)
 *
 * The `loader` calls the server function before the component renders, so the
 * page has data available immediately (no loading spinners). TanStack Router
 * extracts `bodySlug` and `date` from the URL params automatically via
 * file-based routing (`$bodySlug/$date.tsx` → params `{ bodySlug, date }`).
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
			<p className="text-center text-lg text-[var(--sea-ink-soft)]">
				Meeting not found.
			</p>
		</main>
	),
});

/**
 * Renders the full meeting detail: header with source links, highlights,
 * prose summary, fiscal decision cards, and budget discussion items.
 *
 * Uses `Route.useLoaderData()` to access the data fetched by the loader —
 * this is type-safe, so TypeScript knows the shape of `meeting` without
 * any manual type annotations.
 */
function MeetingDetailPage() {
	const meeting = Route.useLoaderData();

	if (!meeting) {
		return (
			<main className="page-wrap px-4 pb-8 pt-14">
				<p className="text-center text-lg text-[var(--sea-ink-soft)]">
					Meeting not found.
				</p>
			</main>
		);
	}

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			{/* Header */}
			<header className="island-shell rise-in mb-6 rounded-2xl px-6 py-8">
				<p className="island-kicker mb-2">{meeting.bodyName}</p>
				<h1 className="display-title mb-3 text-3xl font-bold tracking-tight text-[var(--sea-ink)]">
					{formatDate(meeting.date)} Meeting
				</h1>
				<div className="flex flex-wrap gap-3">
					{meeting.documents.map((doc) => (
						<a
							key={doc.sourceUrl}
							href={doc.sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-4 py-1.5 text-sm font-medium text-[var(--lagoon-deep)] no-underline transition hover:bg-[rgba(79,184,178,0.24)]"
						>
							View {doc.documentType} PDF
						</a>
					))}
				</div>
			</header>

			{/* Highlights */}
			{meeting.summary && (
				<section className="island-shell rise-in mb-6 rounded-2xl p-6">
					<h2 className="mb-4 text-lg font-semibold text-[var(--sea-ink)]">
						Key Highlights
					</h2>
					<ul className="m-0 list-disc space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
						{meeting.summary.highlights.map((h) => (
							<li key={h}>{h}</li>
						))}
					</ul>
				</section>
			)}

			{/* Prose Summary */}
			{meeting.summary && (
				<section className="island-shell rise-in mb-6 rounded-2xl p-6">
					<h2 className="mb-4 text-lg font-semibold text-[var(--sea-ink)]">
						Summary
					</h2>
					<p className="text-sm leading-relaxed text-[var(--sea-ink-soft)]">
						{meeting.summary.prose}
					</p>
				</section>
			)}

			{/* Fiscal Decisions */}
			{meeting.fiscalDecisions.length > 0 && (
				<section className="island-shell rise-in mb-6 rounded-2xl p-6">
					<h2 className="mb-4 text-lg font-semibold text-[var(--sea-ink)]">
						Fiscal Decisions
					</h2>
					<div className="space-y-4">
						{meeting.fiscalDecisions.map((fd) => (
							<FiscalCard key={fd.title} decision={fd} />
						))}
					</div>
				</section>
			)}

			{/* Budget Discussions */}
			{meeting.budgetDiscussions.length > 0 && (
				<section className="island-shell rise-in rounded-2xl p-6">
					<h2 className="mb-4 text-lg font-semibold text-[var(--sea-ink)]">
						Budget Discussions (No Vote Taken)
					</h2>
					<div className="space-y-3">
						{meeting.budgetDiscussions.map((bd) => (
							<div
								key={bd.topic}
								className="rounded-xl border border-[rgba(23,58,64,0.1)] p-4"
							>
								<p className="mb-1 text-sm font-medium text-[var(--sea-ink)]">
									{bd.topic}
								</p>
								{bd.estimatedAmount != null && (
									<p className="text-sm text-[var(--sea-ink-soft)]">
										Estimated: {formatCurrency(bd.estimatedAmount)}
									</p>
								)}
								{bd.notes && (
									<p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
										{bd.notes}
									</p>
								)}
							</div>
						))}
					</div>
				</section>
			)}
		</main>
	);
}

/**
 * Card component for a single fiscal decision.
 * Color-codes the status badge: green (approved), red (denied), amber (tabled).
 * Displays the dollar amount prominently, with metadata (vote record, category,
 * vendor, funding source, ordinance number) in a compact flex row beneath.
 */
function FiscalCard({ decision }: { decision: FiscalDecisionDetail }) {
	let statusColor: string;
	switch (decision.status) {
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
			const _exhaustive: never = decision.status;
			return _exhaustive;
		}
	}

	return (
		<div className="rounded-xl border border-[rgba(23,58,64,0.1)] p-4">
			<div className="mb-2 flex items-center justify-between gap-3">
				<h3 className="text-sm font-semibold text-[var(--sea-ink)]">
					{decision.title}
				</h3>
				<span
					className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColor}`}
				>
					{decision.status}
				</span>
			</div>
			<p className="mb-2 text-2xl font-bold text-[var(--sea-ink)]">
				{formatCurrency(decision.amount)}
			</p>
			<p className="mb-2 text-sm text-[var(--sea-ink-soft)]">
				{decision.description}
			</p>
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--sea-ink-soft)]">
				{decision.voteRecord && (
					<span>
						Vote: {decision.voteRecord.yea}-{decision.voteRecord.nay}
						{decision.voteRecord.abstain > 0 &&
							`-${decision.voteRecord.abstain}`}
					</span>
				)}
				{decision.budgetCategory && (
					<span>Category: {decision.budgetCategory}</span>
				)}
				{decision.vendor && <span>Vendor: {decision.vendor}</span>}
				{decision.fundingSource && (
					<span>Source: {decision.fundingSource}</span>
				)}
				{decision.ordinanceNumber && (
					<span>Ord. #{decision.ordinanceNumber}</span>
				)}
			</div>
		</div>
	);
}

/** Converts an ISO date string (YYYY-MM-DD) to a human-readable format (e.g. "March 23, 2026"). */
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
