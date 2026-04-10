import { Context, Effect, Layer } from "effect";
import { NetworkError } from "#/pipeline/errors.ts";

/**
 * Effect teaching note: AlertService is deliberately kept thin. It knows how
 * to *send* an alert — nothing more. The orchestrator decides *when* to send
 * one (error propagation, zero-results detection) and builds the subject and
 * body using the format helpers exported below.
 *
 * This keeps the service single-responsibility and mockable: tests swap in a
 * `sendFn` that pushes to an array, production wires up Resend. No Resend-
 * specific knowledge leaks into the orchestrator.
 */

type AlertInput = {
	subject: string;
	body: string;
};

interface AlertServiceInterface {
	sendAlert(input: AlertInput): Effect.Effect<void, NetworkError>;
}

class AlertService extends Context.Tag("AlertService")<
	AlertService,
	AlertServiceInterface
>() {}

type AlertSendFn = (input: {
	to: string;
	from: string;
	subject: string;
	body: string;
}) => Promise<void>;

type AlertServiceConfig = {
	/** Recipient address — typically the developer's operational inbox. */
	to: string;
	/** From address — must be a verified sender on Resend. */
	from: string;
	/** Async send function; defaults to undefined so tests force injection. */
	sendFn: AlertSendFn;
};

/**
 * Layer that wraps the injected send function in Effect.tryPromise so any
 * thrown exception becomes a typed NetworkError. Callers never see raw
 * Resend errors — they see the same NetworkError shape the scrapers produce,
 * which lets Effect.catchTag handlers treat all network failures uniformly.
 */
function AlertServiceLive(
	config: AlertServiceConfig,
): Layer.Layer<AlertService> {
	return Layer.succeed(AlertService, {
		sendAlert: (input) =>
			Effect.tryPromise({
				try: () =>
					config.sendFn({
						to: config.to,
						from: config.from,
						subject: input.subject,
						body: input.body,
					}),
				catch: (error) =>
					new NetworkError({
						url: "resend:send",
						message: error instanceof Error ? error.message : String(error),
					}),
			}),
	});
}

/**
 * Builds a subject + body pair for the 30-day zero-results anomaly. The
 * orchestrator detects the anomaly by querying when the body last had new
 * content stored; this helper turns that information into an operator email.
 */
function formatZeroResultsAlert(input: {
	bodyName: string;
	daysSinceLastContent: number;
}): AlertInput {
	return {
		subject: `[Civic Mirror] No new content for ${input.bodyName}`,
		body: [
			`${input.bodyName} has had no new documents or videos ingested in ${input.daysSinceLastContent} days.`,
			"",
			"This may indicate a scraper regression, a source site change, or a genuine gap in public meetings.",
			"",
			"Check the pipeline logs and verify the upstream source.",
		].join("\n"),
	};
}

/**
 * Builds a subject + body pair for a pipeline-stage failure. Used by the
 * orchestrator's error boundary when a stage fails for a specific body.
 */
function formatPipelineErrorAlert(input: {
	stage: string;
	bodyName: string;
	errorTag: string;
	errorMessage: string;
}): AlertInput {
	return {
		subject: `[Civic Mirror] ${input.stage} failed for ${input.bodyName}`,
		body: [
			`Pipeline stage "${input.stage}" failed while processing ${input.bodyName}.`,
			"",
			`Error: ${input.errorTag}`,
			`Message: ${input.errorMessage}`,
			"",
			"The pipeline will continue with other bodies; this body was skipped.",
		].join("\n"),
	};
}

export {
	AlertService,
	AlertServiceLive,
	formatZeroResultsAlert,
	formatPipelineErrorAlert,
};
export type { AlertInput, AlertSendFn, AlertServiceConfig };
