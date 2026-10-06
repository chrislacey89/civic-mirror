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
