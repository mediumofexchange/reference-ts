// Research candidate for intrinsic authenticated exclusion. Not normative:
// pool-authority.md and pool-recovery.md still block on invalid live history.
// Witnessed checkpoint/index pairs are immutable input. Each read replays the
// supplied evidence at the checkpoint's original prefix; no recorded verdict
// is authority. Proofs/signatures and authenticated evidence facets are ideal
// tokens, not a production fault-certificate format or a scalable venue index.
import { Refusal, type Checkpoint, type Departures, type Id, type Recorded, type Scope, type Service, type Statement, type State, type Receipt, type ReceiptClassification, type RepairClassification } from "./pool-authority.js";
import { RecoveryWorld, type RecoveryDepartures, type RecoveryState, type Count } from "./pool-recovery.js";

export type Classification = "valid" | "excluded" | "unresolved" | "lapsed";
export interface FaultChoices {
  /** A: validate non-carrying histories too. A″ (default) needs authenticated
   * absence and lapse evidence, which can still depend on the other scope. */
  readonly classifyNonCarrying?: boolean;
  /** A′: excluded carrying commitments still close the interval. */
  readonly excludedClosesInterval?: boolean;
}
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
  constructor(lag = 1n, readonly choices: FaultChoices = {}, readonly faults: FaultDepartures = {},
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
  private query<T>(read: () => T): T {
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
  private prefix(r: Recorded): this {
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
  /** Lapse has its own evidence: term lapse needs the header/terms; silence
   * lapse also needs its historical clock. Neither needs this event proof. */
  private lapsed(r: Recorded): boolean {
    const view = this.prefix(r), c = r.checkpoint;
    try { return view.scopeEnded(c) || view.passedByRule(c, r.at); }
    catch (error) {
      if (!(error instanceof Refusal) || AVAILABILITY.test(error.message)) throw error;
      return false; // An authenticated malformed header proves no lapse.
    }
  }
  override import(id: Id, checked = new Set<Id>()): State {
    return this.query(() => {
      requireThat(this.classification(id) !== "unresolved", "unresolved checkpoint");
      return super.import(id, checked);
    });
  }
  override latestFor(backing: Id): Id | null { return this.currentFor(backing, this.term(backing).operator); }
  protected override previousFinal(c: Checkpoint): Recorded | undefined {
    for (const raw of [...this.records].reverse()) {
      if (raw.checkpoint.segment !== c.segment) continue;
      const k = this.classification(raw.checkpoint.id);
      requireThat(k !== "unresolved", "unresolved segment prefix");
      if (k === "valid") return this.record(raw.checkpoint.id);
    }
    return undefined;
  }
  /** The candidate retains whole-segment termination, including stale twins.
   * This is an explicit research choice, not derived from C2.10.6 alone. */
  faulted(segment: Id): boolean {
    return this.query(() => {
      for (const r of this.records) {
        if (r.checkpoint.segment !== segment) continue;
        const k = this.classification(r.checkpoint.id);
        requireThat(k !== "unresolved", "unresolved segment fault");
        if (k === "excluded") return true;
      }
      return false;
    });
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
    requireThat(!this.faulted(c.segment), "faulted segment");
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
  override closing(backing: Id, at: bigint): bigint {
    return this.query(() => {
      for (const r of [...this.records].reverse()) {
        if (r.at >= at || this.term(backing, r.at).operator !== r.checkpoint.operator) continue;
        requireThat(!this.withheldDirectories.has(r.checkpoint.id), "unresolved clock");
        let lapsed: boolean;
        try { lapsed = this.lapsed(r); } catch (error) {
          if (error instanceof Refusal && AVAILABILITY.test(error.message)) throw new Refusal("unresolved clock");
          throw error;
        }
        if (lapsed && !this.recovery.lapsedClosesGap) continue;
        if (r.checkpoint.carries.includes(backing) || this.choices.classifyNonCarrying) {
          const k = this.classification(r.checkpoint.id);
          requireThat(k !== "unresolved", "unresolved clock");
          if (k === "excluded" && !this.choices.excludedClosesInterval) continue;
        }
        return r.at;
      }
      return 0n;
    });
  }
  override serving(service: Service, statement: Statement): void {
    requireThat(!this.faulted(service.id), "faulted segment");
    super.serving(service, statement);
  }
  override adoptable(statement: Statement, segment: Id, openings: ReadonlyMap<Id, Id | null>, position: number): { scope: Scope; at: bigint } {
    requireThat(!this.faulted(segment), "faulted segment");
    return super.adoptable(statement, segment, openings, position);
  }
  protected override discardable(service: Service): boolean {
    return this.faulted(service.id) || super.discardable(service);
  }
}
