// Test-only rejected clock and segment rules, retained for their counterexamples.
// Active protocol behavior is FaultWorld; no runtime or active model imports this helper.
import { Refusal, type Checkpoint, type Departures, type Id, type Recorded, type Scope, type Service, type Statement } from "./pool-authority.js";
import { type RecoveryDepartures } from "./pool-recovery.js";
import { FaultWorld, type FaultDepartures } from "./pool-fault.js";

export interface FaultChoices {
  /** A: validate non-carrying histories too. A″ (default) needs authenticated
   * absence and lapse evidence, which can still depend on the other scope. */
  readonly classifyNonCarrying?: boolean;
  /** A′: excluded carrying commitments still close the interval. */
  readonly excludedClosesInterval?: boolean;
  /** Research alternative: a non-carrying commitment closes this backing's
   * interval even if silence lapses it for its own scope. Term lapse still
   * prevents closure. This changes C2b.4.1/C2b.6.1 and may affect later
   * finality through the clock. */
  readonly nonCarryingSilenceClosesInterval?: boolean;
}
const AVAILABILITY = /^(unavailable|unresolved|unauthenticated)/;
function requireThat(ok: boolean, message: string): asserts ok { if (!ok) throw new Refusal(message); }

export class HistoricalFaultWorld extends FaultWorld {
  constructor(lag = 1n, readonly choices: FaultChoices = {}, faults: FaultDepartures = {},
    recovery: RecoveryDepartures = {}, departures: Departures = {}) {
    super(lag, faults, recovery, departures);
    requireThat(!(choices.classifyNonCarrying && choices.nonCarryingSilenceClosesInterval), "conflicting clock choices");
  }
  /** Lapse has its own evidence: term lapse needs the header/terms; silence
   * lapse also needs its historical clock. Neither needs this event proof. */
  private lapsed(r: Recorded, termOnly = false): boolean {
    const view = this.prefix(r), c = r.checkpoint;
    try { return view.scopeEnded(c) || (!termOnly && view.passedByRule(c, r.at)); }
    catch (error) {
      if (!(error instanceof Refusal) || AVAILABILITY.test(error.message)) throw error;
      return false; // An authenticated malformed header proves no lapse.
    }
  }
  /** Rejected R7: any fault terminates subsequent service in the segment. */
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
  protected override admissible(c: Checkpoint): void {
    super.admissible(c);
    requireThat(!this.faulted(c.segment), "faulted segment");
  }
  override closing(backing: Id, at: bigint): bigint {
    return this.query(() => {
      for (const r of [...this.records].reverse()) {
        if (r.at >= at || this.term(backing, r.at).operator !== r.checkpoint.operator) continue;
        requireThat(!this.withheldDirectories.has(r.checkpoint.id), "unresolved clock");
        let lapsed: boolean;
        const nonCarrying = !r.checkpoint.carries.includes(backing);
        try { lapsed = this.lapsed(r, nonCarrying && this.choices.nonCarryingSilenceClosesInterval === true); } catch (error) {
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
