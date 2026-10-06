import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { resolveDetectMeeting } from "#/pipeline/detect-date.ts";

const none = Option.none<string>();

describe("resolveDetectMeeting", () => {
	it("takes --date as given", () => {
		expect(
			resolveDetectMeeting({
				videoId: "abc",
				date: Option.some("2026-03-23"),
				title: Option.some("Town Council Meeting Minutes 01-02-26"),
			}).meetingDate,
		).toBe("2026-03-23");
	});

	it("reads the date from a typed --title when --date is absent", () => {
		expect(
			resolveDetectMeeting({
				videoId: "abc",
				date: none,
				title: Option.some("Town Council Meeting Minutes 03-23-26"),
			}).meetingDate,
		).toBe("2026-03-23");
	});

	it("returns null, not today, when neither carries a date", () => {
		expect(
			resolveDetectMeeting({ videoId: "abc", date: none, title: none })
				.meetingDate,
		).toBeNull();
		expect(
			resolveDetectMeeting({
				videoId: "abc",
				date: none,
				title: Option.some("Town Council Annual Report"),
			}).meetingDate,
		).toBeNull();
	});

	it("does not read a date out of a date-like video ID in the stub title", () => {
		const resolved = resolveDetectMeeting({
			videoId: "1-2-26abcde",
			date: none,
			title: none,
		});
		expect(resolved.title).toBe("Manual drama:detect 1-2-26abcde");
		expect(resolved.meetingDate).toBeNull();
	});
});
