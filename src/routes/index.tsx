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

export function LandingPage({
	data,
	selectedBody,
	onBodyChange,
}: {
	data: LandingData;
	selectedBody?: string;
	onBodyChange?: (slug: string) => void;
}) {
	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			{/* Hero */}
			<section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
				<div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
				<div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />
				<p className="island-kicker mb-3">Ellettsville & Monroe County</p>
				<h1 className="display-title mb-5 max-w-3xl text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
					Civic Mirror
				</h1>
				<p className="mb-0 max-w-2xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
					AI-powered summaries of local government meetings. Stay informed about
					what your elected officials are deciding — in 5 minutes, not 5 hours.
				</p>
			</section>

			{/* Body Filter + Meeting Feed */}
			<section className="mt-8">
				<div className="mb-4 flex items-center justify-between">
					<h2 className="text-lg font-semibold text-[var(--sea-ink)]">
						Recent Meetings
					</h2>
					{data.bodies.length > 0 && (
						<select
							value={selectedBody ?? ""}
							onChange={(e) => onBodyChange?.(e.target.value)}
							className="rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5 text-sm text-[var(--sea-ink)]"
						>
							<option value="">All Bodies</option>
							{data.bodies.map((b) => (
								<option key={b.slug} value={b.slug}>
									{b.name}
								</option>
							))}
						</select>
					)}
				</div>

				{data.meetings.length === 0 ? (
					<div className="island-shell rounded-2xl p-6 text-center">
						<p className="text-sm text-[var(--sea-ink-soft)]">
							No meetings available yet. Check back after the pipeline processes
							its first batch.
						</p>
					</div>
				) : (
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{data.meetings.map((m, index) => (
							<div
								key={m.id}
								className="rise-in"
								style={{
									animationDelay: `${index * 60 + 80}ms`,
								}}
							>
								<MeetingCard meeting={m} />
							</div>
						))}
					</div>
				)}
			</section>

			{/* Fiscal Summary */}
			<section className="rise-in mt-8" style={{ animationDelay: "200ms" }}>
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
