// C2.10.9c/11–13 and C2b.6.1: intrinsic authenticated exclusion, a clock
// at the last valid carrying snapshot, and continuation of the last valid prefix.
// Witnessed checkpoint/index pairs are immutable input. Each read replays the
// supplied evidence at the checkpoint's original prefix; no recorded verdict
// is authority. Evidence has explicit bytes and a hashed chain; cryptographic
// validity and checkpoint/receipt signatures remain ideal oracle relations.
// This is not a production fault-certificate format or v3 byte layout.
import { Refusal, type Checkpoint, type Departures, type Event, type Id, type Recorded, type Scope, type Service, type State, type Statement, type Receipt, type ReceiptClassification, type RepairClassification } from "./pool-authority.js";
import { RecoveryWorld, type RecoveryDepartures, type RecoveryState, type Count, type Publication, type Witnessed } from "./pool-recovery.js";
import { copyEvidence, evidenceChain, evidenceHashes } from "./pool-evidence.js";
import { EncodingError } from "../src/bytes.js";

export type Classification = "valid" | "excluded" | "unresolved" | "lapsed";
export interface FaultDepartures {
  readonly unresolvedIsExcluded?: boolean;
  readonly unresolvedIsValid?: boolean;
}
const AVAILABILITY = /^(unavailable|unresolved|unauthenticated)/;
function requireThat(ok: boolean, message: string): asserts ok { if (!ok) throw new Refusal(message); }
interface Evaluation { readonly results: Map<Id, Recorded>; readonly active: Set<Id> }
/** A snapshot of one reader's record and evidence. Retaining a facet means
 * retaining its authenticated bytes, never a cached finality verdict. */
export type FaultReader = Pick<FaultWorld, "classification" | "record" | "import" | "currentFor" | "predecessorFor" |
  "snapshot" | "closing" | "gapOpen" | "count" | "recoveryState" | "classify" | "classifyRepair" |
  "withheld" | "withheldDirectories" | "withheldScopes" | "shownScopes" | "supplyTrail">;

function copyStatement(s: Statement): Statement {
  return Object.freeze({ ...s, anchors: Object.freeze([...s.anchors]),
    nullifiers: Object.freeze([...s.nullifiers]), outputs: Object.freeze([...s.outputs]),
    ...(s.lit === undefined ? {} : { lit: Object.freeze({ ...s.lit,
      ...(s.lit.tags === undefined ? {} : { tags: Object.freeze([...s.lit.tags]) }),
      ...(s.lit.acceptance === undefined ? {} : { acceptance: Object.freeze({ ...s.lit.acceptance }) }),
    }) }),
  });
}

export class FaultWorld extends RecoveryWorld {
  private evaluation: Evaluation | undefined;
  private readonly shownTrails = new Map<Id, readonly Event[]>();
  constructor(lag = 1n, readonly faults: FaultDepartures = {},
    recovery: RecoveryDepartures = {}, departures: Departures = {}) {
    super(lag, recovery, departures);
  }
  reader(): FaultReader {
    const view = this.evaluationView(this.records, this.now);
    Object.assign(view, {
      withheld: new Set(this.withheld), withheldDirectories: new Set(this.withheldDirectories),
      withheldScopes: new Set(this.withheldScopes), shownScopes: new Map(this.shownScopes),
      shownTrails: new Map(this.shownTrails),
    });
    view.evaluation = undefined;
    return view;
  }
  /** A replica's supplied preimage is independent of the operator's signed
   * chain. Copy it on ingestion; absent evidence is never filled from an oracle. */
  supplyTrail(id: Id, events: readonly Event[]): void {
    this.shownTrails.set(id, Object.freeze(events.map(e => Object.freeze({ ...e,
      statement: copyStatement(e.statement), ...(e.evidence === undefined ? {} : { evidence: copyEvidence(e.evidence) }),
    }))));
  }
  override prepareEvent(event: Event): Event {
    const evidence = copyEvidence(event.evidence ?? this.oracle.evidence(event.statement));
    return Object.freeze({ ...event, statement: copyStatement(event.statement), evidence });
  }
  protected override signingEvents(service: Service): readonly Event[] {
    // Event identity is segment and position, not separately chosen metadata.
    return Object.freeze(service.events.map((e, i) => this.prepareEvent({ ...e, id: `${service.id}:${i}` })));
  }
  override publish(publication: Publication): Witnessed {
    if ("statement" in publication) {
      this.oracle.evidence(publication.statement);
      return super.publish(Object.freeze({ ...publication }));
    }
    if (publication.kind === "acceptance") {
      return super.publish(Object.freeze({ ...publication, acceptance: Object.freeze({ ...publication.acceptance }) }));
    }
    return super.publish(Object.freeze({ ...publication, nullifiers: Object.freeze([...publication.nullifiers]) }));
  }
  protected override checkpointBinding(segment: Id, events: readonly Event[]): Pick<Checkpoint, "evidenceHash"> {
    return { evidenceHash: evidenceChain(segment, events) };
  }
  override receiptBinding(event: Event): Pick<Receipt, "proofHash" | "signatureHash"> {
    requireThat(event.evidence !== undefined, "unresolved receipt evidence");
    return evidenceHashes(event.evidence);
  }
  protected override verifyEvent(event: Event, scope: Scope, state: State): boolean {
    requireThat(event.evidence !== undefined, "unresolved event evidence");
    return this.oracle.verifyEvidence(event.statement, event.evidence, scope, state.roots, this.departures);
  }
  protected override continuation(checkpoint: Checkpoint, previous: Checkpoint): void {
    super.continuation(checkpoint, previous);
    requireThat(evidenceChain(checkpoint.segment, checkpoint.events.slice(0, previous.events.length)) === previous.evidenceHash,
      "rewritten evidence prefix");
  }
  protected override receiptMatches(receipt: Receipt, prefix: readonly Event[]): boolean {
    const hashes = this.receiptBinding(prefix.at(-1)!);
    return super.receiptMatches(receipt, prefix) && receipt.proofHash === hashes.proofHash &&
      receipt.signatureHash === hashes.signatureHash;
  }
  protected query<T>(read: () => T): T {
    if (this.evaluation !== undefined) return read();
    this.evaluation = { results: new Map(), active: new Set() };
    try { return read(); } finally { this.evaluation = undefined; }
  }
  override currentFor(backing: Id, operator: Id): Id | null {
    return this.query(() => super.currentFor(backing, operator));
  }
  override predecessorFor(backing: Id, child: { readonly operator: Id; readonly sequence: bigint; readonly at: bigint }): Id | null {
    return this.query(() => super.predecessorFor(backing, child));
  }
  override classify(receipt: Receipt, scope: Scope): ReceiptClassification {
    this.receiptEvidence(receipt);
    return this.query(() => super.classify(receipt, scope));
  }
  override classifyRepair(receipt: Receipt, scope: Scope, boundary: Id): RepairClassification {
    this.receiptEvidence(receipt);
    return this.query(() => super.classifyRepair(receipt, scope, boundary));
  }
  private receiptEvidence(receipt: Receipt): void {
    requireThat(typeof receipt.proofHash === "string" && /^[0-9a-f]{64}$/.test(receipt.proofHash) &&
      typeof receipt.signatureHash === "string" && /^[0-9a-f]{64}$/.test(receipt.signatureHash), "unresolved receipt evidence");
  }
  override recoveryState(backing: Id, at: bigint): RecoveryState {
    return this.query(() => super.recoveryState(backing, at));
  }
  override count(backing: Id, at: bigint): Count {
    return this.query(() => super.count(backing, at));
  }
  /** The semantic observer has all ideal evidence, even when an ordinary
   * reader lacks it. Recompute instead of trusting initial include status. */
  protected override observedRecords(): readonly Recorded[] {
    const view = this.evaluationView(this.records, this.now);
    Object.assign(view, {
      withheld: new Set<Id>(), withheldDirectories: new Set<Id>(), withheldScopes: new Set<Id>(),
      shownScopes: new Map<Id, Scope>(),
      shownTrails: new Map<Id, readonly Event[]>(),
    });
    view.evaluation = undefined;
    return view.query(() => this.records.map(r => view.record(r.checkpoint.id)));
  }
  protected prefix(r: Recorded): this {
    const c = r.checkpoint;
    return this.evaluationView(this.records.filter(x => x.at < r.at ||
      (x.at === r.at && x.checkpoint.operator === c.operator && x.checkpoint.sequence < c.sequence)), r.at);
  }
  private evaluate(id: Id): Recorded {
    const raw = super.record(id), session = this.evaluation!;
    const prior = session.results.get(id);
    if (prior !== undefined) return prior;
    requireThat(!session.active.has(id), "unresolved dependency cycle");
    session.active.add(id);
    try {
      const result = this.prefix(raw).validateInView(raw.checkpoint);
      session.results.set(id, result);
      return result;
    } finally { session.active.delete(id); }
  }
  private validateInView(c: Checkpoint): Recorded {
    const result = super.validateCheckpoint(c);
    // The venue holds the original signed identity; a served preimage cannot
    // replace that identity in journal/restart checks.
    return { ...result, checkpoint: c };
  }
  protected override checkpointTrail(c: Checkpoint): Checkpoint {
    const events = this.shownTrails.get(c.id);
    if (events === undefined) return c;
    return { ...c, events: events.map((e, i) => Object.freeze({ ...e, id: `${c.segment}:${i}` })) };
  }
  protected override validateCheckpoint(c: Checkpoint): Recorded {
    return this.query(() => this.prefix({ checkpoint: c, at: this.now, status: "invalid" }).validateInView(c));
  }
  override record(id: Id): Recorded { return this.query(() => this.evaluate(id)); }
  classification(id: Id): Classification {
    const r = this.record(id);
    if (r.status === "final") return "valid";
    if (r.status === "lapsed") return "lapsed";
    if (r.reason !== undefined && AVAILABILITY.test(r.reason)) {
      return this.faults.unresolvedIsExcluded ? "excluded" : this.faults.unresolvedIsValid ? "valid" : "unresolved";
    }
    return "excluded";
  }
  protected override scopeEvidence(c: Checkpoint): void {
    requireThat(!this.withheldDirectories.has(c.id) && !this.withheldScopes.has(c.id) &&
      (!this.shownScopes.has(c.id) || this.shownScopes.get(c.id) === c.scope), "unresolved checkpoint evidence");
  }
  override import(id: Id, checked = new Set<Id>()): State {
    return this.query(() => {
      requireThat(this.classification(id) !== "unresolved", "unresolved checkpoint");
      return super.import(id, checked);
    });
  }
  override latestFor(backing: Id): Id | null { return this.currentFor(backing, this.term(backing).operator); }
  /** C2.10.12: excluded positions provide no state; continuity is checked
   * against the last valid prefix, retaining every held sequence. */
  protected override previousFinal(c: Checkpoint): Recorded | undefined {
    for (const raw of [...this.records].reverse()) {
      if (raw.checkpoint.segment !== c.segment) continue;
      const k = this.classification(raw.checkpoint.id);
      requireThat(k !== "unresolved", "unresolved segment prefix");
      if (k === "valid") return this.record(raw.checkpoint.id);
    }
    return undefined;
  }
  protected override excluded(r: Recorded): boolean {
    const k = this.classification(r.checkpoint.id);
    requireThat(k !== "unresolved", "unresolved checkpoint");
    return k === "excluded";
  }
  protected override receiptPassed(r: Recorded): boolean {
    const k = this.classification(r.checkpoint.id);
    requireThat(k !== "unresolved", "unresolved checkpoint");
    return k === "excluded" || k === "lapsed";
  }
  protected override blocking(_c: Checkpoint, reason: string): boolean { return AVAILABILITY.test(reason); }
  protected override admissible(c: Checkpoint): void {
    requireThat(!this.withheld.has(c.id), "unresolved history");
    try { requireThat(c.evidenceHash === evidenceChain(c.segment, c.events), "unresolved evidence chain"); }
    catch (error) {
      if (error instanceof EncodingError) throw new Refusal("unresolved evidence chain");
      throw error;
    }
  }
  protected override replayed(c: Checkpoint, state: State): void {
    super.replayed(c, state);
    if (!c.events.some(e => e.statement.segment !== c.segment)) return;
    const block = this.block(c.segment, new Map(c.openings));
    for (const event of c.events) {
      if (event.statement.segment === c.segment) continue;
      const publication = block.find(a => a.statement.id === event.statement.id);
      requireThat(publication !== undefined && event.evidence !== undefined, "adopted evidence");
      const expected = this.oracle.evidence(publication.statement);
      requireThat(event.evidence.proof === expected.proof && event.evidence.signature === expected.signature, "adopted evidence");
    }
  }
  override snapshot(backing: Id, at: bigint): Recorded | undefined {
    return this.query(() => {
      for (const r of [...this.records].reverse()) {
        if (r.at >= at || this.term(backing, r.at).operator !== r.checkpoint.operator) continue;
        requireThat(!this.withheldDirectories.has(r.checkpoint.id), "unresolved snapshot");
        if (!r.checkpoint.carries.includes(backing)) continue;
        const k = this.classification(r.checkpoint.id);
        requireThat(k !== "unresolved", "unresolved snapshot");
        if (k === "valid") return this.record(r.checkpoint.id);
      }
      return undefined;
    });
  }
  /** C2b.6.1: only the snapshot resets this backing's no-commitment clock.
   * Directories authenticate carriage; non-carrying checkpoints need no extra
   * classification. The snapshot's own scope and ancestry dependencies remain. */
  override closing(backing: Id, at: bigint): bigint {
    return this.query(() => {
      try { return this.snapshot(backing, at)?.at ?? 0n; } catch (error) {
        if (error instanceof Refusal && AVAILABILITY.test(error.message)) throw new Refusal("unresolved clock");
        throw error;
      }
    });
  }
}
