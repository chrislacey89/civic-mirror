import { Context, Effect, Layer } from "effect";
import { NetworkError } from "#/pipeline/errors.ts";

/**
 * Effect teaching note: This service demonstrates how to wrap an external REST API
 * (YouTube Data API v3) in an Effect service. The key pattern is:
 * 1. Define types for the domain (YouTubeVideo)
 * 2. Define a service interface with Context.Tag
 * 3. Wrap HTTP calls in Effect.tryPromise at the boundary
 * 4. Inject a fetch function for testability
 */

type YouTubeVideo = {
	videoId: string;
	title: string;
	publishedAt: string;
	hasCaptions: boolean;
};

interface YouTubeScraperInterface {
	listPlaylistVideos(
		playlistId: string,
	): Effect.Effect<YouTubeVideo[], NetworkError>;
}

class YouTubeScraper extends Context.Tag("YouTubeScraper")<
	YouTubeScraper,
	YouTubeScraperInterface
>() {}

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

type YouTubeScraperConfig = {
	apiKey: string;
	fetchFn?: typeof globalThis.fetch;
};

function YouTubeScraperLive(config: YouTubeScraperConfig) {
	const fetchFn = config.fetchFn ?? globalThis.fetch;

	return Layer.succeed(YouTubeScraper, {
		listPlaylistVideos: (playlistId) =>
			Effect.gen(function* () {
				// Step 1: Fetch all video IDs from the playlist (paginated)
				const videoEntries = yield* fetchAllPlaylistItems(
					playlistId,
					config.apiKey,
					fetchFn,
				);

				if (videoEntries.length === 0) return [];

				// Step 2: Check caption availability in batches of 50
				const captionMap = yield* fetchCaptionAvailability(
					videoEntries.map((v) => v.videoId),
					config.apiKey,
					fetchFn,
				);

				// Step 3: Combine playlist data with caption info
				return videoEntries.map((entry) => ({
					...entry,
					hasCaptions: captionMap.get(entry.videoId) ?? false,
				}));
			}),
	});
}

/**
 * Fetches all items from a YouTube playlist, handling pagination.
 * YouTube API returns max 50 items per page with a nextPageToken.
 */
function fetchAllPlaylistItems(
	playlistId: string,
	apiKey: string,
	fetchFn: typeof globalThis.fetch,
): Effect.Effect<
	Array<{ videoId: string; title: string; publishedAt: string }>,
	NetworkError
> {
	return Effect.gen(function* () {
		const allItems: Array<{
			videoId: string;
			title: string;
			publishedAt: string;
		}> = [];
		let pageToken: string | undefined;

		do {
			const url = new URL(`${YOUTUBE_API_BASE}/playlistItems`);
			url.searchParams.set("part", "snippet");
			url.searchParams.set("playlistId", playlistId);
			url.searchParams.set("maxResults", "50");
			url.searchParams.set("key", apiKey);
			if (pageToken) url.searchParams.set("pageToken", pageToken);

			const data = yield* fetchJson(url.toString(), fetchFn);

			for (const item of data.items ?? []) {
				allItems.push({
					videoId: item.snippet.resourceId.videoId,
					title: item.snippet.title,
					publishedAt: item.snippet.publishedAt,
				});
			}

			pageToken = data.nextPageToken;
		} while (pageToken);

		return allItems;
	});
}

/**
 * Checks caption availability for a batch of video IDs using
 * the YouTube videos.list endpoint with contentDetails part.
 * Batches into groups of 50 (API limit).
 */
function fetchCaptionAvailability(
	videoIds: string[],
	apiKey: string,
	fetchFn: typeof globalThis.fetch,
): Effect.Effect<Map<string, boolean>, NetworkError> {
	return Effect.gen(function* () {
		const captionMap = new Map<string, boolean>();

		// Process in batches of 50
		for (let i = 0; i < videoIds.length; i += 50) {
			const batch = videoIds.slice(i, i + 50);
			const url = new URL(`${YOUTUBE_API_BASE}/videos`);
			url.searchParams.set("part", "contentDetails");
			url.searchParams.set("id", batch.join(","));
			url.searchParams.set("key", apiKey);

			const data = yield* fetchJson(url.toString(), fetchFn);

			for (const item of data.items ?? []) {
				captionMap.set(item.id, item.contentDetails?.caption === "true");
			}
		}

		return captionMap;
	});
}

// biome-ignore lint/suspicious/noExplicitAny: YouTube API response shape varies by endpoint
function fetchJson(
	url: string,
	fetchFn: typeof globalThis.fetch,
): Effect.Effect<any, NetworkError> {
	return Effect.tryPromise({
		try: async () => {
			const response = await fetchFn(url);
			if (!response.ok) {
				const body = await response.text();
				throw new Error(`YouTube API error ${response.status}: ${body}`);
			}
			return response.json();
		},
		catch: (error) =>
			new NetworkError({
				url,
				message: error instanceof Error ? error.message : String(error),
			}),
	});
}

export { YouTubeScraper, YouTubeScraperLive };
export type { YouTubeVideo, YouTubeScraperConfig };
