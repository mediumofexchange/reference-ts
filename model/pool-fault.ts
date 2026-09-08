// C2.10.9c/11–13 and C2b.6.1: intrinsic authenticated exclusion, a clock
// at the last valid carrying snapshot, and continuation of the last valid prefix.
// Witnessed checkpoint/index pairs are immutable input. Each read replays the
// supplied evidence at the checkpoint's original prefix; no recorded verdict
// is authority. Proofs/signatures and authenticated evidence facets are ideal
// tokens. C2.10.10's committed evidence chain and evidence-bound receipt bytes
// remain unmodeled; this is not a production fault-certificate format.
import { Refusal, type Checkpoint, type Departures, type Id, type Recorded, type Scope, type State, type Receipt, type ReceiptClassification, type RepairClassification } from "./pool-authority.js";
import { RecoveryWorld, type RecoveryDepartures, type RecoveryState, type Count } from "./pool-recovery.js";

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
  "withheld" | "withheldDirectories" | "withheldScopes" | "shownScopes">;

export class FaultWorld extends RecoveryWorld {
  private evaluation: Evaluation | undefined;
  constructor(lag = 1n, readonly faults: FaultDepartures = {},
    recovery: RecoveryDepartures = {}, departures: Departures = {}) {
    super(lag, recovery, departures);
  }
  reader(): FaultReader {
    const view = this.evaluationView(this.records, this.now);
    Object.assign(view, {
      withheld: new Set(this.withheld), withheldDirectories: new Set(this.withheldDirectories),
      withheldScopes: new Set(this.withheldScopes), shownScopes: new Map(this.shownScopes),
    });
    view.evaluation = undefined;
    return view;
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
    return this.query(() => super.classify(receipt, scope));
  }
  override classifyRepair(receipt: Receipt, scope: Scope, boundary: Id): RepairClassification {
    return this.query(() => super.classifyRepair(receipt, scope, boundary));
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
  private validateInView(c: Checkpoint): Recorded { return super.validateCheckpoint(c); }
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
