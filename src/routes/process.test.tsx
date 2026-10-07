// @vitest-environment jsdom

import { isRedirect } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Route as DramaRoute } from "./drama.tsx";
import { ProcessPage } from "./process.tsx";

afterEach(cleanup);

describe("ProcessPage", () => {
	it("introduces the section as a review of how each meeting ran", () => {
		render(<ProcessPage meetings={[]} />);

		screen.getByRole("heading", { level: 1, name: "How each meeting ran" });
		expect(document.body.textContent).not.toMatch(
			/drama|grievance|gossip|petty|pettiness|wasted/i,
		);
	});
});

describe("/drama", () => {
	it("permanently redirects to /process", () => {
		let thrown: unknown;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: the redirect ignores its context
			DramaRoute.options.beforeLoad?.({} as any);
		} catch (error) {
			thrown = error;
		}

		expect(isRedirect(thrown)).toBe(true);
		expect((thrown as Response).status).toBe(301);
		expect((thrown as { options: { to: string } }).options.to).toBe("/process");
	});
});
