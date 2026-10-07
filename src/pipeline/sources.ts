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

/** One source of a meeting's record, labelled by the kind of source it is. */
export type LabelledSource = { kind: SourceKind; text: string };

/**
 * The sources a summarizer can read: each document with text, then the
 * transcript if it has any. A source with no readable text gives the
 * summarizer nothing, though its URL is still part of the fingerprint.
 */
export function readableSources(sources: {
	documents: readonly { rawText: string }[];
	transcript?: { rawText: string } | null;
}): LabelledSource[] {
	const readable: LabelledSource[] = sources.documents
		.filter((document) => document.rawText.trim() !== "")
		.map((document) => ({ kind: "documents", text: document.rawText }));
	if (sources.transcript && sources.transcript.rawText.trim() !== "") {
		readable.push({ kind: "transcript", text: sources.transcript.rawText });
	}
	return readable;
}

/** The kinds among the sources a summarizer was sent, each named once. */
export function kindsOfReadableSources(
	readable: readonly LabelledSource[],
): SourceKind[] {
	const kinds: SourceKind[] = ["documents", "transcript"];
	return kinds.filter((kind) =>
		readable.some((source) => source.kind === kind),
	);
}

/** The kinds a summary built from every readable source held was built from. */
export function kindsOfSources(sources: {
	documents: readonly { rawText: string }[];
	transcript?: { rawText: string } | null;
}): SourceKind[] {
	return kindsOfReadableSources(readableSources(sources));
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
 * What a summary stored without a fingerprint was built from: the sources its
 * meeting holds, or its transcript alone when the meeting is about to take
 * documents the summary never read.
 */
export type UnfingerprintedSummarySources =
	| {
			documents: readonly { sourceUrl: string; rawText: string }[];
			transcript?: { sourceUrl: string | null; rawText: string } | null;
	  }
	| { transcriptAlone: { sourceUrl: string | null } };

/**
 * The fingerprint and the one kind to record on a summary stored without a
 * fingerprint. Both are read from the same sources, so the two cannot describe
 * different ones.
 */
export function stampOfUnfingerprintedSummary(
	builtFrom: UnfingerprintedSummarySources,
): { sourceFingerprint: string; sourceKinds: SourceKind[] } {
	if ("transcriptAlone" in builtFrom) {
		return {
			sourceFingerprint: fingerprintOfSources({
				documents: [],
				transcriptUrl: builtFrom.transcriptAlone.sourceUrl,
			}),
			sourceKinds: ["transcript"],
		};
	}
	return {
		sourceFingerprint: fingerprintOfSources({
			documents: builtFrom.documents,
			transcriptUrl: builtFrom.transcript?.sourceUrl,
		}),
		sourceKinds: kindsOfUnfingerprintedSummary(builtFrom),
	};
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
