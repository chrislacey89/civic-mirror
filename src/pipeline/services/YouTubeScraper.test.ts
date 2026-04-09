import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { YouTubeScraper, YouTubeScraperLive } from "./YouTubeScraper.ts";

const mockPlaylistItemsResponse = {
	items: [
		{
			snippet: {
				resourceId: { videoId: "video1" },
				title: "Town Council, March 23, 2026",
				publishedAt: "2026-03-24T00:00:00Z",
			},
		},
		{
			snippet: {
				resourceId: { videoId: "video2" },
				title: "Plan Commission, March 15, 2026",
				publishedAt: "2026-03-16T00:00:00Z",
			},
		},
	],
};

const mockVideosResponse = {
	items: [
		{ id: "video1", contentDetails: { caption: "true" } },
		{ id: "video2", contentDetails: { caption: "false" } },
	],
};

function createMockFetch() {
	return async (url: string | URL | Request) => {
		const urlStr = url.toString();
		if (urlStr.includes("playlistItems")) {
			return new Response(JSON.stringify(mockPlaylistItemsResponse));
		}
		if (urlStr.includes("/videos")) {
			return new Response(JSON.stringify(mockVideosResponse));
		}
		return new Response("Not found", { status: 404 });
	};
}

describe("YouTubeScraper", () => {
	it("lists videos from a playlist with caption availability", async () => {
		const program = Effect.gen(function* () {
			const scraper = yield* YouTubeScraper;
			return yield* scraper.listPlaylistVideos("PLtest123");
		}).pipe(
			Effect.provide(
				YouTubeScraperLive({
					apiKey: "test-key",
					fetchFn: createMockFetch(),
				}),
			),
		);

		const videos = await Effect.runPromise(program);

		expect(videos).toHaveLength(2);
		expect(videos[0]).toEqual({
			videoId: "video1",
			title: "Town Council, March 23, 2026",
			publishedAt: "2026-03-24T00:00:00Z",
			hasCaptions: true,
		});
		expect(videos[1]).toEqual({
			videoId: "video2",
			title: "Plan Commission, March 15, 2026",
			publishedAt: "2026-03-16T00:00:00Z",
			hasCaptions: false,
		});
	});

	it("handles paginated playlist responses", async () => {
		let callCount = 0;
		const paginatedFetch = async (url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.includes("playlistItems")) {
				callCount++;
				if (callCount === 1) {
					return new Response(
						JSON.stringify({
							nextPageToken: "page2token",
							items: [
								{
									snippet: {
										resourceId: { videoId: "v1" },
										title: "Video 1",
										publishedAt: "2026-01-01T00:00:00Z",
									},
								},
							],
						}),
					);
				}
				return new Response(
					JSON.stringify({
						items: [
							{
								snippet: {
									resourceId: { videoId: "v2" },
									title: "Video 2",
									publishedAt: "2026-02-01T00:00:00Z",
								},
							},
						],
					}),
				);
			}
			if (urlStr.includes("/videos")) {
				return new Response(
					JSON.stringify({
						items: [
							{ id: "v1", contentDetails: { caption: "true" } },
							{ id: "v2", contentDetails: { caption: "true" } },
						],
					}),
				);
			}
			return new Response("Not found", { status: 404 });
		};

		const program = Effect.gen(function* () {
			const scraper = yield* YouTubeScraper;
			return yield* scraper.listPlaylistVideos("PLpaginated");
		}).pipe(
			Effect.provide(
				YouTubeScraperLive({
					apiKey: "test-key",
					fetchFn: paginatedFetch,
				}),
			),
		);

		const videos = await Effect.runPromise(program);
		expect(videos).toHaveLength(2);
		expect(callCount).toBe(2); // two pages fetched
	});

	it("maps YouTube API errors to NetworkError", async () => {
		const errorFetch = async () =>
			new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
				status: 403,
			});

		const program = Effect.gen(function* () {
			const scraper = yield* YouTubeScraper;
			return yield* scraper.listPlaylistVideos("PLtest");
		}).pipe(
			Effect.provide(
				YouTubeScraperLive({ apiKey: "test-key", fetchFn: errorFetch }),
			),
		);

		const result = await Effect.runPromiseExit(program);
		expect(result._tag).toBe("Failure");
	});
});
