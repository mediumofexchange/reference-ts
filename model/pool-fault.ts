// Candidate A of docs/POOL_FAULT_RECOVERY_PROPOSAL.md, modelled over the
// recovery model: intrinsic authenticated exclusion of an invalid checkpoint.
// This is a research candidate, NOT a normative rule. pool-recovery.md
// C2b.3.1, C2b.5.2 and C2b.6.1 and pool-authority.md C2.10.3–4 still block
// on invalid live carrying evidence, and model/pool-recovery.ts models them
// as written. This subclass changes exactly the reads those rules name, so
// the candidate's cost is the difference between the two files. Fault
// evidence is ideal: the model knows whether held bytes fail deterministically
// and whether a reader holds them; it does not define a fault-certificate
// byte format or prove that an interior history event is cheap to authenticate.
import { Refusal, type Checkpoint, type Departures, type Id, type Recorded, type Scope, type Service, type Statement } from "./pool-authority.js";
import { RecoveryWorld, type RecoveryDepartures } from "./pool-recovery.js";

/** Rule 1–2: every required checkpoint is valid, excluded with authenticated
 * evidence, or unresolved. A whole-scope lapse is a public condition the
 * existing rules already pass without evidence. */
export type Classification = "valid" | "excluded" | "unresolved" | "lapsed";

/** Switches between the candidate's variants; none is a departure. */
export interface FaultChoices {
  /** The proposal's candidate A as written: a commitment carrying nothing
   * for b closes b's interval only where it classifies valid, so b's reader
   * needs the other scope's evidence. Off (the default, called A″ in the
   * proposal's comparison): a non-carrying commitment closes b's interval
   * whatever its validity, as C2b.6.1 has it today. */
  readonly classifyNonCarrying?: boolean;
  /** Candidate A′: an excluded carrying commitment still closes the interval
   * (C2b.6.1 as written), leaving fault to the count and E's replacement rule. */
  readonly excludedClosesInterval?: boolean;
}
export interface FaultDepartures {
  /** Rule 1 counterexample: bytes the reader cannot obtain or match are read as fault. */
  readonly unresolvedIsExcluded?: boolean;
  /** Rule 3 counterexample: a checkpoint the reader cannot classify is read as valid. */
  readonly unresolvedIsValid?: boolean;
}
const AVAILABILITY = /^(unavailable|unresolved)/;
function requireThat(ok: boolean, message: string): asserts ok { if (!ok) throw new Refusal(message); }

export class FaultWorld extends RecoveryWorld {
  constructor(lag = 1n, readonly choices: FaultChoices = {}, readonly faults: FaultDepartures = {},
    recovery: RecoveryDepartures = {}, departures: Departures = {}) {
    super(lag, recovery, departures);
  }

  /** Rule 1–3: the classification of a held checkpoint relative to its own
   * record prefix, as far as this reader's evidence reaches. A checkpoint is
   * resolved only when its own bytes, its imported ancestry, and every carrying
   * checkpoint its descent passed and its clock read are resolved. */
  classification(id: Id, seen = new Set<Id>()): Classification {
    const r = this.record(id), c = r.checkpoint;
    if (r.status === "lapsed") return "lapsed";
    if (seen.has(id)) return this.own(r);
    seen.add(id);
    const shown = this.shownScopes.get(id);
    const available = !this.withheld.has(id) && !this.withheldDirectories.has(id) && !this.withheldScopes.has(id) && (shown === undefined || shown === c.scope);
    if (!available) return this.faults.unresolvedIsExcluded ? "excluded" : this.faults.unresolvedIsValid ? "valid" : "unresolved";
    const parents = new Map(c.openings);
    for (const parent of parents.values()) if (parent !== null && this.classification(parent, seen) === "unresolved") return "unresolved";
    for (const e of c.scope.entries) {
      const parent = parents.get(e.backing) ?? null;
      const from = parent === null ? -1n : this.record(parent).at;
      for (const x of this.records) {
        if (x === r || x.at <= from || x.at > r.at) continue;
        if (x.at === r.at && !(x.checkpoint.operator === c.operator && x.checkpoint.sequence < c.sequence)) continue;
        if (this.term(e.backing, x.at).operator !== x.checkpoint.operator) continue;
        if (!x.checkpoint.carries.includes(e.backing) && !this.choices.classifyNonCarrying) continue;
        if (this.classification(x.checkpoint.id, seen) === "unresolved") return "unresolved";
      }
    }
    return this.own(r);
  }
  /** The record's own verdict: a deterministic failure of held bytes is
   * exclusion; a verdict drawn for want of evidence is no classification. */
  private own(r: Recorded): Classification {
    if (r.status === "final") return "valid";
    if (r.status === "lapsed") return "lapsed";
    return r.reason !== undefined && AVAILABILITY.test(r.reason) ? "unresolved" : "excluded";
  }
  /** Rule 4: an excluded checkpoint faults its segment; one segment identity
   * binds one history (C2.10.6), so repair is a new segment. */
  faulted(segment: Id): boolean {
    return this.records.some(r => r.checkpoint.segment === segment && this.own(r) === "excluded");
  }

  // ---- the reads, each on the one classification ----

  /** C2.7 / C2.10.4: descent passes an excluded checkpoint on its evidence and
   * stops at an unresolved one. */
  protected override excluded(record: Recorded): boolean {
    const k = this.classification(record.checkpoint.id);
    requireThat(k !== "unresolved", "unresolved checkpoint");
    return k === "excluded";
  }
  /** An excluded checkpoint is not the backing's latest state; an unresolved
   * record verdict still blocks, as today. */
  protected override blocking(_checkpoint: Checkpoint, reason: string): boolean { return AVAILABILITY.test(reason); }
  protected override admissible(c: Checkpoint): void { requireThat(!this.faulted(c.segment), "faulted segment"); }

  /** C2b.3.1 under the candidate: the last carrying checkpoint by a party then
   * in force, passing whole-scope lapses and evidenced exclusions. */
  override snapshot(backing: Id, at: bigint): Recorded | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.at >= at || r.status === "lapsed" || !r.checkpoint.carries.includes(backing)) continue;
      if (this.term(backing, r.at).operator !== r.checkpoint.operator) continue;
      const k = this.classification(r.checkpoint.id);
      requireThat(k !== "unresolved", "unresolved snapshot");
      if (k === "excluded") continue;
      return r;
    }
    return undefined;
  }
  /** C2b.6.1 under the candidate: an excluded commitment carrying b does not
   * close b's interval; a commitment carrying nothing for b closes it as
   * today unless `classifyNonCarrying` asks for its classification too. */
  override closing(backing: Id, at: bigint): bigint {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (r.at >= at || (r.status === "lapsed" && !this.recovery.lapsedClosesGap)) continue;
      if (this.term(backing, r.at).operator !== r.checkpoint.operator) continue;
      if (r.checkpoint.carries.includes(backing) || this.choices.classifyNonCarrying) {
        const k = this.classification(r.checkpoint.id);
        requireThat(k !== "unresolved", "unresolved clock");
        if (k === "excluded" && !this.choices.excludedClosesInterval) continue;
      }
      return r.at;
    }
    return 0n;
  }
  /** The honest door: a faulted segment serves and adopts nothing more; the
   * operator opens a new segment on the canonical state (rule 4). */
  override serving(service: Service, statement: Statement): void {
    requireThat(!this.faulted(service.id), "faulted segment");
    super.serving(service, statement);
  }
  override adoptable(statement: Statement, segment: Id, openings: ReadonlyMap<Id, Id | null>, position: number): { scope: Scope; at: bigint } {
    requireThat(!this.faulted(segment), "faulted segment");
    return super.adoptable(statement, segment, openings, position);
  }
  /** The faulted tail is discarded as a unit; its receipts read abandoned (C2.10.9b). */
  protected override discardable(service: Service): boolean {
    return this.faulted(service.id) || super.discardable(service);
  }
}
