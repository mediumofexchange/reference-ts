// Proof verification ahead of a trail's replay (storage decision M5b.6). A
// proof's verdict depends on its kind, public inputs and bytes alone, so a
// reader whose verifier runs off its thread (`ProofCheck.parallel`) starts the
// proofs of the next records while it judges and applies the current one. A
// started verdict is handed only to a judgment asking for exactly the bytes it
// verified, when that judgment reaches its proof check (state.ts). So the order
// of checks, the first failing one and a verifier's throw, surfaced at the
// record whose proof threw, are those of a replay that asks for each proof in
// turn; so is a failure reading the trail, raised when its record is due.
//
// The only difference is work: a verification started for a record the replay
// never reaches (it refused earlier) is dropped with its outcome. A replay
// starts ahead only as many proofs as it has already seen verify, so what it
// drops is never more than what it used, and the verifier one read binds never
// holds more than the window of started verifications, however many of the
// read's replays abandoned theirs.
import { compareBytes } from "../../bytes.js";
import { decodeRecord } from "./records.js";
import type { Adopted, ProofCheck } from "./state.js";

/** Records started ahead per verification the verifier runs at once: one running and one waiting on each. */
const PER_LANE = 2;
/** The widest window, whatever a verifier declares. */
const MAX_WINDOW = 128;

interface Started { readonly kind: number; readonly inputs: readonly bigint[]; readonly proof: Uint8Array; readonly verdict: Promise<unknown> }
interface Queued { readonly bytes: Uint8Array; readonly at: bigint; started: boolean }

/** Started verifications not yet settled, per verifier object (one read's binding), across every replay that started them. */
const unsettled = new WeakMap<ProofCheck, { count: number }>();

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
  let shared = unsettled.get(verifier);
  if (shared === undefined) { shared = { count: 0 }; unsettled.set(verifier, shared); }
  const held = shared;
  // Proofs this replay's judgments were handed as valid: the most it may have started and not yet asked for.
  let earned = 0;
  const started: Started[] = [];
  const seen = (verdict: unknown): unknown => { if (verdict === true) earned++; return verdict; };
  const start = (entry: Queued): boolean => {
    entry.started = true;
    if (block[Number(entry.at)] !== undefined) return false;
    let record;
    try { record = decodeRecord(entry.bytes); } catch { return false; }
    if (![1, 2, 3, 4, 6].includes(record.kind)) return false;
    const inputs = [...record.publicInputs], proof = new Uint8Array(record.proof);
    let verdict: Promise<unknown>;
    // A verifier that throws at the call is surfaced as its judgment would see it: at that record's proof check.
    try { verdict = Promise.resolve(verifier.verify(record.kind, [...inputs], new Uint8Array(proof))); } catch (error) { verdict = Promise.reject(error); }
    held.count++;
    const release = (): void => { held.count--; };
    // An outcome nobody asks for is dropped, never reported as unhandled.
    void verdict.then(release, release);
    started.push({ kind: record.kind, inputs, proof, verdict });
    return true;
  };
  const matches = (entry: Started, kind: number, inputs: readonly bigint[], proof: Uint8Array): boolean =>
    entry.kind === kind && entry.inputs.length === inputs.length && entry.inputs.every((value, i) => value === inputs[i]) &&
    proof instanceof Uint8Array && compareBytes(entry.proof, proof) === 0;
  const ahead: ProofCheck = {
    verify(kind, inputs, proof) {
      const at = started.findIndex(entry => matches(entry, kind, inputs, proof));
      if (at < 0) {
        const verdict: unknown = verifier.verify(kind, inputs, proof);
        const thenable = verdict !== null && (typeof verdict === "object" || typeof verdict === "function") &&
          typeof (verdict as { then?: unknown }).then === "function";
        return thenable ? Promise.resolve(verdict).then(seen) as Promise<boolean> : seen(verdict) as boolean;
      }
      // Entries before it belong to records this replay passed without their proof.
      const entry = started.splice(0, at + 1)[at]!;
      return entry.verdict.then(seen) as Promise<boolean>;
    },
    parallel,
  };
  function* ordered(): Generator<Uint8Array> {
    const source = records[Symbol.iterator](), queued: Queued[] = [];
    let next = position, done = false, failure: { readonly error: unknown } | undefined;
    const fill = (): void => {
      while (!done && queued.length < window) {
        let step: IteratorResult<Uint8Array>;
        // A failure reading ahead is raised when its record is due, after every record before it.
        try { step = source.next(); } catch (error) { failure = { error }; done = true; break; }
        if (step.done === true) { done = true; break; }
        queued.push({ bytes: step.value, at: next++, started: false });
      }
      for (const entry of queued) {
        if (entry.started) continue;
        if (started.length >= Math.min(window, earned) || held.count >= window) break;
        start(entry);
      }
    };
    try {
      for (fill(); queued.length > 0; fill()) yield queued.shift()!.bytes;
      if (failure !== undefined) throw failure.error;
    } finally {
      source.return?.();
    }
  }
  return { verifier: ahead, records: ordered() };
}
