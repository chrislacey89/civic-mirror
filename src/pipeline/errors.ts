import { Data } from "effect";

/**
 * Effect-style tagged errors for the pipeline.
 * Each error carries a _tag for pattern matching and a message for diagnostics.
 *
 * Effect teaching note: Data.TaggedError creates a class that extends Data.Error
 * with a discriminant `_tag` field. This lets Effect's type system track which
 * errors each Effect can produce, and lets you pattern match on `_tag` in
 * Effect.catchTag() handlers.
 */

/** Failure to fetch a remote resource (eGov page, PDF download, YouTube API). */
export class NetworkError extends Data.TaggedError("NetworkError")<{
	readonly url: string;
	readonly statusCode?: number;
	readonly message: string;
}> {}

/** HTML/PDF/text could not be parsed into the expected structure. */
export class ParseError extends Data.TaggedError("ParseError")<{
	readonly source: string;
	readonly message: string;
}> {}

/** YouTube caption fetch or Whisper speech-to-text failed. */
export class TranscriptionError extends Data.TaggedError("TranscriptionError")<{
	readonly videoId?: string;
	readonly message: string;
}> {}

/** LLM API call failed or returned unparseable output. */
export class LlmError extends Data.TaggedError("LlmError")<{
	readonly model: string;
	readonly message: string;
}> {}

/** Database read/write failure — wraps Drizzle/SQLite exceptions. */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
	readonly operation: string;
	readonly message: string;
}> {}
