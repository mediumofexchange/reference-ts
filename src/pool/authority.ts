// C2.5, C2.10.1–2 and C2.10.9: derive a public scope from signed terms
// and the witnessed replacement record. Reuse the existing replacement
// election and signature frames; never derive authority from a proof's key.
// This is an immutable read of one venue view, not an admission capability.
// It does not establish canonical openings or checkpoint finality. Refresh
// it before acting on a later record; indices beyond this view are refused.
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking, verifyBackingSignature } from "../backing.js";
import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { successionAhead, type Succession } from "../replacement.js";
import { type Venue } from "../venue.js";
import { PoolError, type SignedBacking } from "./segment.js";
import { ScopeTree, type ScopeEntry } from "./scope.js";
import { scopeSchedule, type ScopeSchedule } from "./schedule.js";
import { configurationHash, copySegmentHeader, POOL_CONSTRUCTION, type PoolConfiguration, type SegmentHeader } from "./statement.js";

export interface PoolTerm {
  readonly backing: Uint8Array;
  readonly operator: Uint8Array;
  readonly link: Uint8Array;
  readonly from: bigint;
  /** The exclusive effective end, if a successor has been witnessed. */
  readonly until?: bigint;
}

export interface PoolSigningState {
  readonly unwitnessedSignedAt?: bigint;
  readonly resumedAt?: bigint;
}

function index(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n) throw new EncodingError("venue indices must be nonnegative bigints");
}

export class PoolAuthorityView {
  private readonly domain: Uint8Array;
  private readonly venueId: Uint8Array;
  private readonly at: bigint;
  private readonly delay: bigint;
  private readonly chains = new Map<string, readonly Succession[]>();
  private readonly names: readonly Uint8Array[];

  constructor(configuration: PoolConfiguration, venue: Venue, backings: readonly SignedBacking[]) {
    this.domain = configurationHash(configuration);
    this.venueId = copyBytes(venue.id);
    if (this.venueId.length !== 32) throw new EncodingError("venue identity must be 32 bytes");
    this.at = venue.witnessedIndex(); this.delay = venue.lag();
    index(this.at); index(this.delay);
    if (!Array.isArray(backings) || backings.length === 0 || backings.length > 2 ** 16) {
      throw new PoolError("BACKING", "a scope needs one through 2^16 signed backings");
    }
    const names: Uint8Array[] = [];
    for (const signed of backings) {
      const backing = makeBacking(signed.backing);
      if (!verifyBackingSignature(backing, signed.signature)) throw new PoolError("BACKING", "invalid backing signature");
      const e = backing.evidence;
      if (e.setting !== "pool" || e.construction !== POOL_CONSTRUCTION || compareBytes(e.configuration, this.domain) !== 0) {
        throw new PoolError("BACKING", "backing declares another construction or configuration");
      }
      // A production scope has a declared clock. The transparent profile's
      // undeclared-venue fallback is not C2.10.2's shared-pool authority.
      if (e.witnessing === undefined || compareBytes(e.witnessing.venue, this.venueId) !== 0) {
        throw new PoolError("BACKING", "every scope backing must declare this venue");
      }
      if (this.chains.has(backing.nameHex)) throw new PoolError("BACKING", "duplicate scope backing");
      const chain = successionAhead(backing, venue);
      this.chains.set(backing.nameHex, chain.map(t => ({ operator: copyBytes(t.operator), link: copyBytes(t.link), from: t.from })));
      names.push(copyBytes(backing.name));
    }
    // Venue reads are synchronous and its finalized prefix is append-only.
    // A view that changed clocks mid-read cannot be served as one snapshot.
    if (venue.witnessedIndex() !== this.at || venue.lag() !== this.delay || compareBytes(venue.id, this.venueId) !== 0) {
      throw new PoolError("SEGMENT", "venue view changed while reading scope authority");
    }
    this.names = names.sort(compareBytes);
  }

  get witnessedIndex(): bigint { return this.at; }
  get lag(): bigint { return this.delay; }

  /** Historical term identity from this record, including a distinct link
   * whenever the same operator key returns. Never predicts future authority. */
  term(backing: Uint8Array, at = this.at): PoolTerm | undefined {
    index(at);
    if (at > this.at) throw new EncodingError("index is beyond this witnessed view");
    const chain = this.chains.get(bytesToHex(backing));
    if (chain === undefined) return undefined;
    const i = chain.findLastIndex(t => t.from <= at);
    const term = chain[i]!;
    const until = chain[i + 1]?.from;
    return Object.freeze({ backing: copyBytes(backing), operator: copyBytes(term.operator), link: copyBytes(term.link), from: term.from,
      ...(until === undefined ? {} : { until }) });
  }

  /** The entire supplied scope in canonical name order, only if this operator
   * currently holds every backing. Choosing a subset requires another view. */
  scope(operator: Uint8Array): readonly ScopeEntry[] | undefined {
    const entries: ScopeEntry[] = [];
    for (const name of this.names) {
      const term = this.term(name)!;
      if (compareBytes(term.operator, operator) !== 0) return undefined;
      entries.push({ backing: copyBytes(name), link: copyBytes(term.link) });
    }
    return new ScopeTree(entries).entries();
  }

  /** Checks the header's claimed authority at a witnessed index. This does
   * not authenticate the header or prove its openings canonical or final. */
  authorizes(header: SegmentHeader, at = this.at): boolean {
    try {
      index(at);
      if (at > this.at) return false;
      const h = copySegmentHeader(header);
      if (compareBytes(h.domain, this.domain) !== 0 || compareBytes(h.venue, this.venueId) !== 0 || h.entries.length !== this.names.length) return false;
      return h.entries.every((entry, i) => {
        if (compareBytes(entry.backing, this.names[i]!) !== 0) return false;
        const term = this.term(entry.backing, at)!;
        return compareBytes(term.link, entry.link) === 0 && compareBytes(term.operator, h.operator) === 0;
      });
    } catch (cause) {
      if (cause instanceof EncodingError || cause instanceof TypeError) return false;
      throw cause;
    }
  }

  /** Combine record-derived term ends with operator-wide durable signing
   * state. Undefined means the header has no authority in this view; it is
   * never permission to discard a tail. No receipt is issued by this method. */
  schedule(header: SegmentHeader, signing: PoolSigningState = {}): ScopeSchedule | undefined {
    if (!this.authorizes(header)) return undefined;
    const boundaries = this.names.flatMap(name => {
      const until = this.term(name)!.until;
      return until === undefined ? [] : [until];
    });
    return scopeSchedule({
      now: this.at, lag: this.delay, boundaries,
      ...(signing.unwitnessedSignedAt === undefined ? {} : { unwitnessedSignedAt: signing.unwitnessedSignedAt }),
      ...(signing.resumedAt === undefined ? {} : { resumedAt: signing.resumedAt }),
    });
  }
}
