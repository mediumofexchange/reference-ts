// Executable abstraction of pool-recovery.md over the authority model: C3.7–8
// at the door, C2b.5.1–2's request and count, C2b.6.1's clock, C2b.3.1–3's
// snapshot, recovery state and publications with force, and C2b.4.1–2's
// return as a new segment with its adopted block. Publications are ideal
// signed tokens the venue holds without interpreting; every reader decides
// force from the same record, at the publication's own index. It is NOT a
// circuit, a venue adapter or a durable store.
import {
  World, Service, Refusal, applyEvent, lockStanding,
  type Acceptance, type Checkpoint, type Departures, type Id, type Receipt, type Recorded, type Scope, type State, type Statement,
} from "./pool-authority.js";

export interface NonServiceTerms { readonly duration: bigint; readonly count: bigint; readonly window: bigint }
/** E's silence clause (Construction §C2b.5–6): the no-commitment duration and the non-service terms. */
export interface Clause { readonly noCommitment: bigint; readonly nonService?: NonServiceTerms }
export interface RecoveryDepartures {
  /** C2b.6.1: a whole-scope lapse closes the interval. */
  readonly lapsedClosesGap?: boolean;
  /** C2b.3.2: a publication has force whether or not the gap is open at its index. */
  readonly forceOutsideGap?: boolean;
  /** C2b.3.1: read the venue record from the snapshot's own index, not from its adoption index. */
  readonly settleTwice?: boolean;
  /** C2b.3b: a publication of nullifiers alone consumes notes. */
  readonly bareNullifiers?: boolean;
  /** C2b.4.2: the block ends strictly before the opening's index. */
  readonly skipSameIndex?: boolean;
  /** C2b.4.2: statements are served before the block is adopted. */
  readonly serveBeforeAdoption?: boolean;
  /** C2b.3a: an anchor the snapshot does not certify is accepted. */
  readonly anyAnchor?: boolean;
  /** C2b.5.2: a request counts without a verified proof. */
  readonly countUnproven?: boolean;
  /** C2b.5: a handover resets the count. */
  readonly resetOnHandover?: boolean;
  /** C2b.4.1: a continuation checkpoint closes the gap and keeps its tail. */
  readonly continueThroughGap?: boolean;
}
export type Publication =
  | { readonly kind: "demand" | "withdrawal" | "release" | "request"; readonly backing: Id; readonly statement: Statement }
  | { readonly kind: "acceptance"; readonly backing: Id; readonly acceptance: Acceptance }
  | { readonly kind: "nullifiers"; readonly backing: Id; readonly nullifiers: readonly Id[] };
export interface Witnessed { readonly publication: Publication; readonly at: bigint; readonly order: number }
export interface Adopted { readonly statement: Statement; readonly scope: Scope; readonly witnessed: Witnessed }
export interface RecoveryState { readonly base: Recorded; readonly state: State; readonly force: readonly Witnessed[] }
export interface Count { readonly count: bigint; readonly fires: boolean; readonly incumbent: Id; readonly readable: boolean }

function requireThat(ok: boolean, message: string): asserts ok { if (!ok) throw new Refusal(message); }
const STATEMENT_KIND = { demand: "demand", withdrawal: "withdraw", release: "settle" } as const;

export class RecoveryWorld extends World {
  readonly published: Witnessed[] = [];
  private readonly clauses = new Map<Id, Clause>();
  private readonly names: Id[] = [];
  private readonly live = new Set<Service>();
  constructor(lag = 1n, readonly recovery: RecoveryDepartures = {}, departures: Departures = {}) { super(lag, departures); }

  override register(backing: Id, operator: Id, domain = "D", obligor = backing): void {
    super.register(backing, operator, domain, obligor);
    this.names.push(backing);
  }
  declare(backing: Id, clause: Clause): void {
    requireThat(this.names.includes(backing), "unknown backing");
    this.clauses.set(backing, clause);
  }
  /** C2b.6.1: one no-commitment duration per scope, or none. */
  override open(operator: Id, names: readonly Id[], domain = "D", override?: ReadonlyMap<Id, Id | null>): Service {
    requireThat(new Set(names.map(b => this.clauses.get(b)?.noCommitment.toString() ?? "none")).size <= 1, "mixed silence clauses");
    const service = super.open(operator, names, domain, override);
    this.live.add(service);
    return service;
  }
  /** The venue witnesses a publication at the present index, in publication order. */
  publish(publication: Publication): Witnessed {
    const witnessed = Object.freeze({ publication, at: this.now, order: this.published.length });
    this.published.push(witnessed);
    return witnessed;
  }

  /** C2b.6.1: c(t), the greatest index strictly before t holding a commitment
   * by the party then in force for the backing, other than a whole-scope lapse. */
  closing(backing: Id, at: bigint): bigint {
    let last = 0n;
    for (const r of this.records) {
      if (r.at >= at || r.at <= last || (r.status === "lapsed" && !this.recovery.lapsedClosesGap)) continue;
      if (this.term(backing, r.at).operator === r.checkpoint.operator) last = r.at;
    }
    return last;
  }
  gapOpen(backing: Id, at: bigint): boolean {
    const clause = this.clauses.get(backing);
    return clause !== undefined && at - this.closing(backing, at) > clause.noCommitment;
  }
  /** C2b.3.1: the last carrying checkpoint strictly before t by a party then in
   * force, passing whole-scope lapses. Invalid live evidence blocks the read,
   * as it blocks C2.7's descent (C2.10.3); it is not an older state. */
  snapshot(backing: Id, at: bigint): Recorded | undefined {
    let found: Recorded | undefined;
    for (const r of this.records) {
      if (r.at >= at || r.status === "lapsed" || !r.checkpoint.carries.includes(backing)) continue;
      if (this.term(backing, r.at).operator === r.checkpoint.operator) found = r;
    }
    requireThat(found === undefined || found.status === "final", "invalid snapshot");
    return found;
  }
  /** C2b.3.1: the index through which a checkpoint's state accounts for the venue record. */
  adoptionIndex(id: Id, backing: Id): bigint {
    const c = this.record(id).checkpoint;
    if (!(c.sequence === c.openingSequence && c.events.length === 0)) {
      const opening = this.records.find(r => r.checkpoint.segment === c.segment);
      requireThat(opening !== undefined, "opening not held");
      return opening.at;
    }
    const parent = new Map(c.openings).get(backing);
    return parent === null || parent === undefined ? 0n : this.adoptionIndex(parent, backing);
  }
  /** C2b.3.1: the snapshot's state with every publication with force since its
   * adoption index and strictly before t, in venue order. */
  recoveryState(backing: Id, at: bigint): RecoveryState {
    const base = this.snapshot(backing, at);
    requireThat(base !== undefined, "no snapshot");
    const state = this.import(base.checkpoint.id);
    const from = this.recovery.settleTwice ? base.at : this.adoptionIndex(base.checkpoint.id, backing);
    const force: Witnessed[] = [];
    for (const w of this.published) {
      if (w.publication.backing !== backing || w.at <= from || w.at >= at) continue;
      if (this.judge(w, state)) force.push(w);
    }
    return { base, state, force };
  }
  /** C2b.3.2: force is decided once, at the publication's own index, against
   * the snapshot then and the recovery state so far. */
  private judge(w: Witnessed, state: State): boolean {
    const p = w.publication, t = w.at;
    if (p.kind === "acceptance" || p.kind === "request") return false;
    if (!this.recovery.forceOutsideGap && !this.gapOpen(p.backing, t)) return false;
    const base = this.snapshot(p.backing, t);
    if (base === undefined) return false;
    const c = base.checkpoint;
    let statement: Statement;
    if (p.kind === "nullifiers") {
      if (!this.recovery.bareNullifiers) return false;
      statement = Object.freeze({ id: `bare${w.order}`, segment: c.segment, scope: c.scope.root, domain: c.scope.domain, kind: "spend" as const,
        anchors: Object.freeze([] as Id[]), nullifiers: Object.freeze([...p.nullifiers]), outputs: Object.freeze([] as Id[]) });
    } else {
      statement = p.statement;
      // The venue's name is routing; the publication is read for the backing its statement names.
      if (statement.lit?.backing !== p.backing) return false;
      if (statement.kind !== STATEMENT_KIND[p.kind] || statement.segment !== c.segment || statement.scope !== c.scope.root) return false;
      const roots = this.recovery.anyAnchor ? this.anyRoots(state) : state.roots;
      if (!this.oracle.verify(statement, c.scope, roots, this.departures)) return false;
      const lit = statement.lit;
      if (statement.kind === "demand" && !(lit.deadline !== undefined && lit.deadline > t && this.instantWithin(lit.instant, t))) return false;
      if (statement.kind === "settle") {
        const demand = state.standing.get(lit.demand ?? "");
        if (demand === undefined || (demand.lit?.deadline ?? 0n) < t) return false;
        if (!this.departures.ignoreAcceptance && !(lit.acceptance !== undefined && lit.acceptance.deadline >= t)) return false;
      }
    }
    // A republication of a statement already applied is refused here as a
    // duplicate, so a publication has force once: at the first index at which it has any.
    try { applyEvent(state, { id: `venue:${w.order}`, statement }, this.departures, t); } catch (error) { if (error instanceof Refusal) return false; throw error; }
    return true;
  }
  /** C3.3: the instant is within one lag below the latest index a signer could have seen. */
  private instantWithin(instant: bigint | undefined, witnessed: bigint): boolean {
    return instant !== undefined && witnessed - 2n * this.lag <= instant && instant <= witnessed - this.lag;
  }
  private anyRoots(view: State): Map<Id, readonly Id[]> {
    const roots = new Map(view.roots);
    for (const s of this.live) for (const [root, leaves] of s.view().roots) roots.set(root, leaves);
    return roots;
  }
  /** C2b.4.2: the adopted block of a segment whose opening the record holds:
   * every publication with force naming a scoped backing, after the imported
   * state's adoption index and at or before the opening's index. */
  block(segment: Id, openings: ReadonlyMap<Id, Id | null>): Adopted[] {
    const opening = this.records.find(r => r.checkpoint.segment === segment);
    requireThat(opening !== undefined && opening.status === "final", "opening not witnessed");
    const through = this.recovery.skipSameIndex ? opening.at : opening.at + 1n;
    const adopted: Adopted[] = [];
    for (const backing of openings.keys()) {
      if (!this.clauses.has(backing) && !this.recovery.forceOutsideGap) continue;
      let recovered: RecoveryState;
      try { recovered = this.recoveryState(backing, through); } catch (error) {
        if (error instanceof Refusal && error.message === "no snapshot") continue; // nothing to redeem against, nothing to adopt
        throw error;
      }
      for (const witnessed of recovered.force) {
        const p = witnessed.publication;
        if (p.kind === "nullifiers" || p.kind === "acceptance" || p.kind === "request") continue;
        const scope = this.snapshot(backing, witnessed.at)!.checkpoint.scope;
        adopted.push({ statement: p.statement, scope, witnessed });
      }
    }
    return adopted.sort((a, b) => a.witnessed.at === b.witnessed.at ? a.witnessed.order - b.witnessed.order : a.witnessed.at < b.witnessed.at ? -1 : 1);
  }
  /** The returning operator's routine: adopt the block in venue order, then serve. */
  adoptGap(service: Service): Receipt[] {
    return this.block(service.id, service.openings).map(a => service.adopt(a.statement));
  }
  override adoptable(statement: Statement, segment: Id, openings: ReadonlyMap<Id, Id | null>, position: number): { scope: Scope; at: bigint } {
    const block = this.block(segment, openings);
    const next = this.recovery.serveBeforeAdoption ? block.find(a => a.statement.id === statement.id) : block[position];
    requireThat(next !== undefined && next.statement.id === statement.id, "not the next adopted statement");
    return { scope: next.scope, at: next.witnessed.at }; // judged once, at its own index (C2b.4.2)
  }
  /** C2b.4.1: a checkpoint witnessed while a scoped backing's gap is open,
   * other than a new segment's opening checkpoint, lapses for its whole
   * scope; C2.7's descent passes it on the same public condition. */
  protected override passedByRule(c: Checkpoint, at: bigint): boolean {
    if (this.recovery.continueThroughGap) return false;
    const opening = c.sequence === c.openingSequence && c.events.length === 0;
    return !opening && c.scope.entries.some(e => this.gapOpen(e.backing, at));
  }
  /** C2b.4.2: after the opening, the history begins with the complete block
   * in venue order and adopts nothing outside it. */
  protected override replayed(c: Checkpoint, _state: State): void {
    const opening = this.records.find(r => r.checkpoint.segment === c.segment);
    if (opening === undefined) {
      requireThat(c.events.every(e => e.statement.segment === c.segment), "adoption before the opening");
      return;
    }
    const block = this.block(c.segment, new Map(c.openings));
    if (!this.recovery.serveBeforeAdoption) {
      requireThat(c.events.length >= block.length && block.every((a, i) => c.events[i]!.statement.id === a.statement.id), "adopted block");
    }
    for (const e of c.events) requireThat(e.statement.segment === c.segment || block.some(a => a.statement.id === e.statement.id), "adopted statement outside the block");
  }
  /** C3.8 at the door, C2b.4's silence and C2b.4.2's order: a deadline is
   * read where the act would first be witnessed; nothing is co-signed into an
   * open gap, and nothing before the adopted block. */
  override serving(service: Service, statement: Statement): void {
    const lit = statement.lit, horizon = this.now + this.lag;
    if (statement.kind === "demand") {
      requireThat(lit?.deadline !== undefined && lit.deadline > horizon, "deadline not ahead");
      requireThat(this.instantWithin(lit.instant, horizon), "instant outside its window");
    }
    if (statement.kind === "settle" && !this.departures.ignoreAcceptance) {
      requireThat(lit?.acceptance !== undefined && lit.acceptance.deadline >= horizon, "acceptance expired");
    }
    const opening = this.records.find(r => r.checkpoint.segment === service.id);
    const open = service.scope.entries.some(e => this.gapOpen(e.backing, horizon));
    if (open) requireThat(this.recovery.serveBeforeAdoption === true, opening === undefined ? "adopt the gap first" : "gap open");
    if (opening !== undefined && !this.recovery.serveBeforeAdoption) {
      const block = this.block(service.id, service.openings);
      requireThat(service.events.length >= block.length && block.every((a, i) => service.events[i]!.statement.id === a.statement.id), "adopt the gap first");
    }
  }
  /** C2b.4.1: a return discards the tail the gap already excused. */
  protected override discardable(service: Service): boolean {
    return service.scope.entries.some(e => this.gapOpen(e.backing, this.now + this.lag));
  }

  /** C2b.5.2: the count at an index against the canonical state there. */
  count(backing: Id, at: bigint): Count {
    const incumbent = this.term(backing, at).operator;
    const terms = this.clauses.get(backing)?.nonService;
    if (terms === undefined) return { count: 0n, fires: false, incumbent, readable: true };
    // The canonical state is the snapshot's (C2b.3.1); what blocks the one blocks the other.
    let canonical: Recorded | undefined;
    try { canonical = this.snapshot(backing, at); } catch (error) {
      if (error instanceof Refusal && error.message.endsWith("snapshot")) return { count: 0n, fires: false, incumbent, readable: false };
      throw error;
    }
    const tags = new Set<Id>();
    if (canonical !== undefined) {
      const state = this.import(canonical.checkpoint.id);
      const from = this.recovery.resetOnHandover ? this.term(backing, at).from : 0n;
      for (const w of this.published) {
        const p = w.publication;
        if (p.kind !== "request" || p.backing !== backing || w.at < at - terms.window || w.at > at - terms.duration || w.at < from) continue;
        const s = p.statement, tag = s.lit?.tag;
        if (s.kind !== "request" || tag === undefined || s.lit?.backing !== backing) continue;
        if (!this.recovery.countUnproven && !this.oracle.verify(s, canonical.checkpoint.scope, state.roots, this.departures)) continue;
        if (state.spentTags.has(tag) || lockStanding(state, tag, at) !== undefined) continue;
        tags.add(tag);
      }
    }
    const count = BigInt(tags.size);
    return { count, fires: count >= terms.count, incumbent, readable: true };
  }

  /** Independent semantic checks with the hidden oracle: holdings equal
   * supply in every finalized and recovery state; a settlement pays the
   * backer's owner value under K's acceptance; a publication that had force
   * at its own index consumes each note once, and no finalized statement
   * other than its own consumes that note again. */
  recoveryViolations(): string[] {
    const bad = new Set<string>(this.violations());
    const holdings = (state: State, label: string): void => {
      const held = new Map<Id, bigint>();
      for (const cm of state.outputs) {
        const note = this.oracle.opening(cm);
        if (!state.spent.has(note.nf)) held.set(note.backing, (held.get(note.backing) ?? 0n) + note.value);
      }
      for (const b of new Set([...held.keys(), ...state.totals.keys()])) {
        if ((held.get(b) ?? 0n) !== (state.totals.get(b) ?? 0n)) bad.add(`holdings differ from supply: ${label}`);
      }
    };
    const paysBacker = (s: Statement): void => {
      const lit = s.lit, out = this.oracle.opening(s.outputs[0] ?? "");
      if (lit?.acceptance === undefined || !lit.acceptance.signedByK || out?.owner !== lit.acceptance.owner) bad.add("settlement not to the backer");
    };
    for (const r of this.records) {
      if (r.status !== "final" || r.state === undefined) continue;
      holdings(r.state, "finalized");
      for (const e of r.checkpoint.events) if (e.statement.kind === "settle") paysBacker(e.statement);
    }
    const consumed = new Map<Id, Id>();
    for (const backing of this.names) {
      try { holdings(this.recoveryState(backing, this.now + 1n).state, "recovery"); } catch (error) { if (!(error instanceof Refusal)) throw error; }
      for (const w of this.published) {
        const p = w.publication;
        if (p.backing !== backing || (p.kind !== "release" && p.kind !== "nullifiers")) continue;
        let force: readonly Witnessed[];
        try { force = this.recoveryState(backing, w.at + 1n).force; } catch (error) { if (error instanceof Refusal) continue; throw error; }
        if (!force.includes(w)) continue;
        const by = p.kind === "nullifiers" ? `bare${w.order}` : p.statement.id;
        for (const nf of p.kind === "nullifiers" ? p.nullifiers : p.statement.nullifiers) {
          if (consumed.has(nf) && consumed.get(nf) !== by) bad.add("note settled twice");
          consumed.set(nf, by);
        }
        if (p.kind === "release") paysBacker(p.statement);
      }
    }
    for (const r of this.records) {
      if (r.status !== "final") continue;
      for (const e of r.checkpoint.events) for (const nf of e.statement.nullifiers) {
        const by = consumed.get(nf);
        if (by !== undefined && by !== e.statement.id) bad.add("settled note spent again");
      }
    }
    return [...bad];
  }
}
