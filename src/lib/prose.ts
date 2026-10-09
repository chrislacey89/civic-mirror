/** The first sentence of a summary's prose, or all of it when nothing ends a sentence. */
export function firstSentence(prose: string): string {
	const match = prose.split(/(?<=[.!?])\s/)[0];
	return match ?? prose;
}
