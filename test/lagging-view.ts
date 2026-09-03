import type { Commitment } from "../src/commitment.js";
import type { PublishedOp } from "../src/oplog.js";
import type { Commit } from "../src/presentation.js";
import type { Replacement, WitnessedReplacement } from "../src/replacement.js";
import type { Revocation, WitnessedRevocation } from "../src/revocation.js";
import type { LocalVenue, Venue, WitnessedCommit, WitnessedOp } from "../src/venue.js";

/**
 * A venue VIEW with a finality depth, over a `LocalVenue` standing in for the
 * chain — `ErgoVenue`'s two read properties and nothing else:
 *
 *   - the clock a reader gets is the chain's height less the depth
 *     (`ErgoVenue.sync`: "the height is the indexed height less the declared
 *     depth");
 *   - a record is read only once its witnessed index is at or below that
 *     clock (`finalised`: nothing above the height is read at all), and its
 *     `at` is the index the chain witnessed it at.
 *
 * Writes land at the chain's real height, `depth` ahead of this clock — which
 * is the view's **lag**: an act signed at clock `c` is witnessed at `c + depth`.
 * (`ErgoVenue`'s own lag is one more, since a chain includes in its NEXT
 * block; this double lands in the current one, as `LocalVenue` does.) Each
 * party holds its own view, as each holds its own `ErgoVenue`, and so gets its
 * own memo of admitted replacement records. `ErgoVenue` itself refuses to
 * publish, so a `Sequencer` cannot be driven over it; this is how the tests
 * drive one over a lagging clock.
 *
 * The clock must have reached the depth before anything is published, or an
 * act lands nearer its clock than the lag says: fixtures advance the chain to
 * the depth first.
 */
export class LaggingView implements Venue {
  constructor(
    private readonly chain: LocalVenue,
    private readonly depth: bigint,
  ) {}

  get id(): Uint8Array {
    return this.chain.id;
  }

  lag(): bigint {
    return this.depth;
  }

  witnessedIndex(): bigint {
    const height = this.chain.witnessedIndex();
    return height > this.depth ? height - this.depth : 0n;
  }

  publish(commitment: Commitment): void {
    this.chain.publish(commitment);
  }
  publishOp(backingName: Uint8Array, op: PublishedOp): void {
    this.chain.publishOp(backingName, op);
  }
  publishReplacement(backingName: Uint8Array, replacement: Replacement): void {
    this.chain.publishReplacement(backingName, replacement);
  }
  publishRevocation(revocation: Revocation): void {
    this.chain.publishRevocation(revocation);
  }
  publishCommit(commit: Commit): void {
    this.chain.publishCommit(commit);
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
    // From the chain, as an operator derives its own next sequence from the
    // record it holds: a commitment inside the unfinalised zone is one it
    // published itself and has not yet seen confirmed.
    return this.chain.nextSequenceFor(operator);
  }
}

/** Move the chain to height `to` — the view's clock then reads `to − depth`. */
export function chainAt(chain: LocalVenue, to: bigint): void {
  const now = chain.witnessedIndex();
  if (to > now) chain.advance(to - now);
}
