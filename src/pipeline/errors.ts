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

export class NetworkError extends Data.TaggedError("NetworkError")<{
	readonly url: string;
	readonly statusCode?: number;
	readonly message: string;
}> {}

export class ParseError extends Data.TaggedError("ParseError")<{
	readonly source: string;
	readonly message: string;
}> {}

export class TranscriptionError extends Data.TaggedError("TranscriptionError")<{
	readonly videoId?: string;
	readonly message: string;
}> {}

export class LlmError extends Data.TaggedError("LlmError")<{
	readonly model: string;
	readonly message: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
	readonly operation: string;
	readonly message: string;
}> {}
