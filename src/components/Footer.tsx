export default function Footer() {
	const year = new Date().getFullYear();

	return (
		<footer className="mt-20 border-t-[3px] border-double border-[var(--rule)] bg-[var(--paper-alt)]">
			<div className="page-wrap px-2 py-10">
				<div className="grid grid-cols-1 gap-10 md:grid-cols-[1.6fr_1fr_1fr_1.4fr]">
					<div>
						<div className="display text-2xl">Civic Mirror</div>
						<p className="kicker mt-2">Independent · Non-partisan</p>
						<p className="mt-3 max-w-[30ch] text-[13px] leading-6 text-[var(--ink-mid)]">
							Summaries of every public meeting of eight local governing bodies,
							read by AI and written for residents.
						</p>
					</div>
					<div>
						<p className="kicker">Sections</p>
						<ul className="mt-3 list-none space-y-1 p-0 text-[14px] text-[var(--ink)]">
							<li>Front Page</li>
							<li>Meetings</li>
							<li>Spending</li>
							<li>Governing Bodies</li>
						</ul>
					</div>
					<div>
						<p className="kicker">Sources</p>
						<ul className="mt-3 list-none space-y-1 p-0 text-[14px] text-[var(--ink)]">
							<li>Ellettsville eGov portal</li>
							<li>Monroe County records</li>
							<li>YouTube / meeting video</li>
							<li>Open source code</li>
						</ul>
					</div>
					<div>
						<p className="kicker">The Weekly Digest</p>
						<p className="mt-3 text-[13px] leading-6 text-[var(--ink-mid)]">
							Every Friday morning. One email. Decisions, drama, and where the
							money went.
						</p>
						<div className="mt-3 flex border border-[var(--ink)] bg-[var(--paper)]">
							<div className="mono flex-1 px-3 py-2 text-[12px] text-[var(--ink-faint)]">
								you@example.com
							</div>
							<div className="mono bg-[var(--ink)] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--paper)]">
								Subscribe
							</div>
						</div>
					</div>
				</div>
				<div className="rule-dot mt-6 pt-3" />
				<div className="mono flex flex-wrap justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--ink-soft)]">
					<span>© {year} Civic Mirror · Bloomington, IN</span>
					<span>
						All figures AI-extracted — verify against source
						<sup className="ml-0.5">?</sup>
					</span>
				</div>
			</div>
		</footer>
	);
}
