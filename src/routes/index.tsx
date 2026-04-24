import { createFileRoute } from "@tanstack/react-router";
import { FiscalSummary } from "#/components/FiscalSummary.tsx";
import { MeetingCard } from "#/components/MeetingCard.tsx";
import type {
	FiscalByBody,
	FiscalByCategory,
	FiscalByTimePeriod,
	GoverningBodySummary,
	MeetingCardData,
	NotableFiscalDecision,
} from "#/db/queries.ts";
import {
	aggregateFiscalByBody,
	aggregateFiscalByCategory,
	aggregateFiscalByTimePeriod,
	listGoverningBodies,
	listNotableFiscalDecisions,
	listRecentMeetings,
} from "#/server/meetings.ts";

type LandingData = {
	meetings: MeetingCardData[];
	bodies: GoverningBodySummary[];
	fiscalByBody: FiscalByBody[];
	fiscalByCategory: FiscalByCategory[];
	fiscalByTimePeriod: FiscalByTimePeriod[];
	notableDecisions: NotableFiscalDecision[];
};

export const Route = createFileRoute("/")({
	validateSearch: (search: Record<string, unknown>) => ({
		body:
			typeof search.body === "string" ? search.body || undefined : undefined,
	}),
	loaderDeps: ({ search }) => ({ body: search.body }),
	loader: async ({ deps }): Promise<LandingData> => {
		const [
			meetings,
			bodies,
			fiscalByBody,
			fiscalByCategory,
			fiscalByTimePeriod,
			notableDecisions,
		] = await Promise.all([
			listRecentMeetings({ data: { bodySlug: deps.body } }),
			listGoverningBodies(),
			aggregateFiscalByBody(),
			aggregateFiscalByCategory(),
			aggregateFiscalByTimePeriod(),
			listNotableFiscalDecisions({ data: {} }),
		]);
		return {
			meetings,
			bodies,
			fiscalByBody,
			fiscalByCategory,
			fiscalByTimePeriod,
			notableDecisions,
		};
	},
	head: () => ({
		meta: [{ title: "Civic Mirror — Local Government Transparency" }],
	}),
	component: LandingPageRoute,
});

function LandingPageRoute() {
	const data = Route.useLoaderData();
	const { body } = Route.useSearch();
	const navigate = Route.useNavigate();

	return (
		<LandingPage
			data={data}
			selectedBody={body}
			onBodyChange={(slug) => navigate({ search: { body: slug || undefined } })}
		/>
	);
}

function formatCurrency(amount: number): string {
	if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
	if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
	return `$${amount.toLocaleString()}`;
}

function totalTracked(rows: FiscalByBody[]): number {
	return rows.reduce((sum, r) => sum + r.totalAmount, 0);
}

function totalDecisions(rows: FiscalByBody[]): number {
	return rows.reduce((sum, r) => sum + r.decisionCount, 0);
}

export function LandingPage({
	data,
	selectedBody,
	onBodyChange,
}: {
	data: LandingData;
	selectedBody?: string;
	onBodyChange?: (slug: string) => void;
}) {
	const lead = data.meetings[0];
	const feed = data.meetings.slice(1);
	const tracked = totalTracked(data.fiscalByBody);
	const decisionCount = totalDecisions(data.fiscalByBody);

	return (
		<main className="page-wrap px-4 pb-8 pt-8">
			{/* Dateline strip */}
			<div className="mono flex flex-wrap justify-between gap-2 border-y border-[var(--rule)] bg-[var(--paper-alt)] px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--ink-soft)]">
				<span>
					<span className="font-bold text-[var(--accent)]">
						ELLETTSVILLE, IND.
					</span>{" "}
					— Today's edition
				</span>
				<span className="hidden sm:inline">
					{data.meetings.length} meetings filed · {decisionCount} decisions ·{" "}
					{formatCurrency(tracked)} tracked YTD
				</span>
				<span className="hidden md:inline">8 bodies · Fully indexed</span>
			</div>

			{/* Lead story or welcome */}
			<section className="rise-in grid gap-8 pt-10 lg:grid-cols-[1.7fr_1fr]">
				<div>
					<p className="kicker text-[var(--accent)]">
						Civic Mirror — Local government, read and written for residents
					</p>
					<h1 className="display mt-3 text-[44px] leading-[0.98] tracking-[-0.025em] sm:text-[64px]">
						{lead ? leadHeadline(lead) : "Civic Mirror"}
					</h1>
					{lead ? (
						<p className="lede mt-5 text-[18px] leading-[1.5]">
							{lead.prose || lead.highlights[0]}
						</p>
					) : (
						<p className="mt-5 max-w-2xl text-[18px] leading-[1.55] text-[var(--ink-mid)]">
							AI-powered summaries of every public meeting of eight local
							governing bodies. Stay informed about what your elected officials
							are deciding — in five minutes, not five hours.
						</p>
					)}

					{/* Stats bar */}
					<div className="rule-double mt-8 grid grid-cols-2 border-b-[3px] border-double border-[var(--rule)] md:grid-cols-4">
						{[
							{ n: formatCurrency(tracked), l: "Tracked YTD" },
							{ n: decisionCount, l: "Fiscal decisions" },
							{ n: data.meetings.length, l: "Meetings summarized" },
							{ n: data.bodies.length || 8, l: "Governing bodies" },
						].map((s, i, arr) => (
							<div
								key={s.l}
								className={`py-4 pr-4 ${
									i > 0 ? "pl-4" : ""
								} ${i < arr.length - 1 ? "md:border-r md:border-[var(--rule-soft)]" : ""}`}
							>
								<div className="display text-[28px] leading-none sm:text-[34px]">
									{s.n}
								</div>
								<div className="kicker mt-2">{s.l}</div>
							</div>
						))}
					</div>
				</div>

				{/* Sidebar: subscribe + body filter */}
				<aside className="flex flex-col gap-6">
					<div className="border border-[var(--rule)] bg-[var(--paper-alt)] p-5">
						<p className="kicker">Today's docket</p>
						<h3 className="display mt-2 text-[22px] leading-[1.15]">
							Filter the feed by governing body
						</h3>
						{data.bodies.length > 0 ? (
							<label className="mono mt-4 block text-[10px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
								Governing body
								<select
									value={selectedBody ?? ""}
									onChange={(e) => onBodyChange?.(e.target.value)}
									className="mt-2 w-full"
								>
									<option value="">All bodies</option>
									{data.bodies.map((b) => (
										<option key={b.slug} value={b.slug}>
											{b.name}
										</option>
									))}
								</select>
							</label>
						) : (
							<p className="mt-3 text-[13px] text-[var(--ink-mid)]">
								Bodies appear once the pipeline has processed its first batch.
							</p>
						)}
					</div>

					<div className="border border-[var(--rule)] bg-[var(--ink)] p-5 text-[var(--paper)]">
						<p className="kicker text-[var(--highlight)]">The Weekly Digest</p>
						<h3 className="display mt-2 text-[22px] leading-[1.15] text-[var(--paper)]">
							Every Friday. One email. Decisions, drama, and where the money
							went.
						</h3>
						<div className="mt-4 flex border-2 border-[var(--highlight)] bg-[var(--ink)]">
							<div className="mono flex-1 px-3 py-2 text-[13px] text-[var(--ink-faint)]">
								you@ellettsville.in
							</div>
							<div className="mono bg-[var(--highlight)] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--ink)]">
								Subscribe →
							</div>
						</div>
					</div>
				</aside>
			</section>

			{/* Meeting feed */}
			<section className="mt-12">
				<div className="rule-double flex items-end justify-between border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
					<div>
						<p className="kicker">The Feed · Recent Meetings</p>
						<h2 className="display mt-1 text-[28px] leading-tight">
							What they actually decided
						</h2>
					</div>
					<span className="mono hidden text-[11px] uppercase tracking-[0.12em] text-[var(--ink-soft)] sm:block">
						Newest first · Six-month lookback
					</span>
				</div>

				{data.meetings.length === 0 ? (
					<div className="paper-card mt-6 p-8 text-center">
						<p className="text-[14px] text-[var(--ink-soft)]">
							No meetings available yet. Check back after the pipeline processes
							its first batch.
						</p>
					</div>
				) : (
					<div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
						{feed.map((m, index) => (
							<div
								key={m.id}
								className="rise-in"
								style={{ animationDelay: `${index * 60 + 80}ms` }}
							>
								<MeetingCard meeting={m} />
							</div>
						))}
						{feed.length === 0 && lead && (
							<div className="rise-in">
								<MeetingCard meeting={lead} />
							</div>
						)}
					</div>
				)}
			</section>

			{/* Fiscal overview */}
			<section className="rise-in mt-14" style={{ animationDelay: "200ms" }}>
				<FiscalSummary
					byBody={data.fiscalByBody}
					byCategory={data.fiscalByCategory}
					byTimePeriod={data.fiscalByTimePeriod}
					notableDecisions={data.notableDecisions}
				/>
			</section>
		</main>
	);
}

function leadHeadline(m: MeetingCardData): string {
	if (m.highlights[0]) return m.highlights[0];
	if (m.prose) {
		const first = m.prose.split(/(?<=[.!?])\s/)[0];
		if (first) return first;
	}
	return `${m.bodyName} filed — read the summary`;
}
