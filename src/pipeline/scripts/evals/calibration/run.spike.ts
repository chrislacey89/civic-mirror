/**
 * SPIKE (#195) — throwaway. Runs each judge candidate over the calibration
 * items and appends one JSON line per call to
 * `.context/calibration/runs/<model>.run<n>.jsonl`. Re-running skips calls
 * already recorded, so an interrupted run resumes.
 *
 * Items: the 36 live drafts as the Sonnet scorer saw them (snapshot text),
 * and the corpus edits in `src/pipeline/checks/__fixtures__/calibration/`
 * applied to those same drafts. Reads only the cached inputs written by
 * `load-inputs.spike.ts`; it never touches the database.
 *
 *   pnpm tsx src/pipeline/scripts/evals/calibration/run.spike.ts --dry
 *   pnpm tsx src/pipeline/scripts/evals/calibration/run.spike.ts [--models a,b] [--runs 1,2] [--limit n]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { buildJudgePrompt, type Draft, judge } from "./judge.spike.ts";

config({ path: [".env.local", ".env"], quiet: true });

const ROOT = ".context/calibration";
const CORPUS = "src/pipeline/checks/__fixtures__/calibration/corpus.json";

interface Cached {
	key: string;
	hasDocuments: boolean;
	input: Parameters<typeof buildJudgePrompt>[0];
	ledger: Parameters<typeof buildJudgePrompt>[1];
	officials: Parameters<typeof buildJudgePrompt>[2];
	snapshot: Draft;
}

export interface CorpusEdit {
	id: string;
	baseKey: string;
	check: string;
	labels: Record<string, "pass" | "fail">;
	target:
		| { field: "highlights"; index: number }
		| { field: "prose"; sentence: string };
	before: string;
	after: string;
}

export interface Item {
	id: string;
	kind: "live" | "corpus";
	key: string;
	draft: Draft;
}

export function loadCached(key: string): Cached {
	return JSON.parse(readFileSync(join(ROOT, "inputs", `${key}.json`), "utf8"));
}

function once(haystack: string, needle: string, id: string): string {
	const at = haystack.indexOf(needle);
	if (at < 0 || haystack.indexOf(needle, at + 1) >= 0) {
		throw new Error(`${id}: "before" is not found exactly once`);
	}
	return haystack.slice(0, at);
}

export function applyEdit(draft: Draft, edit: CorpusEdit): Draft {
	if (edit.target.field === "highlights") {
		const i = edit.target.index;
		const h = draft.highlights[i];
		if (h === undefined) throw new Error(`${edit.id}: no highlight ${i}`);
		const head = once(h, edit.before, edit.id);
		const highlights = [...draft.highlights];
		highlights[i] =
			head + edit.after + h.slice(head.length + edit.before.length);
		return { ...draft, highlights };
	}
	const head = once(draft.prose, edit.before, edit.id);
	return {
		...draft,
		prose:
			head + edit.after + draft.prose.slice(head.length + edit.before.length),
	};
}

export function items(): Item[] {
	const keys: string[] = JSON.parse(
		readFileSync(join(ROOT, "inputs", "_index.json"), "utf8"),
	).map((r: { key: string }) => r.key);
	const live = keys.map((key) => ({
		id: `live:${key}`,
		kind: "live" as const,
		key,
		draft: loadCached(key).snapshot,
	}));
	const corpus: CorpusEdit[] = existsSync(CORPUS)
		? JSON.parse(readFileSync(CORPUS, "utf8"))
		: [];
	const edited = corpus.map((edit) => ({
		id: `corpus:${edit.id}`,
		kind: "corpus" as const,
		key: edit.baseKey,
		draft: applyEdit(loadCached(edit.baseKey).snapshot, edit),
	}));
	return [...live, ...edited];
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
	const all = items();
	const limit = Number(arg("limit") ?? all.length);
	const todo = all.slice(0, limit);
	if (process.argv.includes("--dry")) {
		const first = todo[0];
		if (first === undefined) return;
		const c = loadCached(first.key);
		const prompt = buildJudgePrompt(
			c.input,
			c.ledger,
			c.officials,
			first.draft,
		);
		console.log(prompt.slice(-2500));
		console.log(`\n${todo.length} items; first prompt ${prompt.length} chars`);
		return;
	}
	const models = (arg("models") ?? "gemini-2.5-pro,gemini-2.5-flash").split(
		",",
	);
	const runs = (arg("runs") ?? "1,2").split(",").map(Number);
	mkdirSync(join(ROOT, "runs"), { recursive: true });

	for (const model of models) {
		for (const run of runs) {
			const file = join(ROOT, "runs", `${model}.run${run}.jsonl`);
			const done = new Set(
				existsSync(file)
					? readFileSync(file, "utf8")
							.split("\n")
							.filter(Boolean)
							.map((l) => JSON.parse(l))
							.filter((r) => r.output !== null)
							.map((r) => r.itemId)
					: [],
			);
			const pending = todo.filter((it) => !done.has(it.id));
			console.log(`${model} run ${run}: ${pending.length} to go`);
			let next = 0;
			const worker = async () => {
				while (next < pending.length) {
					const item = pending[next++];
					if (item === undefined) return;
					const c = loadCached(item.key);
					const call = await judge(
						model,
						buildJudgePrompt(c.input, c.ledger, c.officials, item.draft),
					);
					appendFileSync(
						file,
						`${JSON.stringify({ itemId: item.id, model, run, at: new Date().toISOString(), ...call })}\n`,
					);
					const v = call.output
						? `${call.output.A2.verdict[0]}${call.output.A4.verdict[0]}${call.output.A5.verdict[0]}`
						: `ERR ${call.error?.slice(0, 80)}`;
					console.log(`  ${item.id} ${v} ${call.ms}ms`);
				}
			};
			await Promise.all(Array.from({ length: 4 }, worker));
		}
	}
}

if (process.argv[1]?.endsWith("run.spike.ts")) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
