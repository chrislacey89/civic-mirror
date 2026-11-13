/**
 * SPIKE (#195) — throwaway. Reads the run files and prints the calibration
 * report: per candidate × gate check, catch rate, false-refusal rate,
 * Youden's J and self-agreement, split by documents vs transcript-only,
 * against three truths kept apart:
 *
 *   corpus — labels by construction (the hand-built edits)
 *   hand   — your blind verdicts on the 10-meeting live subset
 *   sonnet — the Sonnet scorer's verdicts on all 36 live drafts (agreement only)
 *
 * The bars are judged on corpus ∪ hand, and both runs must clear them.
 * `--probe` runs only the shallow-feature probe on the corpus.
 *
 *   pnpm tsx src/pipeline/scripts/evals/calibration/report.spike.ts [--probe] [--md]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JUDGED, type Judged } from "./judge.spike.ts";
import { applyEdit, type CorpusEdit, loadCached } from "./run.spike.ts";

const ROOT = ".context/calibration";
const CORPUS = "src/pipeline/checks/__fixtures__/calibration/corpus.json";
const SONNET =
	"/Users/christopherlacey/conductor/workspaces/civic-mirror/biarritz-v3/.context/score/results";
const BARS = { catch: 0.9, falseRefusal: 0.1, selfAgreement: 0.9 };

type V = "pass" | "fail";
type Truth = Map<string, Partial<Record<Judged, V>>>;

const corpus: CorpusEdit[] = JSON.parse(readFileSync(CORPUS, "utf8"));
const index: { key: string; hasDocuments: boolean }[] = JSON.parse(
	readFileSync(join(ROOT, "inputs", "_index.json"), "utf8"),
);
const docsOf = new Map(index.map((r) => [r.key, r.hasDocuments]));
const keyOf = (itemId: string) =>
	itemId.startsWith("live:")
		? itemId.slice(5)
		: (corpus.find((e) => `corpus:${e.id}` === itemId)?.baseKey ?? "");

function truths(): Record<"corpus" | "hand" | "sonnet", Truth> {
	const c: Truth = new Map(corpus.map((e) => [`corpus:${e.id}`, e.labels]));
	const s: Truth = new Map();
	for (const f of readdirSync(SONNET)) {
		const r = JSON.parse(readFileSync(join(SONNET, f), "utf8"));
		s.set(
			`live:${r.key}`,
			Object.fromEntries(
				JUDGED.map((k) => [k, r.gates[k].pass ? "pass" : "fail"]),
			),
		);
	}
	const h: Truth = new Map();
	const hf = join(ROOT, "labels", "hand.json");
	if (existsSync(hf)) {
		const raw: Record<string, { verdict?: V }> = JSON.parse(
			readFileSync(hf, "utf8"),
		);
		for (const [name, { verdict }] of Object.entries(raw)) {
			const [key, check] = name.split("|");
			if (!verdict || !key || !check) continue;
			const row = h.get(`live:${key}`) ?? {};
			row[check as Judged] = verdict;
			h.set(`live:${key}`, row);
		}
	}
	return { corpus: c, hand: h, sonnet: s };
}

type Calls = Map<string, Partial<Record<Judged, V>> | null>;
function runs(): Map<string, Calls[]> {
	const byModel = new Map<string, Calls[]>();
	const dir = join(ROOT, "runs");
	for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
		const m = /^(.+)\.run(\d)\.jsonl$/.exec(f);
		if (!m?.[1]) continue;
		const calls: Calls = new Map();
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (!line) continue;
			const r = JSON.parse(line);
			const prior = calls.get(r.itemId);
			if (prior) continue; // first successful call wins
			calls.set(
				r.itemId,
				r.output
					? Object.fromEntries(JUDGED.map((k) => [k, r.output[k].verdict]))
					: null,
			);
		}
		const list = byModel.get(m[1]) ?? [];
		list[Number(m[2]) - 1] = calls;
		byModel.set(m[1], list);
	}
	return byModel;
}

interface Rates {
	n: number;
	fails: number;
	catch: number;
	falseRefusal: number;
	j: number;
	missing: number;
}
function rates(
	calls: Calls,
	truth: Truth,
	check: Judged,
	keep: (id: string) => boolean,
): Rates {
	let tp = 0,
		fn = 0,
		fp = 0,
		tn = 0,
		missing = 0;
	for (const [id, labels] of truth) {
		const t = labels[check];
		if (!t || !keep(id)) continue;
		const got = calls.get(id);
		if (!got?.[check]) {
			missing++;
			continue;
		}
		if (t === "fail") got[check] === "fail" ? tp++ : fn++;
		else got[check] === "fail" ? fp++ : tn++;
	}
	const c = tp + fn ? tp / (tp + fn) : Number.NaN;
	const f = fp + tn ? fp / (fp + tn) : Number.NaN;
	return {
		n: tp + fn + fp + tn,
		fails: tp + fn,
		catch: c,
		falseRefusal: f,
		j: c - f,
		missing,
	};
}

function selfAgreement(
	a: Calls,
	b: Calls,
	ids: string[],
	check: Judged,
): number {
	let same = 0,
		n = 0;
	for (const id of ids) {
		const x = a.get(id)?.[check],
			y = b.get(id)?.[check];
		if (!x || !y) continue;
		n++;
		if (x === y) same++;
	}
	return n ? same / n : Number.NaN;
}

const pct = (x: number) => (Number.isNaN(x) ? "  — " : x.toFixed(2));

/** Shallow features of a corpus draft that must not predict its label. */
function features(e: CorpusEdit): Record<string, number> {
	const base = loadCached(e.baseKey).snapshot;
	const d = applyEdit(base, e);
	const text = [...d.highlights, d.prose].join(" ");
	const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
	return {
		chars: text.length,
		words: count(text, /\S+/g),
		editDelta: e.after.length - e.before.length,
		editChars: e.after.length,
		editWords: count(e.after, /\S+/g),
		editDigits: count(e.after, /\d/g),
		editCaps: count(e.after, /\b[A-Z][a-z]+/g),
		editCapsDelta:
			count(e.after, /\b[A-Z][a-z]+/g) - count(e.before, /\b[A-Z][a-z]+/g),
		editCommas: count(e.after, /,/g),
		editQuotes: count(e.after, /["“”']/g),
		inHighlights: e.target.field === "highlights" ? 1 : 0,
	};
}

/** Best Youden's J any single threshold on `xs` reaches for `ys` (either direction). */
function bestJ(xs: number[], ys: boolean[]): number {
	const pos = ys.filter(Boolean).length,
		neg = ys.length - pos;
	let best = 0;
	for (const t of new Set(xs)) {
		let tp = 0,
			fp = 0;
		xs.forEach((x, i) => {
			if (x >= t) ys[i] ? tp++ : fp++;
		});
		best = Math.max(best, Math.abs(tp / pos - fp / neg));
	}
	return best;
}

function probe(): boolean {
	const PROBE_MAX_J = 0.4;
	const rows = corpus.map((e) => ({ e, f: features(e) }));
	let ok = true;
	console.log(
		`\nShallow-feature probe (best single-threshold J; must be ≤ ${PROBE_MAX_J})`,
	);
	for (const check of JUDGED) {
		const set = rows.filter((r) => r.e.check === check);
		const ys = set.map((r) => r.e.labels[check] === "fail");
		const line = Object.keys(set[0]?.f ?? {}).map((name) => {
			const j = bestJ(
				set.map((r) => r.f[name] ?? 0),
				ys,
			);
			if (j > PROBE_MAX_J) ok = false;
			return `${name} ${j.toFixed(2)}${j > PROBE_MAX_J ? "✗" : ""}`;
		});
		console.log(`  ${check} (n=${set.length}): ${line.join(" · ")}`);
	}
	console.log(`  probe: ${ok ? "PASS" : "FAIL"}`);
	return ok;
}

function main() {
	const probeOk = probe();
	if (process.argv.includes("--probe")) return;
	const t = truths();
	const bar: Truth = new Map([...t.corpus, ...t.hand]);
	const isDocs = (id: string) => docsOf.get(keyOf(id)) === true;
	const splits = {
		all: () => true,
		docs: isDocs,
		transcript: (id: string) => !isDocs(id),
	};

	console.log(
		`\nHand labels: ${t.hand.size} meetings. Bars: catch ≥ ${BARS.catch}, false refusal ≤ ${BARS.falseRefusal}, self-agreement ≥ ${BARS.selfAgreement}; both runs.`,
	);
	for (const [model, [r1, r2]] of runs()) {
		console.log(`\n## ${model}`);
		if (!r1 || !r2) {
			console.log("  (needs both runs)");
			continue;
		}
		const errs = [r1, r2].map(
			(r) => [...r.values()].filter((v) => v === null).length,
		);
		console.log(`  unusable outputs: run1 ${errs[0]}, run2 ${errs[1]}`);
		console.log(
			"  check split       truth  n  fails | catch r1/r2 | f.ref r1/r2 |  J r1/r2   | self | bars",
		);
		for (const check of JUDGED) {
			for (const [name, keep] of Object.entries(splits)) {
				for (const [tname, truth] of [
					["corpus+hand", bar],
					["sonnet", t.sonnet],
				] as const) {
					const a = rates(r1, truth, check, keep),
						b = rates(r2, truth, check, keep);
					if (a.n === 0) continue;
					const ids = [...truth.keys()].filter(keep);
					const sa = selfAgreement(r1, r2, ids, check);
					const clears =
						tname === "corpus+hand" &&
						[a, b].every(
							(r) =>
								r.catch >= BARS.catch && r.falseRefusal <= BARS.falseRefusal,
						) &&
						sa >= BARS.selfAgreement;
					const barCol =
						tname === "sonnet" ? "(agreement)" : clears ? "CLEARS" : "misses";
					console.log(
						`  ${check}  ${name.padEnd(10)} ${tname.padEnd(11)} ${String(a.n).padStart(3)} ${String(a.fails).padStart(3)} | ${pct(a.catch)}/${pct(b.catch)} | ${pct(a.falseRefusal)}/${pct(b.falseRefusal)} | ${pct(a.j)}/${pct(b.j)} | ${pct(sa)} | ${barCol}`,
					);
				}
			}
		}
	}
	if (!probeOk)
		console.log(
			"\n⚠ probe failed: the corpus labels are separable by a shallow feature; rates on it are not evidence.",
		);
}

main();
