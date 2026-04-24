import { Link } from "@tanstack/react-router";
import ThemeToggle from "./ThemeToggle";

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
	{ to: "/about", label: "About" },
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

export default function Header() {
	return (
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
				<div className="flex items-center gap-4">
					<div className="mono hidden text-right text-[11px] uppercase leading-[1.55] tracking-[0.14em] text-[var(--ink-soft)] sm:block">
						Vol. II — No. 16
						<br />
						{dateline()}
					</div>
					<ThemeToggle />
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
	);
}
