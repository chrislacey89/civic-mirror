import { createHash } from "node:crypto";

/** The kinds of source a meeting's summary can be built from. */
export type SourceKind = "documents" | "transcript";

/** A point where a meeting's documents and its transcript state different things. */
export type SourceDisagreement = {
	topic: string;
	documentsSay: string;
	transcriptSays: string;
};

/** Stable hash of a meeting's document source URLs and transcript source URL, order-independent. */
export function computeSourceFingerprint(
	sourceUrls: readonly string[],
): string {
	const unique = [...new Set(sourceUrls)].sort();
	// JSON keeps the boundaries between URLs, which a joined string would lose.
	return createHash("sha256").update(JSON.stringify(unique)).digest("hex");
}

/**
 * The session half of a meeting's key: a meeting label lowercased, with each
 * run of other characters collapsed to one "-" and the ends trimmed. School
 * board rows and video titles both build it here, because a video is paired
 * with its documents by exact session. The start time stays in a Finalsite
 * label's slug: two hearings on one day can differ in nothing else.
 */
export function sessionSlug(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
