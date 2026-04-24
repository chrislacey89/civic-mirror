import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
	component: About,
});

function About() {
	return (
		<main className="page-wrap px-4 pb-8 pt-6">
			<div className="mono flex flex-wrap justify-between gap-2 border-y border-[var(--rule)] bg-[var(--paper-alt)] px-2 py-2 text-[11px] uppercase tracking-[0.16em] text-[var(--ink-soft)]">
				<span>
					<span className="font-bold text-[var(--accent)]">ABOUT</span> — The
					Ledger's masthead and methods
				</span>
				<span className="hidden sm:inline">
					Independent · Non-partisan · Open source
				</span>
			</div>

			<section className="rise-in pt-12">
				<p className="kicker text-[var(--accent)]">About the Ledger</p>
				<h1 className="display mt-3 text-[44px] leading-[0.98] tracking-[-0.025em] sm:text-[60px]">
					Civic Mirror is a local newspaper for a town that lost one.
				</h1>
				<p className="lede mt-6 max-w-[68ch] text-[18px] leading-[1.5]">
					Every public meeting of eight governing bodies in Ellettsville and
					Monroe County, read by AI and written for residents. No ads, no
					paywall, no political slant — just what your elected officials
					actually did this week.
				</p>
			</section>

			<section className="mt-12 grid gap-10 md:grid-cols-2">
				<div>
					<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3">
						<p className="kicker">Our methods</p>
						<h2 className="display mt-1 text-[24px]">How this gets written</h2>
					</div>
					<p className="mt-4 text-[16px] leading-[1.6] text-[var(--ink)]">
						Agendas, minutes, and ordinances are pulled from public government
						portals. Scanned PDFs are run through OCR. Meeting videos are
						transcribed. A large language model condenses each meeting into
						highlights, a prose summary, and a structured ledger of fiscal
						decisions. Every figure is linked back to the source document so you
						can verify it yourself.
					</p>
				</div>

				<div>
					<div className="rule-double border-b-[3px] border-double border-[var(--rule)] pb-3">
						<p className="kicker">Our limits</p>
						<h2 className="display mt-1 text-[24px]">What to watch for</h2>
					</div>
					<p className="mt-4 text-[16px] leading-[1.6] text-[var(--ink)]">
						OCR-derived figures carry a small <sup>?</sup> badge. Meetings whose
						documents could not be extracted show only a link to the source PDF.
						Nothing here is a substitute for attending a meeting or reading the
						full minutes — this is a starting point for an informed resident,
						not the last word.
					</p>
				</div>
			</section>
		</main>
	);
}
