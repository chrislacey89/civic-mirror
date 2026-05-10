// Intentionally untyped: simulates a profile module that imports cleanly
// at runtime but ships a wrong-typed optional field. The loader should
// reject this rather than cast through to EvalProfile.
const bad = {
	promptVersion: "vbadtypes",
	systemPrompt: "Profile with a bad-typed optional field.",
	thinkingBudget: "huge",
};

export { bad };
