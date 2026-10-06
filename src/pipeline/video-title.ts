import { extractLongFormDate } from "#/pipeline/dates.ts";

/**
 * What a playlist video's title says. `unrecognized` is every title that is
 * not `<prefix>[ qualifier], Month D, YYYY`: another body's recording, a
 * title with no long-form date, or one with words after the date.
 */
export type VideoTitleReading =
	| { kind: "meeting"; date: string; session: string; qualifier: string | null }
	| { kind: "unrecognized" };

/**
 * Reads `<prefix>[ qualifier], Month D, YYYY`. Long-form dates only. session is "" for no qualifier, else the qualifier's slug.
 */
export function readVideoTitle(
	title: string,
	bodyTitlePrefix: string,
): VideoTitleReading {
	const trimmed = title.trim();
	if (!trimmed.toLowerCase().startsWith(bodyTitlePrefix.toLowerCase())) {
		return { kind: "unrecognized" };
	}

	// Everything up to the first comma is the qualifier; everything after it
	// must be the date and nothing else.
	const rest = trimmed.slice(bodyTitlePrefix.length);
	const parts = rest.match(/^(?:\s+([^,]+?))?\s*,\s*(.+)$/);
	if (!parts) return { kind: "unrecognized" };

	const datePart = parts[2].trim();
	if (!/^[A-Za-z]+\s+\d{1,2}\s*,?\s*\d{4}$/.test(datePart)) {
		return { kind: "unrecognized" };
	}
	const date = extractLongFormDate(datePart);
	if (date === null) return { kind: "unrecognized" };

	const qualifier = parts[1] ?? null;
	if (qualifier === null) {
		return { kind: "meeting", date, session: "", qualifier };
	}

	// An empty session is the regular meeting's key, so a qualifier that slugs
	// to nothing cannot be told apart from it.
	const session = slugify(qualifier);
	if (session === "") return { kind: "unrecognized" };

	return { kind: "meeting", date, session, qualifier };
}

function slugify(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
