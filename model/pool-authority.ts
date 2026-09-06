// Executable abstraction of pool-authority.md (C1.2.1–2, C2.10.1–9).
// Cryptographic identities, signatures and ZK proofs are ideal immutable
// tokens. Only ProofOracle sees note openings; the service and record read
// public scope, anchors, nullifiers, commitments and lit issue/burn deltas.
// The older sequencing model checks replacement election and lag scheduling;
// this model checks their interaction with opaque shared history, on one venue.
// It is NOT a circuit implementation, durable store or production sequencer.

export type Id = string;
export interface Note {
  readonly cm: Id;
  readonly nf: Id;
  readonly backing: Id;
  readonly domain: Id;
  readonly value: bigint;
}
export interface Term { readonly backing: Id; readonly operator: Id; readonly link: Id; readonly from: bigint }
export interface Scope { readonly domain: Id; readonly operator: Id; readonly entries: readonly Term[]; readonly root: Id }
export interface Statement {
  readonly id: Id;
  readonly segment: Id;
  readonly scope: Id;
  readonly domain: Id;
  readonly anchors: readonly Id[];
  readonly nullifiers: readonly Id[];
  readonly outputs: readonly Id[];
  readonly kind: "issue" | "spend" | "burn";
  readonly lit?: { readonly backing: Id; readonly quantity: bigint };
}
interface Witness { readonly inputs: readonly Note[]; readonly outputs: readonly Note[]; readonly signedByK: boolean }
export interface Departures {
  readonly ignoreScope?: boolean;
  readonly partialFinality?: boolean;
  readonly ignorePredecessor?: boolean;
  readonly forgetSpent?: boolean;
  readonly countSharedTwice?: boolean;
  readonly retainAbandoned?: boolean;
  readonly skipUnprovenSteps?: boolean;
  readonly skipLiveInvalid?: boolean;
  readonly skipSameIndex?: boolean;
  readonly trustShownScope?: boolean;
}
export class Refusal extends Error {}
function requireThat(ok: boolean, message: string): asserts ok { if (!ok) throw new Refusal(message); }
function same<T>(a: readonly T[], b: readonly T[]): boolean { return a.length === b.length && a.every((x, i) => x === b[i]); }

export class ProofOracle {
  private serial = 0n;
  private readonly witnesses = new Map<Statement, Witness>();
  private readonly notes = new Map<Id, Note>();
  private readonly identities = new Map<string, Id>();

  note(backing: Id, value: bigint, domain = "D"): Note {
    const id = ++this.serial;
    const note = Object.freeze({ cm: `cm${id}`, nf: `nf${id}`, backing, value, domain });
    this.notes.set(note.cm, note);
    return note;
  }

  prove(service: Service, kind: Statement["kind"], inputs: readonly Note[], outputs: readonly Note[],
    anchors: readonly Id[] = [], lit?: Statement["lit"], signedByK = true): Statement {
    // Model-only interning of public values, not a signed wire encoding.
    const key = JSON.stringify([service.id, service.scope.root, kind, service.scope.domain, anchors,
      inputs.map(n => n.nf), outputs.map(n => n.cm), lit?.backing, lit?.quantity.toString()]);
    const id = this.identities.get(key) ?? `statement${++this.serial}`;
    this.identities.set(key, id);
    const statement: Statement = Object.freeze({ id, segment: service.id,
      scope: service.scope.root, domain: service.scope.domain, kind,
      anchors: Object.freeze([...anchors]), nullifiers: Object.freeze(inputs.map(n => n.nf)),
      outputs: Object.freeze(outputs.map(n => n.cm)), ...(lit ? { lit: Object.freeze({ ...lit }) } : {}) });
    this.witnesses.set(statement, { inputs: [...inputs], outputs: [...outputs], signedByK });
    return statement;
  }

  verify(s: Statement, scope: Scope, roots: ReadonlyMap<Id, readonly Id[]>, departures: Departures): boolean {
    const witness = this.witnesses.get(s);
    if (!witness || s.scope !== scope.root || s.domain !== scope.domain) return false;
    const { inputs, outputs } = witness;
    const names = new Set(scope.entries.map(e => e.backing));
    for (const note of [...inputs, ...outputs]) {
      if (this.notes.get(note.cm) !== note || note.domain !== scope.domain || note.value < 0n || note.value >= 1n << 64n) return false;
      if (!departures.ignoreScope && !names.has(note.backing)) return false; // padding too
    }
    if (inputs.length !== s.anchors.length) return false;
    for (let i = 0; i < inputs.length; i++) {
      const leaves = roots.get(s.anchors[i]!);
      if (!leaves || (inputs[i]!.value > 0n && !leaves.includes(inputs[i]!.cm))) return false;
    }
    if (s.kind === "issue") {
      return inputs.length === 0 && outputs.length === 1 && witness.signedByK && s.lit !== undefined &&
        s.lit.quantity > 0n && outputs[0]!.backing === s.lit.backing && outputs[0]!.value === s.lit.quantity;
    }
    if (inputs.length !== 2 || outputs.length !== (s.kind === "spend" ? 2 : 1)) return false;
    const delta = new Map<Id, bigint>();
    for (const note of inputs) delta.set(note.backing, (delta.get(note.backing) ?? 0n) + note.value);
    for (const note of outputs) delta.set(note.backing, (delta.get(note.backing) ?? 0n) - note.value);
    if (s.kind === "burn") {
      if (!s.lit || s.lit.quantity <= 0n || ![...inputs, ...outputs].every(n => n.backing === s.lit!.backing)) return false;
      delta.set(s.lit.backing, (delta.get(s.lit.backing) ?? 0n) - s.lit.quantity);
    } else if (s.lit !== undefined) return false;
    return [...delta.values()].every(n => n === 0n);
  }

  /** Test-only semantic observer; service/record never route with this data. */
  opening(cm: Id): Note { return this.notes.get(cm)!; }
}

export interface Event { readonly id: Id; readonly statement: Statement }
export interface State {
  readonly events: Map<Id, Event>;
  readonly roots: Map<Id, readonly Id[]>;
  readonly spent: Set<Id>;
  readonly outputs: Set<Id>;
  readonly totals: Map<Id, bigint>;
}
function empty(): State { return { events: new Map(), roots: new Map([["empty", []]]), spent: new Set(), outputs: new Set(), totals: new Map() }; }
function copy(state: State): State {
  return { events: new Map(state.events), roots: new Map(state.roots), spent: new Set(state.spent),
    outputs: new Set(state.outputs), totals: new Map(state.totals) };
}
function apply(state: State, event: Event, countSharedTwice = false): void {
  const prior = state.events.get(event.id);
  if (prior) {
    requireThat(prior.statement.id === event.statement.id, "conflicting segment prefix");
    if (!countSharedTwice) return;
  }
  const s = event.statement;
  if (!prior) {
    requireThat(new Set(s.nullifiers).size === s.nullifiers.length && !s.nullifiers.some(n => state.spent.has(n)), "spent conflict");
    requireThat(new Set(s.outputs).size === s.outputs.length && !s.outputs.some(n => state.outputs.has(n)), "output conflict");
  }
  for (const nf of s.nullifiers) state.spent.add(nf);
  for (const cm of s.outputs) state.outputs.add(cm);
  if (s.lit) {
    const before = state.totals.get(s.lit.backing) ?? 0n;
    const after = before + (s.kind === "issue" ? s.lit.quantity : -s.lit.quantity);
    requireThat(after >= 0n && after < 1n << 64n, "supply bound");
    state.totals.set(s.lit.backing, after);
  }
  state.events.set(event.id, event);
}

export interface Checkpoint {
  readonly id: Id;
  readonly operator: Id;
  readonly sequence: bigint;
  readonly signedAt: bigint;
  readonly segment: Id;
  readonly scope: Scope;
  readonly openings: readonly (readonly [Id, Id | null])[];
  readonly events: readonly Event[];
  readonly carries: readonly Id[];
}
interface Recorded { readonly checkpoint: Checkpoint; readonly at: bigint; readonly status: "final" | "lapsed" | "invalid"; readonly state?: State }
export interface Receipt { readonly segment: Id; readonly statement: Id; readonly position: bigint; readonly after: bigint; readonly operator: Id }

export class World {
  now = 0n;
  readonly oracle = new ProofOracle();
  readonly records: Recorded[] = [];
  readonly withheld = new Set<Id>();
  readonly withheldDirectories = new Set<Id>();
  readonly withheldScopes = new Set<Id>();
  /** An adversary's scope preimage beside the ideal signed checkpoint. */
  readonly shownScopes = new Map<Id, Scope>();
  private readonly chains = new Map<Id, Term[]>();
  private readonly domains = new Map<Id, Id>();
  private readonly highestSigned = new Map<Id, bigint>();
  private readonly inFlight = new Map<Id, Checkpoint>();
  private readonly signatures = new Set<Checkpoint>();
  private readonly latest = new Map<Id, Id>();
  private readonly services = new Map<Id, Service>();
  private serial = 0n;

  constructor(readonly lag = 1n, readonly departures: Departures = {}) {}
  register(backing: Id, operator: Id, domain = "D"): void {
    requireThat(!this.chains.has(backing), "duplicate backing");
    this.chains.set(backing, [Object.freeze({ backing, operator, link: `genesis:${backing}`, from: 0n })]);
    this.domains.set(backing, domain);
  }
  tick(n = 1n): void { requireThat(n > 0n, "clock"); this.now += n; }
  replace(backing: Id, operator: Id, effective = this.now + 2n * this.lag + 1n): void {
    const chain = this.chains.get(backing)!;
    requireThat(effective >= this.now + 2n * this.lag + 1n && effective > chain.at(-1)!.from, "lead floor");
    chain.push(Object.freeze({ backing, operator, link: `term${++this.serial}`, from: effective }));
  }
  term(backing: Id, at = this.now): Term {
    return this.chains.get(backing)!.filter(t => t.from <= at).at(-1)!;
  }
  current(scope: Scope, at = this.now): boolean {
    return scope.entries.every(e => { const current = this.term(e.backing, at); return current.operator === scope.operator && current.link === e.link; });
  }
  /** C2.10.9: only the currently held terms can supply a service deadline. */
  boundaries(scope: Scope): readonly bigint[] {
    requireThat(this.current(scope), "scope term ended");
    return scope.entries.flatMap(e => {
      const next = this.chains.get(e.backing)!.find(t => t.from > this.now);
      return next === undefined ? [] : [next.from];
    });
  }
  latestFor(backing: Id): Id | null { return this.latest.get(backing) ?? null; }
  /** Current record selection for constructing an opening, without a child
   * signature. The model's signed counter bounds every held sequence. */
  currentFor(backing: Id, operator: Id): Id | null {
    requireThat(this.term(backing).operator === operator, "wrong operator");
    return this.predecessorFor(backing, { operator, at: this.now, sequence: (this.highestSigned.get(operator) ?? 0n) + 1n });
  }
  /**
   * C2.7.1–3 / C2.10.4: refine the state's latest-carrying oracle with exact
   * evidence descent. Select a candidate BEFORE replay, never by replay's
   * verdict. Model enumeration stands for the venue's bounded predecessor
   * index; the runtime walks held records within each replacement term.
   */
  predecessorFor(backing: Id, child: { readonly operator: Id; readonly sequence: bigint; readonly at: bigint }): Id | null {
    requireThat(child.at <= this.now && child.at >= 0n, "child index");
    const eligible = this.records.filter(r => r.at < child.at ||
      (!this.departures.skipSameIndex && r.at === child.at && r.checkpoint.operator === child.operator && r.checkpoint.sequence < child.sequence));
    for (const record of [...eligible].reverse()) {
      const c = record.checkpoint;
      if (this.term(backing, record.at).operator !== c.operator) continue;
      if (this.withheldDirectories.has(c.id)) {
        if (this.departures.skipUnprovenSteps) continue;
        throw new Refusal("unavailable directory");
      }
      if (!c.carries.includes(backing)) continue; // ideal authenticated absence
      if (this.withheldScopes.has(c.id)) {
        if (this.departures.skipUnprovenSteps) continue;
        throw new Refusal("unavailable scope");
      }
      const scope = this.shownScopes.get(c.id) ?? c.scope;
      requireThat(this.departures.trustShownScope === true || scope === c.scope, "unauthenticated scope");
      requireThat(scope.entries.length > 0 && scope.operator === c.operator &&
        scope.entries.some(e => e.backing === backing), "scope shape");
      const terms = scope.entries.map(e => {
        const chain = this.chains.get(e.backing);
        const i = chain?.findIndex(t => t.link === e.link && t.from === e.from && t.operator === scope.operator) ?? -1;
        requireThat(i >= 0 && this.domains.get(e.backing) === scope.domain, "scope term");
        return { from: chain![i]!.from, until: chain![i + 1]?.from };
      });
      if (terms.some(t => t.until !== undefined && t.until <= record.at)) continue;
      requireThat(terms.every(t => t.from <= record.at), "scope not in force");
      if (this.departures.skipLiveInvalid && record.status === "invalid") continue;
      return c.id; // missing/invalid statements still select this candidate
    }
    return null;
  }
  record(id: Id): Recorded { const record = this.records.find(r => r.checkpoint.id === id); requireThat(record !== undefined, "checkpoint not held"); return record; }
  import(id: Id, checked = new Set<Id>()): State {
    requireThat(!this.withheld.has(id), "unavailable history");
    const record = this.record(id);
    requireThat(record.status === "final" && record.state !== undefined, "not finalized");
    if (!checked.has(id)) {
      checked.add(id);
      for (const [, parent] of record.checkpoint.openings) if (parent !== null) this.import(parent, checked);
    }
    return copy(record.state);
  }
  merge(openings: ReadonlyMap<Id, Id | null>): State {
    const result = empty();
    for (const id of new Set(openings.values())) {
      if (id === null) continue;
      const state = this.import(id);
      for (const event of state.events.values()) apply(result, event, this.departures.countSharedTwice);
      for (const [root, leaves] of state.roots) result.roots.set(root, leaves);
    }
    if (this.departures.forgetSpent) result.spent.clear();
    return result;
  }
  open(operator: Id, names: readonly Id[], domain = "D", override?: ReadonlyMap<Id, Id | null>): Service {
    const previousService = this.services.get(operator);
    if (previousService && this.current(previousService.scope)) requireThat(previousService.finalized(), "live tail before scope change");
    requireThat(names.length > 0 && new Set(names).size === names.length, "scope shape");
    requireThat(names.every(b => this.domains.get(b) === domain), "wrong construction domain");
    const entries = [...names].sort().map(b => this.term(b));
    const scope: Scope = Object.freeze({ operator, domain, entries: Object.freeze(entries), root: `scope${++this.serial}` });
    requireThat(this.current(scope), "wrong operator");
    const openings = new Map(entries.map(e => [e.backing, override?.get(e.backing) ?? this.currentFor(e.backing, operator)]));
    if (override) for (const [name, id] of override) openings.set(name, id);
    requireThat(same([...openings.keys()].sort(), entries.map(e => e.backing)), "opening scope mismatch");
    if (!this.departures.ignorePredecessor) for (const e of entries) requireThat(openings.get(e.backing) === this.latestFor(e.backing), "stale predecessor");
    for (const parent of new Set(openings.values())) if (parent !== null) {
      const record = this.record(parent);
      requireThat(record.checkpoint.scope.domain === domain, "wrong construction domain");
      requireThat(record.at < this.now || (record.at === this.now && record.checkpoint.operator === operator), "causal rank");
    }
    const service = new Service(this, `segment${++this.serial}`, scope, openings, this.merge(openings));
    this.services.set(operator, service);
    return service;
  }
  // Model of the operator's durable actor journal, not a protocol authority.
  active(service: Service): boolean { return this.services.get(service.scope.operator) === service; }
  resume(source: Service, resumed: Service): void {
    requireThat(this.active(source), "retired journal");
    this.services.set(source.scope.operator, resumed);
  }
  free(operator: Id): boolean {
    const pending = this.inFlight.get(operator);
    return !pending || this.records.some(r => r.checkpoint === pending) || this.now >= pending.signedAt + this.lag;
  }
  sign(service: Service, carries: readonly Id[] = service.scope.entries.map(e => e.backing)): Checkpoint {
    requireThat(this.free(service.scope.operator), "one in flight");
    const sequence = (this.highestSigned.get(service.scope.operator) ?? 0n) + 1n;
    this.highestSigned.set(service.scope.operator, sequence);
    const checkpoint = Object.freeze({ id: `checkpoint${++this.serial}`, operator: service.scope.operator, sequence,
      signedAt: this.now, segment: service.id,
      scope: Object.freeze({ ...service.scope, entries: Object.freeze(service.scope.entries.map(e => Object.freeze({ ...e }))) }),
      openings: Object.freeze([...service.openings].map(([b, id]) => Object.freeze([b, id] as const))),
      events: Object.freeze(service.events.map(e => Object.freeze({ ...e }))), carries: Object.freeze([...carries].sort()) });
    this.signatures.add(checkpoint); this.inFlight.set(checkpoint.operator, checkpoint);
    return checkpoint;
  }
  include(checkpoint: Checkpoint): Recorded["status"] {
    requireThat(this.signatures.has(checkpoint), "not signed");
    requireThat(this.now >= checkpoint.signedAt + this.lag, "too early");
    const prior = this.records.filter(r => r.checkpoint.operator === checkpoint.operator).at(-1);
    requireThat(!prior || prior.checkpoint.sequence < checkpoint.sequence, "sequence moved past");
    const selected = checkpoint.scope.entries.filter(e => checkpoint.carries.includes(e.backing));
    try {
      const names = checkpoint.scope.entries.map(e => e.backing);
      requireThat(names.length > 0 && new Set(names).size === names.length && same(names, [...names].sort()), "scope shape");
      requireThat(checkpoint.operator === checkpoint.scope.operator, "scope operator");
      requireThat(checkpoint.scope.entries.every(e => e.operator === checkpoint.operator), "scope operator");
      requireThat(checkpoint.scope.entries.every(e => this.chains.get(e.backing)?.some(t =>
        t.link === e.link && t.operator === e.operator && t.from === e.from) === true), "scope term");
      requireThat(names.every(b => this.domains.get(b) === checkpoint.scope.domain), "wrong construction domain");
      requireThat(same(checkpoint.openings.map(([b]) => b), names), "opening scope mismatch");
      const known = this.records.find(r => r.checkpoint.segment === checkpoint.segment)?.checkpoint;
      if (known) requireThat(known.scope.root === checkpoint.scope.root && known.scope.domain === checkpoint.scope.domain &&
        known.operator === checkpoint.operator && known.scope.entries.length === checkpoint.scope.entries.length &&
        known.scope.entries.every((e, i) => { const other = checkpoint.scope.entries[i]!;
          return e.backing === other.backing && e.link === other.link && e.operator === other.operator && e.from === other.from; }) &&
        known.openings.length === checkpoint.openings.length &&
        known.openings.every(([b, id], i) => checkpoint.openings[i]![0] === b && checkpoint.openings[i]![1] === id), "changed segment header");
      const finalityScope = this.departures.partialFinality ? selected : checkpoint.scope.entries;
      const ended = finalityScope.some(e => {
        const chain = this.chains.get(e.backing)!;
        const next = chain[chain.findIndex(t => t.link === e.link) + 1];
        return next !== undefined && next.from <= this.now;
      });
      if (ended) {
        this.records.push({ checkpoint, at: this.now, status: "lapsed" });
        return "lapsed";
      }
      requireThat(finalityScope.every(e => this.term(e.backing).link === e.link && e.operator === checkpoint.operator), "scope not in force");
      for (const [, parent] of checkpoint.openings) if (parent !== null) {
        const source = this.record(parent);
        requireThat(source.checkpoint.scope.domain === checkpoint.scope.domain, "wrong construction domain");
        requireThat(source.at < this.now || (source.at === this.now && source.checkpoint.operator === checkpoint.operator && source.checkpoint.sequence < checkpoint.sequence), "causal rank");
      }
      if (!this.departures.partialFinality) requireThat(same(checkpoint.carries, checkpoint.scope.entries.map(e => e.backing)), "incomplete scope");
      const previous = this.records.filter(r => r.status === "final" && r.checkpoint.segment === checkpoint.segment).at(-1);
      for (const e of selected) {
        const expected = previous?.checkpoint.id ?? new Map(checkpoint.openings).get(e.backing)!;
        if (!this.departures.ignorePredecessor) requireThat(this.latestFor(e.backing) === expected, "stale continuation");
      }
      if (previous) requireThat(same(previous.checkpoint.events.map(e => e.statement.id), checkpoint.events.slice(0, previous.checkpoint.events.length).map(e => e.statement.id)), "rewritten prefix");
      const state = this.merge(new Map(checkpoint.openings));
      const leaves: Id[] = [];
      state.roots.set(`${checkpoint.segment}:0`, []);
      for (let i = 0; i < checkpoint.events.length; i++) {
        const event = checkpoint.events[i]!;
        requireThat(event.id === `${checkpoint.segment}:${i}` && event.statement.segment === checkpoint.segment, "event position");
        requireThat(this.oracle.verify(event.statement, checkpoint.scope, state.roots, this.departures), "proof");
        apply(state, event);
        leaves.push(...event.statement.outputs);
        state.roots.set(`${checkpoint.segment}:${i + 1}`, Object.freeze([...leaves]));
      }
      const record: Recorded = { checkpoint, at: this.now, status: "final", state };
      this.records.push(record);
      for (const e of selected) this.latest.set(e.backing, checkpoint.id);
      return "final";
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      this.records.push({ checkpoint, at: this.now, status: "invalid" });
      // Live, carrying but invalid evidence blocks the candidate. It cannot
      // silently disappear from the record's latest-state selection.
      for (const e of selected) if (this.chains.has(e.backing) && this.term(e.backing).operator === checkpoint.operator) this.latest.set(e.backing, checkpoint.id);
      return "invalid";
    }
  }
  /** Independent semantic checks over unique final events, using the hidden oracle only here. */
  violations(): string[] {
    const bad: string[] = [], seen = new Map<Id, Id>(), events = new Set<Id>();
    for (const record of this.records) {
      if (record.status !== "final") continue;
      for (const event of record.checkpoint.events) {
        if (events.has(event.id)) continue;
        events.add(event.id);
        for (const nf of event.statement.nullifiers) {
          if (seen.has(nf) && seen.get(nf) !== event.id) bad.push("double spend");
          seen.set(nf, event.id);
        }
        for (const cm of event.statement.outputs) {
          if (this.term(this.oracle.opening(cm).backing, record.at).operator !== record.checkpoint.operator) bad.push("unauthorized backing");
        }
      }
    }
    return [...new Set(bad)];
  }
}

export class Service {
  readonly events: Event[] = [];
  private state: State;
  private readonly leaves: Id[] = [];
  private readonly receipts = new Map<Id, Receipt>();
  private lastSigned: Checkpoint | undefined;
  private resumedAt: bigint | undefined;
  constructor(readonly world: World, readonly id: Id, readonly scope: Scope, readonly openings: ReadonlyMap<Id, Id | null>, state: State) {
    this.state = copy(state); this.state.roots.set(`${id}:0`, []);
  }
  root(): Id { return `${this.id}:${this.events.length}`; }
  view(): State { return copy(this.state); }
  finalized(): boolean {
    if (!this.lastSigned) return this.events.length === 0;
    const record = this.world.records.find(r => r.checkpoint === this.lastSigned);
    return record?.status === "final" && same(record.checkpoint.events.map(e => e.statement.id), this.events.map(e => e.statement.id));
  }
  submit(statement: Statement): Receipt {
    this.ready();
    const prior = this.receipts.get(statement.id);
    if (prior) return prior;
    requireThat(this.lastSigned !== undefined, "commit opening first");
    requireThat(statement.segment === this.id, "wrong segment");
    requireThat(this.world.oracle.verify(statement, this.scope, this.state.roots, this.world.departures), "proof");
    const event = Object.freeze({ id: `${this.id}:${this.events.length}`, statement });
    const next = copy(this.state); apply(next, event);
    this.events.push(event); this.leaves.push(...statement.outputs);
    next.roots.set(this.root(), Object.freeze([...this.leaves])); this.state = next;
    const receipt = Object.freeze({ segment: this.id, statement: statement.id, position: BigInt(this.events.length),
      after: this.lastSigned.sequence, operator: this.scope.operator });
    this.receipts.set(statement.id, receipt);
    return receipt;
  }
  commit(carries?: readonly Id[]): Checkpoint {
    this.ready();
    this.lastSigned = this.world.sign(this, carries);
    return this.lastSigned;
  }
  restart(): Service {
    const resumed = new Service(this.world, this.id, this.scope, new Map(this.openings), this.state);
    resumed.events.push(...this.events); resumed.leaves.push(...this.leaves);
    for (const [id, receipt] of this.receipts) resumed.receipts.set(id, receipt);
    resumed.lastSigned = this.lastSigned; resumed.resumedAt = this.world.now;
    this.world.resume(this, resumed);
    return resumed;
  }
  change(names: readonly Id[]): Service {
    const next = this.world.open(this.scope.operator, names, this.scope.domain);
    if (this.world.departures.retainAbandoned) {
      next.state = copy(this.state); // deliberate counterexample: an abandoned old-scope root survives
    }
    return next;
  }
  private ready(): void {
    requireThat(this.world.active(this), "retired journal");
    requireThat(this.resumedAt === undefined || this.world.now >= this.resumedAt + this.world.lag, "restart lag");
    requireThat(this.world.current(this.scope), "scope term ended");
    for (const e of this.scope.entries) {
      const latest = this.world.latestFor(e.backing);
      const record = latest === null ? undefined : this.world.record(latest);
      requireThat(record?.status !== "invalid", "invalid current evidence");
      if (!this.world.departures.ignorePredecessor) requireThat(latest === this.openings.get(e.backing) || record?.checkpoint.segment === this.id, "stale service");
      if (record?.checkpoint.segment === this.id) requireThat(
        same(record.checkpoint.events.map(e => e.statement.id), this.events.slice(0, record.checkpoint.events.length).map(e => e.statement.id)), "superseded twin");
    }
  }
}
