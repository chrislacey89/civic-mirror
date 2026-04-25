import { Link, useRouterState } from "@tanstack/react-router";

const NAV = [
	{ to: "/", label: "Front Page", search: { body: undefined } as const },
	{
		to: "/spending",
		label: "Spending",
		search: {
			body: undefined,
			category: undefined,
			period: undefined,
		} as const,
	},
	{ to: "/drama", label: "Drama Watch" },
	{ to: "/bodies", label: "Bodies" },
	{ to: "/about", label: "About" },
] as const;

const TAB_BAR = [
	{ to: "/", label: "Front", icon: "◉", match: /^\/$/ },
	{ to: "/spending", label: "Ledger", icon: "$", match: /^\/spending/ },
	{ to: "/drama", label: "Drama", icon: "★", match: /^\/drama/ },
	{ to: "/bodies", label: "Bodies", icon: "⌂", match: /^\/bodies/ },
	{ to: "/about", label: "About", icon: "?", match: /^\/about/ },
] as const;

function dateline(): string {
	return new Date()
		.toLocaleDateString("en-US", {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
		})
		.toUpperCase();
}

function MobileTabBar() {
	const pathname = useRouterState({
		select: (s) => s.location.pathname,
	});

	return (
		<nav className="fixed bottom-0 left-0 right-0 z-50 border-t-[3px] border-double border-[var(--rule)] bg-[var(--paper)] pb-safe sm:hidden">
			<div className="flex justify-around pb-2 pt-2">
				{TAB_BAR.map((tab) => {
					const active = tab.match.test(pathname);
					return (
						<Link
							key={tab.to}
							to={tab.to}
							className="flex flex-col items-center gap-0.5 no-underline"
							style={{ color: active ? "var(--accent)" : "var(--ink-soft)" }}
						>
							<span
								className="font-display text-[18px] leading-none"
								style={{ color: active ? "var(--accent)" : "var(--ink)" }}
							>
								{tab.icon}
							</span>
							<span
								className="mono text-[9px] font-bold uppercase tracking-[0.14em]"
								style={{ color: active ? "var(--accent)" : "var(--ink-soft)" }}
							>
								{tab.label}
							</span>
						</Link>
					);
				})}
			</div>
		</nav>
	);
}

export default function Header() {
	return (
		<>
			<header className="border-b border-[var(--rule)] bg-[var(--paper)]">
				<div className="page-wrap flex flex-wrap items-end justify-between gap-6 px-2 py-5 sm:py-6">
					<Link
						to="/"
						search={{ body: undefined }}
						className="flex items-baseline gap-4 no-underline"
					>
						<h1 className="display m-0 text-4xl leading-none sm:text-5xl">
							Civic Mirror
						</h1>
						<span className="mono hidden text-[11px] uppercase tracking-[0.18em] text-[var(--ink-soft)] sm:inline">
							Ellettsville · Monroe County, IN
						</span>
					</Link>
					<div className="mono hidden text-right text-[11px] uppercase leading-[1.55] tracking-[0.14em] text-[var(--ink-soft)] sm:block">
						Vol. II — No. 16
						<br />
						{dateline()}
					</div>
				</div>

				<div className="border-t border-[var(--rule)]" />

				<nav className="border-t border-[var(--rule)] bg-[var(--paper)]">
					<div className="page-wrap flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-2 py-3">
						<ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
							{NAV.map((item) => (
								<li key={item.to}>
									<Link
										to={item.to}
										search={"search" in item ? item.search : undefined}
										className="subnav-link"
										activeProps={{ className: "subnav-link is-active" }}
										activeOptions={{ exact: item.to === "/" }}
									>
										{item.label}
									</Link>
								</li>
							))}
						</ul>
						<div className="mono hidden items-center gap-4 text-[11px] text-[var(--ink-soft)] md:flex">
							<span>Independent · Non-partisan · AI-summarized</span>
							<span className="border border-[var(--ink)] bg-[var(--paper)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--ink)]">
								Subscribe — Weekly digest →
							</span>
						</div>
					</div>
				</nav>
			</header>
			<MobileTabBar />
		</>
	);
}
