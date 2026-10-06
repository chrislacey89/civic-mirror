import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	AlertService,
	AlertServiceLive,
	formatPipelineErrorAlert,
	formatZeroResultsAlert,
} from "./AlertService.ts";

describe("AlertService", () => {
	describe("formatZeroResultsAlert", () => {
		it("builds a subject and body naming the body and days", () => {
			const alert = formatZeroResultsAlert({
				bodyName: "Ellettsville Town Council",
				daysSinceLastContent: 42,
			});

			expect(alert.subject).toContain("Ellettsville Town Council");
			expect(alert.subject.toLowerCase()).toContain("no new");
			expect(alert.body).toContain("42");
			expect(alert.body).toContain("Ellettsville Town Council");
		});
	});

	describe("formatPipelineErrorAlert", () => {
		it("includes the stage and error message in the body", () => {
			const alert = formatPipelineErrorAlert({
				stage: "summarize",
				bodyName: "Plan Commission",
				errorTag: "LlmError",
				errorMessage: "quota exceeded",
				scope: "item",
			});

			expect(alert.subject).toContain("summarize");
			expect(alert.body).toContain("Plan Commission");
			expect(alert.body).toContain("LlmError");
			expect(alert.body).toContain("quota exceeded");
		});

		it("says the whole body was skipped for a body-scoped failure", () => {
			const alert = formatPipelineErrorAlert({
				stage: "scrape",
				bodyName: "Plan Commission",
				errorTag: "NetworkError",
				errorMessage: "timeout",
				scope: "body",
			});

			expect(alert.body).toContain("this body was skipped");
		});

		it("says only one item was affected for an item-scoped failure", () => {
			const alert = formatPipelineErrorAlert({
				stage: "date",
				bodyName: "Plan Commission",
				errorTag: "UndatedListingError",
				errorMessage: "no date",
				scope: "item",
			});

			expect(alert.body).not.toContain("this body was skipped");
			expect(alert.body).toContain("rest of Plan Commission");
		});

		it("promises no further work for a failure in a run of one item", () => {
			const alert = formatPipelineErrorAlert({
				stage: "drama-detection",
				bodyName: "Plan Commission",
				errorTag: "LlmError",
				errorMessage: "quota exceeded",
				scope: "sole-item",
			});

			expect(alert.body).not.toContain("will continue");
			expect(alert.body).toContain("only item in this run");
		});
	});

	describe("AlertServiceLive", () => {
		it("sends alert via injected sendFn", async () => {
			const sent: Array<{ to: string; subject: string; body: string }> = [];

			const program = Effect.gen(function* () {
				const service = yield* AlertService;
				yield* service.sendAlert({
					subject: "Test Alert",
					body: "Something happened.",
				});
			}).pipe(
				Effect.provide(
					AlertServiceLive({
						to: "alerts@example.com",
						from: "civic-mirror@example.com",
						sendFn: async (input) => {
							sent.push(input);
						},
					}),
				),
			);

			await Effect.runPromise(program);

			expect(sent).toHaveLength(1);
			expect(sent[0].to).toBe("alerts@example.com");
			expect(sent[0].subject).toBe("Test Alert");
			expect(sent[0].body).toBe("Something happened.");
		});

		it("returns NetworkError when the send function throws", async () => {
			const program = Effect.gen(function* () {
				const service = yield* AlertService;
				yield* service.sendAlert({
					subject: "Test",
					body: "Body",
				});
			}).pipe(
				Effect.provide(
					AlertServiceLive({
						to: "alerts@example.com",
						from: "civic-mirror@example.com",
						sendFn: async () => {
							throw new Error("Resend API 500");
						},
					}),
				),
			);

			const error = await Effect.runPromise(program.pipe(Effect.flip));
			expect(error._tag).toBe("NetworkError");
			expect(error.message).toContain("Resend API 500");
		});

		it("passes the configured from address to sendFn", async () => {
			const sent: Array<{ to: string; from: string }> = [];

			const program = Effect.gen(function* () {
				const service = yield* AlertService;
				yield* service.sendAlert({ subject: "x", body: "y" });
			}).pipe(
				Effect.provide(
					AlertServiceLive({
						to: "ops@example.com",
						from: "alerts@civic-mirror.dev",
						sendFn: async (input) => {
							sent.push({ to: input.to, from: input.from });
						},
					}),
				),
			);

			await Effect.runPromise(program);

			expect(sent[0].from).toBe("alerts@civic-mirror.dev");
			expect(sent[0].to).toBe("ops@example.com");
		});
	});
});
