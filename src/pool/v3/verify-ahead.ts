// Proof verification ahead of a trail's replay (storage decision M5b.6). A
// proof's verdict depends on its kind, public inputs and bytes alone, so a
// reader whose verifier runs off its thread (`ProofCheck.parallel`) starts the
// proofs of the next records while it judges and applies the current one. A
// started verdict is handed only to a judgment asking for exactly the bytes it
// verified, when that judgment reaches its proof check (state.ts). So the order
// of checks, the first failing one and a verifier's throw, surfaced at the
// record whose proof threw, are those of a replay that asks for each proof in
// turn. A verification started for a record the replay never reaches (it
// refused earlier) is dropped with its outcome, which is the only difference:
// such a verifier may be asked up to the window more than a replay needed.
import { compareBytes } from "../../bytes.js";
import { decodeRecord } from "./records.js";
import type { Adopted, ProofCheck } from "./state.js";

/** Records started ahead per verification the verifier runs at once: one running and one waiting on each. */
const PER_LANE = 2;
/** The widest window, whatever a verifier declares. */
const MAX_WINDOW = 128;

interface Started { readonly kind: number; readonly inputs: readonly bigint[]; readonly proof: Uint8Array; readonly verdict: Promise<unknown> }

/** A verifier's declared parallelism read once, for a caller binding the verifier it was given; undefined where none is declared. */
export function declaredParallel(verifier: ProofCheck): number | undefined {
  const parallel: unknown = verifier.parallel;
  if (parallel === undefined) return undefined;
  if (typeof parallel !== "number" || !Number.isSafeInteger(parallel) || parallel < 1) throw new TypeError("a verifier's parallelism is a positive integer");
  return parallel;
}

/**
 * The replay's records from `position` with their proofs started ahead, and the
 * verifier its judgments ask. Positions of the adopted block and kinds without
 * a proof check (a withdrawal, which carries none, and a request, which fails
 * as KIND) start nothing; a record that does not decode starts nothing and
 * fails in its judgment as before.
 */
export function verifyAhead(verifier: ProofCheck, records: Iterable<Uint8Array>, position: bigint, block: readonly Adopted[]):
  { readonly verifier: ProofCheck; readonly records: Iterable<Uint8Array> } {
  const parallel = declaredParallel(verifier);
  if (parallel === undefined) return { verifier, records };
  const window = Math.min(parallel * PER_LANE, MAX_WINDOW);
  const started: Started[] = [];
  const start = (bytes: Uint8Array, at: bigint): void => {
    if (block[Number(at)] !== undefined) return;
    let record;
    try { record = decodeRecord(bytes); } catch { return; }
    if (![1, 2, 3, 4, 6].includes(record.kind)) return;
    const inputs = [...record.publicInputs], proof = new Uint8Array(record.proof);
    let verdict: Promise<unknown>;
    // A verifier that throws at the call is surfaced as its judgment would see it: at that record's proof check.
    try { verdict = Promise.resolve(verifier.verify(record.kind, [...inputs], new Uint8Array(proof))); } catch (error) { verdict = Promise.reject(error); }
    // An outcome nobody asks for is dropped, never reported as unhandled.
    verdict.catch(() => {});
    started.push({ kind: record.kind, inputs, proof, verdict });
  };
  const matches = (entry: Started, kind: number, inputs: readonly bigint[], proof: Uint8Array): boolean =>
    entry.kind === kind && entry.inputs.length === inputs.length && entry.inputs.every((value, i) => value === inputs[i]) &&
    proof instanceof Uint8Array && compareBytes(entry.proof, proof) === 0;
  const ahead: ProofCheck = {
    verify(kind, inputs, proof) {
      const at = started.findIndex(entry => matches(entry, kind, inputs, proof));
      if (at < 0) return verifier.verify(kind, inputs, proof);
      // Entries before it belong to records this replay passed without their proof.
      const entry = started.splice(0, at + 1)[at]!;
      return entry.verdict as Promise<boolean>;
    },
    identities: verifier.identities,
    parallel,
  };
  function* ordered(): Generator<Uint8Array> {
    const source = records[Symbol.iterator](), queued: Uint8Array[] = [];
    let next = position, done = false;
    const fill = (): void => {
      while (!done && queued.length < window) {
        const step = source.next();
        if (step.done === true) { done = true; break; }
        start(step.value, next++);
        queued.push(step.value);
      }
    };
    try {
      for (fill(); queued.length > 0; fill()) yield queued.shift()!;
    } finally {
      source.return?.();
    }
  }
  return { verifier: ahead, records: ordered() };
}
