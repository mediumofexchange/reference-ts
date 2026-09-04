import { compareBytes } from "../src/bytes.js";
import type { Commitment } from "../src/commitment.js";
import type { PublishedOp } from "../src/oplog.js";
import type { Commit } from "../src/presentation.js";
import type { Replacement, WitnessedReplacement } from "../src/replacement.js";
import type { Revocation, WitnessedRevocation } from "../src/revocation.js";
import type { LocalVenue, Venue, WitnessedCommit, WitnessedOp } from "../src/venue.js";

/** Writes submitted through a view, waiting for the chain's next block. */
const pending = new WeakMap<LocalVenue, (() => void)[]>();

/**
 * A venue VIEW with a finality depth, over a `LocalVenue` standing in for the
 * chain — `ErgoVenue`'s read and write properties and nothing else:
 *
 *   - the clock a reader gets is the chain's height less the depth
 *     (`ErgoVenue.sync`: "the height is the indexed height less the declared
 *     depth");
 *   - a record is read only once its witnessed index is at or below that
 *     clock (`finalised`: nothing above the height is read at all), and its
 *     `at` is the index the chain witnessed it at;
 *   - a write is included in the chain's NEXT block: queued here, landed by
 *     `chainAt` after each advance.
 *
 * So an act signed at clock `c` is witnessed at `c + depth + 1`, and the
 * view's lag is `depth + 1` — `ErgoVenue.lag()`'s own number. (The slice-38
 * review's security angle found the first version of this double landing
 * writes in the current block, one less than the venue it models, and the
 * slice's decisive test passing at a lead below a real venue's floor.) Each
 * party holds its own view, as each holds its own `ErgoVenue`, and so gets
 * its own memo of admitted replacement records. `ErgoVenue` itself refuses to
 * publish, so a `Sequencer` cannot be driven over it; this is how the tests
 * drive one over a lagging clock.
 *
 * `nextSequenceFor` is the one method that is NOT `ErgoVenue`'s: it counts
 * this view's own in-flight commitments, where `ErgoVenue` answers from the
 * finalised height alone and would sign two roots at one sequence once a
 * write side exists (the slice-38 verification's V7; the Ergo write-side
 * slice's to settle). Its `id` is the chain's, too — which is how one chain
 * answers two lags in the two-views test, and exactly the divergence the
 * Venue contract's lag bullet forbids of a real view.
 *
 * The chain must have reached the depth before anything is published, or an
 * act lands nearer its clock than the lag says: fixtures advance the chain to
 * the depth first. Records a fixture publishes on the CHAIN directly (the
 * rule-holder's, typically) land at once, at the chain's height.
 */
export class LaggingView implements Venue {
  /** Commitments this view has submitted, whether or not landed yet. */
  private readonly submitted: Commitment[] = [];

  constructor(
    private readonly chain: LocalVenue,
    private readonly depth: bigint,
  ) {}

  get id(): Uint8Array {
    return this.chain.id;
  }

  lag(): bigint {
    return this.depth + 1n;
  }

  witnessedIndex(): bigint {
    const height = this.chain.witnessedIndex();
    return height > this.depth ? height - this.depth : 0n;
  }

  private queue(write: () => void): void {
    const q = pending.get(this.chain);
    if (q === undefined) pending.set(this.chain, [write]);
    else q.push(write);
  }
  publish(commitment: Commitment): void {
    this.submitted.push(commitment);
    this.queue(() => this.chain.publish(commitment));
  }
  publishOp(backingName: Uint8Array, op: PublishedOp): void {
    this.queue(() => this.chain.publishOp(backingName, op));
  }
  publishReplacement(backingName: Uint8Array, replacement: Replacement): void {
    this.queue(() => this.chain.publishReplacement(backingName, replacement));
  }
  publishRevocation(revocation: Revocation): void {
    this.queue(() => this.chain.publishRevocation(revocation));
  }
  publishCommit(commit: Commit): void {
    this.queue(() => this.chain.publishCommit(commit));
  }

  private final<T extends { readonly at: bigint }>(list: T[]): T[] {
    const now = this.witnessedIndex();
    return list.filter((w) => w.at <= now);
  }
  publishedOpsFor(backingName: Uint8Array): WitnessedOp[] {
    return this.final(this.chain.publishedOpsFor(backingName));
  }
  replacementsFor(backingName: Uint8Array): WitnessedReplacement[] {
    return this.final(this.chain.replacementsFor(backingName));
  }
  revocationsFor(obligor: Uint8Array): WitnessedRevocation[] {
    return this.final(this.chain.revocationsFor(obligor));
  }
  commitsFor(attemptId: Uint8Array): WitnessedCommit[] {
    return this.final(this.chain.commitsFor(attemptId));
  }

  private bound(asOf?: bigint): bigint {
    const now = this.witnessedIndex();
    return asOf === undefined || asOf > now ? now : asOf;
  }
  latestFor(operator: Uint8Array, asOf?: bigint): Commitment | undefined {
    return this.chain.latestFor(operator, this.bound(asOf));
  }
  witnessedAtFor(operator: Uint8Array, asOf?: bigint): bigint | undefined {
    return this.chain.witnessedAtFor(operator, this.bound(asOf));
  }
  firstCommitmentFor(operator: Uint8Array, notBefore?: bigint): bigint | undefined {
    const first = this.chain.firstCommitmentFor(operator, notBefore);
    return first === undefined || first > this.witnessedIndex() ? undefined : first;
  }
  nextSequenceFor(operator: Uint8Array): bigint {
    // The chain's word, and this view's own in-flight commitments beside it:
    // an operator knows what it has signed before the chain shows it.
    const latest = this.chain.latestFor(operator);
    let next = latest === undefined ? 0n : latest.sequence + 1n;
    for (const c of this.submitted) {
      if (compareBytes(c.operator, operator) === 0 && c.sequence >= next) next = c.sequence + 1n;
    }
    return next;
  }
}

/**
 * Move the chain to height `to`, one block at a time, landing after each
 * advance the writes queued before it — the view's clock then reads
 * `to − depth`.
 */
export function chainAt(chain: LocalVenue, to: bigint): void {
  while (chain.witnessedIndex() < to) {
    const queued = pending.get(chain) ?? [];
    pending.set(chain, []);
    chain.advance(1n);
    for (const write of queued) write();
  }
}
