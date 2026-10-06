import { Option } from "effect";
import { extractMeetingDateFromTitle } from "#/pipeline/dates.ts";

/**
 * The title and meeting date for a `drama:detect` run. The date is `--date`
 * first, then a date read from a `--title` the operator typed, otherwise null.
 * It is never today, and never read from the stub title that stands in for a
 * missing `--title`: the stub embeds the video ID, which can look like a
 * numeric date.
 */
export function resolveDetectMeeting(input: {
	videoId: string;
	date: Option.Option<string>;
	title: Option.Option<string>;
}): { title: string; meetingDate: string | null } {
	return {
		title: Option.getOrElse(
			input.title,
			() => `Manual drama:detect ${input.videoId}`,
		),
		meetingDate:
			Option.getOrNull(input.date) ??
			Option.match(input.title, {
				onNone: () => null,
				onSome: extractMeetingDateFromTitle,
			}),
	};
}
