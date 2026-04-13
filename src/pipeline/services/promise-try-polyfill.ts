// pdfjs-dist 5.6 (bundled inside unpdf 1.6) calls `Promise.try`, which landed
// in V8 13.2 and shipped in Node 23. Node 22 LTS — which is the runtime for
// this project's CLI and GitHub Actions workflow — does not have it, so
// `getDocumentProxy` and `renderPageAsImage` throw `TypeError: Promise.try is
// not a function` on the first call.
//
// This module polyfills `Promise.try` if it's missing. Importing it for its
// side effect is enough; order matters only insofar as it must run before
// any unpdf / pdfjs code path executes. Every module that imports unpdf in
// this project imports this polyfill first.
//
// Removal: once Node 23+ is the minimum supported runtime, delete this file
// and the imports referencing it.

type PromiseTryFn = <T, A extends readonly unknown[]>(
	fn: (...args: A) => T | PromiseLike<T>,
	...args: A
) => Promise<Awaited<T>>;

const PromiseCtor = Promise as PromiseConstructor & { try?: PromiseTryFn };

if (typeof PromiseCtor.try !== "function") {
	PromiseCtor.try = <T, A extends readonly unknown[]>(
		fn: (...args: A) => T | PromiseLike<T>,
		...args: A
	): Promise<Awaited<T>> =>
		new Promise<Awaited<T>>((resolve) => {
			resolve(fn(...args) as Awaited<T> | PromiseLike<Awaited<T>>);
		});
}
