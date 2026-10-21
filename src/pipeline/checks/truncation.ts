import type { CodeCheck } from "./types.ts";

/** How much of the prose's end a failure quotes. */
const EVIDENCE_LENGTH = 80;

/**
 * A sentence end, optionally closed by quotation marks, at the very end of
 * the text.
 */
const ENDS_AT_SENTENCE_END = /[.!?]["'”’]*$/;

/**
 * TRUNC: the prose ends at a sentence end. A model that stops early can
 * still report a normal finish, so the text itself is read.
 */
export const truncationCheck: CodeCheck = {
	owns: ["TRUNC"],
	run: (draft) => {
		const prose = draft.prose.trimEnd();
		return {
			TRUNC: ENDS_AT_SENTENCE_END.test(prose)
				? { outcome: "pass" }
				: { outcome: "fail", evidence: prose.slice(-EVIDENCE_LENGTH) },
		};
	},
};
