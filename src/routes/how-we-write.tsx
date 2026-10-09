import { createFileRoute, Link } from "@tanstack/react-router";
import {
	REPORT_URL,
	RUBRIC_URL,
	WRITING_EXAMPLES,
	WRITING_PRINCIPLES,
	type WriteUp,
	type WritingExample,
} from "#/lib/writing-standard.ts";

export const Route = createFileRoute("/how-we-write")({
	head: () => ({
		meta: [{ title: "How We Write — Civic Mirror" }],
	}),
	component: HowWeWritePage,
});

function formatDate(iso: string): string {
	const [year, month, day] = iso.split("-");
	const date = new Date(Number(year), Number(month) - 1, Number(day));
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

export function HowWeWritePage() {
	return (
		<main className="page-wrap px-4 pb-8 pt-6">
			<div className="mono flex flex-wrap justify-between gap-2 border-y border-[var(--rule)] bg-[var(--paper-alt)] px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--ink-soft)]">
				<span>
					<span className="font-bold text-[var(--accent)]">HOW WE WRITE</span> —
					The Ledger's writing standard
				</span>
				<span className="hidden sm:inline">
					Eight principles · {WRITING_EXAMPLES.length} meetings, before and
					after
				</span>
			</div>

			<section className="rise-in pt-12">
				<p className="kicker text-[var(--accent)]">Our writing standard</p>
				<h1 className="display mt-3 text-[44px] leading-[0.98] tracking-[-0.025em] sm:text-[60px]">
					A meeting report should read like a good local reporter wrote it, not
					like the minutes.
				</h1>
				<p className="lede mt-6 max-w-[68ch] text-[18px] leading-[1.5]">
					Every meeting on this site gets a headline, a few highlights and a
					short summary. This page says what we want that writing to do, and
					shows the same meetings written the old way and the new way so you can
					judge it yourself.
				</p>
			</section>

			<section className="mt-12">
				<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
					<p className="kicker">The standard</p>
					<h2 className="display mt-1 text-[26px]">Eight principles</h2>
				</div>
				<ol className="mt-5 max-w-[72ch] list-decimal space-y-2 pl-6 text-[16px] leading-[1.6] text-[var(--ink)] marker:font-bold marker:text-[var(--accent)]">
					{WRITING_PRINCIPLES.map((principle) => (
						<li key={principle}>{principle}</li>
					))}
				</ol>
				<p className="mt-5 max-w-[72ch] text-[14px] leading-[1.6] text-[var(--ink-mid)]">
					These are the short version. The{" "}
					<a href={RUBRIC_URL} target="_blank" rel="noopener noreferrer">
						full checklist
					</a>{" "}
					we score a write-up against, with the reasoning behind each check, is
					public.
				</p>
			</section>

			<section className="mt-12">
				<div className="paper-card-alt max-w-[72ch] p-6">
					<p className="kicker">Who writes this</p>
					<h2 className="display mt-1 text-[22px] leading-tight">
						The live summaries are machine-drafted to this standard
					</h2>
					<p className="mt-3 text-[15px] leading-[1.6] text-[var(--ink)]">
						A language model writes each meeting's summary from the public
						record, working to the principles above. The “after” versions below
						were written by hand; they are the target we hold the machine to,
						and the summary on a meeting's own page may read differently.
					</p>
					<p className="mt-3 text-[15px] leading-[1.6] text-[var(--ink)]">
						If a summary on this site misses the standard, please{" "}
						<a href={REPORT_URL} target="_blank" rel="noopener noreferrer">
							report it
						</a>{" "}
						and tell us which meeting.
					</p>
				</div>
			</section>

			<section className="mt-14">
				<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3 pt-4">
					<p className="kicker">Before and after</p>
					<h2 className="display mt-1 text-[26px]">
						Real meetings, side by side
					</h2>
				</div>
				<p className="mt-4 max-w-[72ch] text-[14px] leading-[1.6] text-[var(--ink-mid)]">
					“Before” is the summary as this site first published it, unedited.
					“After” is the same meeting rewritten to the standard from the same
					sources.
				</p>
				{WRITING_EXAMPLES.map((example) => (
					<Example key={example.date} example={example} />
				))}
			</section>
		</main>
	);
}

function Example({ example }: { example: WritingExample }) {
	return (
		<article className="mt-10 border-t-[3px] border-double border-[var(--rule)] pt-6">
			<p className="kicker text-[var(--accent)]">{example.bodyName}</p>
			<h3 className="display mt-1 text-[24px]">{formatDate(example.date)}</h3>
			<p className="mt-1 text-[15px] italic text-[var(--ink-mid)]">
				{example.context}
			</p>
			<p className="mono mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.12em]">
				<Link
					to="/meetings/$bodySlug/$date"
					params={{ bodySlug: example.bodySlug, date: example.date }}
					search={example.session ? { session: example.session } : {}}
				>
					Meeting page
				</Link>
				{example.sources.map((source) => (
					<a
						key={source.url}
						href={source.url}
						target="_blank"
						rel="noopener noreferrer"
					>
						{source.label}
					</a>
				))}
			</p>
			<div className="mt-5 grid gap-6 lg:grid-cols-2">
				<WriteUpCard label="Before" writeUp={example.before} />
				<WriteUpCard label="After" writeUp={example.after} accent />
			</div>
		</article>
	);
}

function WriteUpCard({
	label,
	writeUp,
	accent = false,
}: {
	label: string;
	writeUp: WriteUp;
	accent?: boolean;
}) {
	const [headline] = writeUp.highlights;
	return (
		<section
			aria-label={label}
			className={`paper-card min-w-0 border-t-4 p-5 ${
				accent ? "border-t-[var(--accent)]" : "border-t-[var(--ink)]"
			}`}
		>
			<p
				className={`kicker ${accent ? "text-[var(--accent)]" : ""}`}
				aria-hidden="true"
			>
				{label}
			</p>
			<h4 className="display mt-2 text-[24px] leading-[1.15]">{headline}</h4>
			<p className="kicker mt-5">Highlights</p>
			<ol className="mt-2 list-decimal space-y-1 pl-6 text-[15px] leading-[1.5] text-[var(--ink)]">
				{writeUp.highlights.map((highlight) => (
					<li key={highlight}>{highlight}</li>
				))}
			</ol>
			<p className="kicker mt-5">Summary</p>
			{writeUp.prose.split("\n\n").map((paragraph) => (
				<p
					key={paragraph}
					className="mt-2 text-[15px] leading-[1.6] text-[var(--ink)]"
				>
					{paragraph}
				</p>
			))}
		</section>
	);
}
