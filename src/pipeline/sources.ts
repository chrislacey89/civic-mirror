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
 * The fingerprint of a meeting's sources: every document URL plus the
 * transcript URL, whether or not their text was readable. An unreadable
 * source is one the summary has already accounted for, so leaving it out
 * would make the meeting look changed on every run. Every place that stores
 * or compares a fingerprint builds it here, so they cannot disagree.
 */
export function fingerprintOfSources(sources: {
	documents: readonly { sourceUrl: string }[];
	transcriptUrl?: string | null;
}): string {
	const sourceUrls = sources.documents.map((document) => document.sourceUrl);
	if (sources.transcriptUrl) sourceUrls.push(sources.transcriptUrl);
	return computeSourceFingerprint(sourceUrls);
}

/**
 * The kinds a summary built from these sources was built from. A source with
 * no readable text gave the summarizer nothing, so its kind is not counted,
 * though its URL is still part of the fingerprint.
 */
export function kindsOfSources(sources: {
	documents: readonly { rawText: string }[];
	transcript?: { rawText: string } | null;
}): SourceKind[] {
	const kinds: SourceKind[] = [];
	if (sources.documents.some((document) => document.rawText.trim() !== "")) {
		kinds.push("documents");
	}
	if (sources.transcript && sources.transcript.rawText.trim() !== "") {
		kinds.push("transcript");
	}
	return kinds;
}

/**
 * The kinds a summary stored without a fingerprint was built from. Only a
 * single-kind path writes one, so it never read both: the documents when the
 * meeting holds any with text, the transcript otherwise. A meeting can hold a
 * transcript the summary never read (attached by a path that does not
 * regenerate), so `kindsOfSources` would credit it wrongly here.
 */
export function kindsOfUnfingerprintedSummary(sources: {
	documents: readonly { rawText: string }[];
	transcript?: { rawText: string } | null;
}): SourceKind[] {
	return kindsOfSources(sources).slice(0, 1);
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
