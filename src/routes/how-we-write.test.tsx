// @vitest-environment jsdom

import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	type RouteComponent,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	WRITING_EXAMPLES,
	WRITING_PRINCIPLES,
} from "#/lib/writing-standard.ts";
import { Route as AboutRoute } from "./about.tsx";
import { HowWeWritePage } from "./how-we-write.tsx";

afterEach(cleanup);

/** Renders a page inside a router so its `<Link>`s resolve to real hrefs. */
async function renderInRouter(component: RouteComponent) {
	const router = createRouter({
		routeTree: createRootRoute({ component }),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await screen.findByRole("heading", { level: 1 });
}

describe("HowWeWritePage", () => {
	it("states every principle", async () => {
		await renderInRouter(HowWeWritePage);

		expect(WRITING_PRINCIPLES).toHaveLength(8);
		for (const principle of WRITING_PRINCIPLES) {
			screen.getByText(principle);
		}
	});

	it("shows at least three meetings, each before and after, linked to its meeting page and sources", async () => {
		await renderInRouter(HowWeWritePage);

		const examples = screen.getAllByRole("article");
		expect(examples.length).toBeGreaterThanOrEqual(3);

		examples.forEach((article, i) => {
			const example = WRITING_EXAMPLES[i];
			const scope = within(article);

			within(scope.getByRole("region", { name: "Before" })).getByText(
				example.before.highlights[0],
				{ selector: "h4" },
			);
			within(scope.getByRole("region", { name: "After" })).getByText(
				example.after.highlights[0],
				{ selector: "h4" },
			);

			const meetingHref = scope
				.getByRole("link", { name: "Meeting page" })
				.getAttribute("href");
			expect(meetingHref).toContain(
				`/meetings/${example.bodySlug}/${example.date}`,
			);
			if (example.session) {
				expect(meetingHref).toContain(`session=${example.session}`);
			}

			expect(example.sources.length).toBeGreaterThan(0);
			for (const source of example.sources) {
				expect(
					scope.getByRole("link", { name: source.label }).getAttribute("href"),
				).toBe(source.url);
			}
		});
	});

	it("says the live summaries are machine-drafted and invites reports", async () => {
		await renderInRouter(HowWeWritePage);

		screen.getByRole("heading", {
			name: "The live summaries are machine-drafted to this standard",
		});
		expect(
			screen.getByRole("link", { name: "report it" }).getAttribute("href"),
		).toMatch(/^https:\/\/github\.com\/chrislacey89\/civic-mirror\/issues/);
	});
});

describe("/about", () => {
	it("links to the writing standard", async () => {
		// biome-ignore lint/style/noNonNullAssertion: the route declares a component
		await renderInRouter(AboutRoute.options.component!);

		expect(
			screen.getByRole("link", { name: "How we write" }).getAttribute("href"),
		).toBe("/how-we-write");
	});
});
