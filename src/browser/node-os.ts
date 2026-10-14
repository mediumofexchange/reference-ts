// node:os in a browser engine (slice 41), for the browser bundle: the processors a backend may use (backend.ts starts
// the check set's backend with this many threads), as the browser reports them.
declare const navigator: { readonly hardwareConcurrency?: number } | undefined;

export function availableParallelism(): number {
  const count = typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 1;
}

export default { availableParallelism };
