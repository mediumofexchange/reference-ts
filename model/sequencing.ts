// An executable model of Construction §C2 (sequencing) and §C2b (failure,
// silence, recovery) over the shielded pool's notes.
//
// The claim layer is abstracted: a statement carries one nullifier and is
// assumed to verify; what the model exercises is ordering, witnessing,
// commitments and their directory, replacement, takeover and restart — the
// rules whose interleavings a unit test over the implementation's own
// decomposition does not explore. An adversary schedules everything the rules
// leave open: when the venue includes or drops a publication (never earlier
// than the lag, C2.3.5), when holders submit, when the rule-holder replaces an
// operator and with what lead, when an operator crashes, restarts or goes dark,
// and which committed states are withheld. Operators are honest and follow the
// rules as written; the properties in `check` are what the specification says
// honest conduct buys. A knob that departs from a rule (`leadFloor`,
// `restartFrom`) exists to show the counterexample the rule exists to close.
//
// Rules are cited by number. Where the model had to choose a reading of a rule,
// the comment says so and `sequencing.test.ts` exercises both readings.

export type Key = string;
export type BackingId = string;
export type Index = number;

export interface Statement {
  readonly id: string;
  readonly backing: BackingId;
  readonly nullifier: string;
}

/** A commitment with its directory (C2.4.2): each carried backing and the history it stands on. */
export interface Commitment {
  readonly kind: "commitment";
  readonly name: string;
  readonly op: Key;
  readonly seq: number;
  readonly signedAt: Index;
  readonly carries: ReadonlyMap<BackingId, readonly string[]>;
}

/** A replacement (C2.5.1): role, successor, effective index and the link it replaces. */
export interface Replacement {
  readonly kind: "replacement";
  readonly name: string;
  readonly backing: BackingId;
  readonly successor: Key;
  readonly effective: Index;
  readonly replaces: string;
}

export type Record = Commitment | Replacement;

export interface Witnessed<R extends Record = Record> {
  readonly record: R;
  readonly index: Index;
}

export type Answer = { holds: Index } | { notReached: true } | { movedPast: true };

// ---------------------------------------------------------------------------
// The venue (C2.3)

export class Venue {
  height: Index = 0;
  /** Bumps whenever the record changes, so readers can memoize against it. */
  version = 0;
  private readonly held: Witnessed[] = [];
  readonly pending: { record: Record; publishedAt: Index; id: number }[] = [];
  private nextId = 0;

  constructor(readonly lag: number) {}

  tick(): void {
    this.height += 1;
  }

  publish(record: Record): number {
    const id = this.nextId++;
    this.pending.push({ record, publishedAt: this.height, id });
    return id;
  }

  /** The adversary includes a pending record at the current height, never before the lag (C2.3.5). */
  include(id: number): boolean {
    const i = this.pending.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const p = this.pending[i]!;
    if (this.height < p.publishedAt + this.lag) return false;
    this.pending.splice(i, 1);
    if (p.record.kind === "commitment" && p.record.seq <= this.highestSeq(p.record.op)) {
      // C2.3.3: the record keeps only what strictly extends; a stepped-over sequence was never held.
      return true;
    }
    this.held.push({ record: p.record, index: this.height });
    this.version += 1;
    return true;
  }

  /** The adversary drops a pending record: the chain never takes it. */
  drop(id: number): boolean {
    const i = this.pending.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    return true;
  }

  isPending(name: string): boolean {
    return this.pending.some((p) => p.record.name === name);
  }

  shown(name: string): Witnessed | undefined {
    return this.held.find((w) => w.record.name === name);
  }

  highestSeq(op: Key): number {
    let h = 0;
    for (const w of this.held) if (w.record.kind === "commitment" && w.record.op === op && w.record.seq > h) h = w.record.seq;
    return h;
  }

  commitments(): Witnessed<Commitment>[] {
    return this.held.filter((w): w is Witnessed<Commitment> => w.record.kind === "commitment");
  }

  commitmentsFor(op: Key): Witnessed<Commitment>[] {
    return this.commitments().filter((w) => w.record.op === op);
  }

  replacementsFor(backing: BackingId): Witnessed<Replacement>[] {
    return this.held.filter(
      (w): w is Witnessed<Replacement> => w.record.kind === "replacement" && w.record.backing === backing,
    );
  }

  /** C2.3.4: the record answers an exact sequence. */
  answer(op: Key, seq: number): Answer {
    for (const w of this.commitmentsFor(op)) if (w.record.seq === seq) return { holds: w.index };
    return seq > this.highestSeq(op) ? { notReached: true } : { movedPast: true };
  }
}

// ---------------------------------------------------------------------------
// The replacement chain (C2.5)

export interface Link {
  readonly name: string;
  readonly op: Key;
  readonly force: Index;
}

export class Chains {
  /**
   * `leadFloor` is C2.5.3's `2·lag + 1` by default. Lower values are a departure
   * from the rule, kept so the test can show what the floor closes.
   */
  constructor(
    private readonly venue: Venue,
    private readonly genesis: ReadonlyMap<BackingId, Key>,
    readonly leadFloor: number = 2 * venue.lag + 1,
  ) {}

  /** Valid replacements of one link: C2.5.3 (the floor) and C2.5.4 (strictly later, revocation excepted). */
  private candidates(backing: BackingId, link: Link): Witnessed<Replacement>[] {
    return this.venue.replacementsFor(backing).filter(
      (w) =>
        w.record.replaces === link.name &&
        w.record.effective >= w.index + this.leadFloor &&
        (w.record.successor === link.op || w.record.effective > link.force),
    );
  }

  /** C2.5.5: which of several replacements of one link wins. */
  private winner(cands: Witnessed<Replacement>[]): Witnessed<Replacement> | undefined {
    const sorted = [...cands].sort((a, b) => a.index - b.index || (a.record.name < b.record.name ? -1 : 1));
    let w: Witnessed<Replacement> | undefined;
    for (const c of sorted) {
      if (!w) w = c;
      else if (c.index > w.index && c.index < w.record.effective) w = c;
    }
    return w;
  }

  private readonly memo = new Map<string, { chain: Link[]; pending?: Witnessed<Replacement> }>();
  private memoVersion = -1;

  /** The links in force up to `index`, and the pending next link where one is witnessed. */
  links(backing: BackingId, index: Index): { chain: Link[]; pending?: Witnessed<Replacement> } {
    if (this.memoVersion !== this.venue.version) {
      this.memo.clear();
      this.memoVersion = this.venue.version;
    }
    const key = `${backing}@${index}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const chain: Link[] = [{ name: "genesis", op: this.genesis.get(backing)!, force: 0 }];
    let result: { chain: Link[]; pending?: Witnessed<Replacement> };
    for (;;) {
      const cur = chain[chain.length - 1]!;
      const win = this.winner(this.candidates(backing, cur));
      if (!win) {
        result = { chain };
        break;
      }
      if (win.record.effective > index) {
        result = { chain, pending: win };
        break;
      }
      chain.push({ name: win.record.name, op: win.record.successor, force: win.record.effective });
    }
    this.memo.set(key, result);
    return result;
  }

  inForce(backing: BackingId, index: Index): Link {
    const { chain } = this.links(backing, index);
    return chain[chain.length - 1]!;
  }

  pendingHandover(backing: BackingId, index: Index): Witnessed<Replacement> | undefined {
    return this.links(backing, index).pending;
  }
}

// ---------------------------------------------------------------------------
// Served states, and who can obtain them

/** Where committed states live. The adversary may withhold one (C2.7.2: unavailable evidence, not fault). */
export class Store {
  private readonly states = new Map<string, Commitment>();
  private readonly withheld = new Set<string>();
  put(c: Commitment): void {
    this.states.set(c.name, c);
  }
  withhold(name: string): void {
    this.withheld.add(name);
  }
  get(name: string): Commitment | undefined {
    return this.withheld.has(name) ? undefined : this.states.get(name);
  }
}

// ---------------------------------------------------------------------------
// An honest operator (C2.4, C2.6, C2.7, C2.8, C2b.4)

export interface Receipt {
  readonly statement: Statement;
  readonly op: Key;
  /** The commitment the operator last signed when it co-signed, or null on the empty book (C2b.4). */
  readonly after: string | null;
  readonly afterSeq: number;
  /** The force index of the link the operator served under (C2.5.8). */
  readonly term: Index;
  readonly at: Index;
}

export type RestartFrom = "signed" | "witnessed";

export class Operator {
  readonly books = new Map<BackingId, string[]>();
  /** The commitment each book stands on (C2.7.5), or null for the empty book. */
  readonly pins = new Map<BackingId, string | null>();
  readonly spent = new Set<string>();
  /** Durable journal: every commitment this key has signed (C2.8). */
  readonly signed: Commitment[] = [];
  highestSigned = 0;
  inFlight: Commitment | null = null;
  dark = false;
  crashed = false;
  private resumedAt: Index | null = null;
  /** C2b.4: backings on which this key must commit before it co-signs again. */
  private readonly mustCommitFirst = new Set<BackingId>();
  private readonly termsCommitted = new Set<string>();

  constructor(
    readonly key: Key,
    private readonly venue: Venue,
    private readonly chains: Chains,
    private readonly store: Store,
    private readonly statements: ReadonlyMap<string, Statement>,
    /**
     * C2.8.1 as written says "own latest witnessed commitment". Reading it as
     * "own latest signed commitment", which C2.4.4 makes the book the operator
     * actually holds, is the `signed` mode; the test shows what `witnessed` costs.
     */
    private readonly restartFrom: RestartFrom = "signed",
  ) {}

  register(backing: BackingId): void {
    if (!this.books.has(backing)) {
      this.books.set(backing, []);
      this.pins.set(backing, null);
    }
  }

  /** C2.7.1: the record's latest commitment carrying `backing`, by a party in force at its witnessed index. */
  latestCarrying(backing: BackingId): Witnessed<Commitment> | undefined {
    let best: Witnessed<Commitment> | undefined;
    for (const w of this.venue.commitments()) {
      if (!w.record.carries.has(backing)) continue;
      if (this.chains.inForce(backing, w.index).op !== w.record.op) continue;
      if (!best || w.index > best.index || (w.index === best.index && w.record.seq > best.record.seq)) best = w;
    }
    return best;
  }

  /** C2.7.5 currency: the pin matches the record's latest carrying commitment, or this key's own published-and-unread one (C2.4.4). */
  current(backing: BackingId): boolean {
    if (!this.books.has(backing)) return false;
    const pin = this.pins.get(backing) ?? null;
    const latest = this.latestCarrying(backing);
    if (pin === (latest?.record.name ?? null)) return true;
    return (
      this.inFlight !== null &&
      this.inFlight.name === pin &&
      this.inFlight.carries.has(backing) &&
      this.venue.isPending(this.inFlight.name)
    );
  }

  /** The next clock at which this operator is free to sign a commitment (C2.4.3). */
  nextFree(now: Index): Index {
    if (!this.inFlight || this.venue.shown(this.inFlight.name)) return now;
    return Math.max(now, this.inFlight.signedAt + this.venue.lag);
  }

  /** Whether this operator co-signs on `backing` now. */
  serves(backing: BackingId, now: Index): boolean {
    if (this.dark) return false;
    if (this.resumedAt !== null && now < this.resumedAt + this.venue.lag) return false; // C2.8.2, applied to co-signing too (see the test)
    if (this.mustCommitFirst.has(backing)) return false; // C2b.4: returning from silence is committing
    const link = this.chains.inForce(backing, now);
    if (link.op !== this.key) return false;
    if (link.force > 0 && !this.termsCommitted.has(`${backing}:${link.force}`)) return false; // C2.7.4: a key seated anew commits first
    const pending = this.chains.pendingHandover(backing, now);
    if (pending) {
      // C2.6.1: co-sign nothing once the lag reaches the effective index, and nothing this key
      // can no longer commit inside its term — a refusal, never a dead receipt.
      const e = pending.record.effective;
      if (now + this.venue.lag >= e) return false;
      if (this.nextFree(now) > e - this.venue.lag - 1) return false;
    }
    return this.current(backing);
  }

  submit(stmt: Statement, now: Index): Receipt | { refused: string } {
    if (!this.serves(stmt.backing, now)) return { refused: "not serving" };
    if (this.spent.has(stmt.nullifier)) return { refused: "spent" };
    this.books.get(stmt.backing)!.push(stmt.id);
    this.spent.add(stmt.nullifier);
    return {
      statement: stmt,
      op: this.key,
      after: this.inFlight?.name ?? this.signed[this.signed.length - 1]?.name ?? null,
      afterSeq: this.highestSigned,
      term: this.chains.inForce(stmt.backing, now).force,
      at: now,
    };
  }

  canCommit(now: Index): boolean {
    if (this.dark) return false;
    if (this.resumedAt !== null && now < this.resumedAt + this.venue.lag) return false; // C2.8.2
    return this.nextFree(now) <= now; // C2.4.3: one commitment in flight
  }

  /** Honest schedule: commit when free, but keep the clock C2.6.1 needs — the last clock whose commitment still lands in term. */
  wantsToCommit(now: Index): boolean {
    if (!this.canCommit(now)) return false;
    if (this.mustCommitFirst.size) return true;
    let hold = false;
    for (const backing of this.books.keys()) {
      if (this.chains.inForce(backing, now).op !== this.key) continue;
      const pending = this.chains.pendingHandover(backing, now);
      if (!pending) continue;
      const last = pending.record.effective - this.venue.lag - 1;
      if (now === last) return true;
      if (now > last - this.venue.lag && now < last) hold = true; // signing now would leave this key busy at `last`
    }
    return !hold;
  }

  commit(now: Index): Commitment | undefined {
    if (!this.canCommit(now)) return undefined;
    const carries = new Map<BackingId, readonly string[]>();
    for (const [backing, book] of this.books) {
      if (this.chains.inForce(backing, now).op !== this.key) continue;
      if (!this.current(backing)) continue; // a stale book is taken over, never committed (C2.7.5)
      carries.set(backing, [...book]);
    }
    const seq = this.highestSigned + 1; // C2.4.1: one past the highest this key has signed
    const c: Commitment = { kind: "commitment", name: `${this.key}#${seq}`, op: this.key, seq, signedAt: now, carries };
    this.highestSigned = seq;
    this.inFlight = c;
    this.signed.push(c);
    this.store.put(c);
    for (const backing of carries.keys()) {
      this.pins.set(backing, c.name);
      this.termsCommitted.add(`${backing}:${this.chains.inForce(backing, now).force}`);
      this.mustCommitFirst.delete(backing);
    }
    this.venue.publish(c);
    return c;
  }

  /** C2.7: open a book from the record. */
  takeOver(backing: BackingId, now: Index): "not-in-force" | "current" | "seated" | "empty" | "stranded" {
    this.register(backing);
    if (this.chains.inForce(backing, now).op !== this.key) return "not-in-force";
    if (this.current(backing)) return "current";
    const latest = this.latestCarrying(backing);
    if (!latest) {
      this.books.set(backing, []); // C2.7.3: the empty book
      this.pins.set(backing, null);
      this.rebuildSpent();
      return "empty";
    }
    // C2.7.2: the directories of every later commitment are in the record; the opening state itself must be served.
    const content = this.store.get(latest.record.name);
    if (!content) return "stranded";
    this.books.set(backing, [...content.carries.get(backing)!]);
    this.pins.set(backing, latest.record.name);
    this.rebuildSpent();
    return "seated";
  }

  private rebuildSpent(): void {
    this.spent.clear();
    for (const book of this.books.values()) for (const id of book) this.spent.add(this.statements.get(id)!.nullifier);
  }

  /**
   * The process dies. What survives is the journal: every signed commitment
   * and — in the `signed` mode — every co-signed statement, since a receipt is
   * exposed only after its statement is durable. The `witnessed` mode drops the
   * uncommitted tail, which is C2.8.1 read literally; the test shows the cost.
   */
  crash(): void {
    this.inFlight = null;
    this.dark = true;
    this.crashed = true;
  }

  /** C2.8: resume, and commit nothing until the lag has passed. */
  restart(now: Index, backings: readonly BackingId[]): void {
    this.dark = false;
    this.crashed = false;
    this.resumedAt = now;
    for (const b of backings) this.register(b);
    const last = this.signed[this.signed.length - 1];
    if (this.restartFrom === "signed") {
      // Books and pins are the durable journal and survive; only the in-flight question is re-read.
      if (last) this.inFlight = this.venue.shown(last.name) ? null : last;
    } else {
      const shown = this.venue.commitmentsFor(this.key);
      const from = shown[shown.length - 1]?.record;
      for (const b of this.books.keys()) {
        this.books.set(b, from ? [...(from.carries.get(b) ?? [])] : []);
        this.pins.set(b, from && from.carries.has(b) ? from.name : null);
      }
      this.inFlight = null;
    }
    this.rebuildSpent();
  }

  goDark(): void {
    this.dark = true;
  }

  /** C2b.4: returning from silence is committing, per backing. */
  returnFromSilence(): void {
    this.dark = false;
    for (const b of this.books.keys()) this.mustCommitFirst.add(b);
  }
}

// ---------------------------------------------------------------------------
// The model: parties, adversary, properties

export interface Config {
  readonly lag: number;
  /** C2.5.3's floor by default; lower to show the same-block erasure. */
  readonly leadFloor?: number;
  /** Longest inclusion delay the adversary may impose (≥ lag). C2.3.5 bounds it below only. */
  readonly maxDelay: number;
  readonly drops: boolean;
  readonly crashes: boolean;
  readonly darkness: boolean;
  readonly replacements: boolean;
  readonly withholding: boolean;
  readonly restartFrom?: RestartFrom;
  readonly steps: number;
}

export interface Violation {
  readonly property: string;
  readonly detail: string;
}

export class Model {
  readonly venue: Venue;
  readonly chains: Chains;
  readonly store = new Store();
  readonly statements = new Map<string, Statement>();
  readonly ops: Operator[];
  readonly backings: BackingId[] = ["A", "B"];
  readonly receipts: Receipt[] = [];
  readonly refusals: { statement: Statement; reason: string; at: Index }[] = [];
  readonly trace: string[] = [];
  private nextStmt = 0;
  private nextReplacement = 0;
  private readonly rng: () => number;
  /** The clean setting under which every receipt must end final. */
  readonly clean: boolean;

  constructor(readonly config: Config, seed: number) {
    this.rng = mulberry32(seed);
    this.clean =
      config.maxDelay === config.lag && !config.drops && !config.crashes && !config.darkness && !config.withholding;
    this.venue = new Venue(config.lag);
    const genesis = new Map<BackingId, Key>([["A", "op1"], ["B", "op1"]]);
    this.chains = new Chains(this.venue, genesis, config.leadFloor ?? 2 * config.lag + 1);
    this.ops = ["op1", "op2"].map(
      (k) => new Operator(k, this.venue, this.chains, this.store, this.statements, config.restartFrom ?? "signed"),
    );
    for (const b of this.backings) this.ops[0]!.register(b);
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rng() * xs.length)]!;
  }

  private log(s: string): void {
    this.trace.push(`@${this.venue.height} ${s}`);
  }

  /**
   * A block: the height advances and the adversary decides, for every pending
   * record old enough (C2.3.5), whether this block carries it, drops it, or
   * leaves it for a later one — never later than `maxDelay`. Operators act
   * after the block, so what is witnessed at a height is visible at it.
   */
  private block(): void {
    this.venue.tick();
    const h = this.venue.height;
    for (const p of [...this.venue.pending]) {
      const age = h - p.publishedAt;
      if (age < this.venue.lag) continue;
      const r = this.rng();
      if (this.config.drops && r < 0.15) {
        this.venue.drop(p.id);
        this.log(`drop ${p.record.name}`);
      } else if (age >= this.config.maxDelay || r < 0.6) {
        this.venue.include(p.id);
        this.log(`include ${p.record.name}`);
      }
    }
  }

  /** One adversary step, then every honest operator acts. */
  step(): void {
    const block = () => this.block();
    const actions: (() => void)[] = [block, block, block];
    for (const b of this.backings) actions.push(() => this.submit(b, false));
    if (this.receipts.length) actions.push(() => this.submit(this.pick(this.backings), true));
    if (this.config.replacements) actions.push(() => this.replace());
    if (this.config.crashes) actions.push(() => this.crashOne());
    if (this.config.darkness) actions.push(() => this.darkOne());
    if (this.config.withholding) actions.push(() => this.withholdOne());
    this.pick(actions)();
    for (const op of this.ops) this.act(op);
  }

  private act(op: Operator): void {
    const now = this.venue.height;
    if (op.dark) {
      // A crashed or dark operator returns on the adversary's clock.
      if (this.rng() < 0.4) {
        if (op.crashed) {
          op.restart(now, this.backings);
          this.log(`${op.key} restarts`);
        } else {
          op.returnFromSilence();
          this.log(`${op.key} returns from silence`);
        }
      }
      return;
    }
    for (const b of this.backings) {
      if (this.chains.inForce(b, now).op === op.key && !op.current(b)) {
        const r = op.takeOver(b, now);
        this.log(`${op.key} takeOver ${b}: ${r}`);
      }
    }
    if (op.wantsToCommit(now)) {
      const c = op.commit(now);
      if (c) this.log(`${op.key} commits ${c.name} carrying ${[...c.carries.keys()].join(",") || "nothing"}`);
    }
  }

  private submit(backing: BackingId, doubleSpend: boolean): void {
    const now = this.venue.height;
    let stmt: Statement;
    if (doubleSpend) {
      const prior = this.pick(this.receipts).statement;
      stmt = { id: `s${this.nextStmt++}`, backing: prior.backing, nullifier: prior.nullifier };
    } else {
      const id = `s${this.nextStmt++}`;
      stmt = { id, backing, nullifier: `n:${id}` };
    }
    this.statements.set(stmt.id, stmt);
    const op = this.ops.find((o) => o.key === this.chains.inForce(stmt.backing, now).op)!;
    const r = op.submit(stmt, now);
    if ("refused" in r) {
      this.refusals.push({ statement: stmt, reason: r.refused, at: now });
      this.log(`${op.key} refuses ${stmt.id} (${r.refused})`);
    } else {
      this.receipts.push(r);
      this.log(`${op.key} accepts ${stmt.id} on ${stmt.backing} after ${r.after ?? "genesis"}`);
    }
  }

  private replace(): void {
    const now = this.venue.height;
    const backing = this.pick(this.backings);
    const { chain, pending } = this.chains.links(backing, now);
    const link = chain[chain.length - 1]!;
    const target = pending && this.rng() < 0.5 ? { name: pending.record.name, op: pending.record.successor } : link;
    const successor = this.pick(this.ops.map((o) => o.key));
    const floor = this.chains.leadFloor;
    const lead = floor + Math.floor(this.rng() * 3) + this.venue.lag; // lands at ≥ now+lag; effective measured from witnessing
    const rep: Replacement = {
      kind: "replacement",
      name: `r${this.nextReplacement++}`,
      backing,
      successor,
      effective: now + lead,
      replaces: target.name,
    };
    this.venue.publish(rep);
    this.log(`rule-holder publishes ${rep.name}: ${backing} → ${successor} at ${rep.effective}, replacing ${target.name}`);
  }

  private crashOne(): void {
    const op = this.pick(this.ops.filter((o) => !o.dark));
    if (!op) return;
    op.crash();
    this.log(`${op.key} crashes`);
  }

  private darkOne(): void {
    const op = this.pick(this.ops.filter((o) => !o.dark));
    if (!op) return;
    op.goDark();
    this.log(`${op.key} goes dark`);
  }

  private withholdOne(): void {
    const cs = this.venue.commitments();
    if (!cs.length) return;
    const c = this.pick(cs).record;
    this.store.withhold(c.name);
    this.log(`${c.name} withheld`);
  }

  run(): Violation[] {
    for (let i = 0; i < this.config.steps; i++) {
      this.step();
      const v = this.check(false);
      if (v.length) return v;
    }
    return this.check(true);
  }

  /** The witnessed history of a backing: carrying commitments by parties in force at their index, in record order. */
  witnessedChain(backing: BackingId): Witnessed<Commitment>[] {
    return this.venue
      .commitments()
      .filter((w) => w.record.carries.has(backing) && this.chains.inForce(backing, w.index).op === w.record.op)
      .sort((a, b) => a.index - b.index || a.record.seq - b.record.seq);
  }

  finalHistory(backing: BackingId): readonly string[] {
    const chain = this.witnessedChain(backing);
    return chain.length ? chain[chain.length - 1]!.record.carries.get(backing)! : [];
  }

  check(atEnd: boolean): Violation[] {
    const out: Violation[] = [];
    // P1 continuity (C2.7.1, C2b.3): every witnessed in-force carrying commitment extends the one before it.
    for (const b of this.backings) {
      const chain = this.witnessedChain(b);
      for (let i = 1; i < chain.length; i++) {
        const prev = chain[i - 1]!.record.carries.get(b)!;
        const next = chain[i]!.record.carries.get(b)!;
        if (!isPrefix(prev, next)) {
          out.push({
            property: "P1 continuity",
            detail: `${b}: ${chain[i]!.record.name}@${chain[i]!.index} does not extend ${chain[i - 1]!.record.name}@${chain[i - 1]!.index}`,
          });
        }
      }
    }
    // P2 no double spend across the pool's final histories.
    const seen = new Map<string, string>();
    for (const b of this.backings) {
      for (const id of this.finalHistory(b)) {
        const nf = this.statements.get(id)!.nullifier;
        const first = seen.get(nf);
        if (first && first !== id) out.push({ property: "P2 double spend", detail: `${nf} in ${first} and ${id}` });
        seen.set(nf, id);
      }
    }
    // P3 no contradicted receipt (C2b.4): a receipt names the commitment its operator last signed. If the
    // record moved past that commitment the era lapsed with its tail; if it holds it, and the next
    // commitment of the same term holds too, that next commitment must carry the receipted statement.
    for (const r of this.receipts) {
      const final = this.finalHistory(r.statement.backing);
      if (final.includes(r.statement.id)) continue;
      if (r.afterSeq > 0 && "movedPast" in this.venue.answer(r.op, r.afterSeq)) continue; // the named era died
      const next = this.venue.answer(r.op, r.afterSeq + 1);
      if (!("holds" in next)) continue; // lapsed: moved past or not yet reached
      const w = this.venue.commitmentsFor(r.op).find((c) => c.record.seq === r.afterSeq + 1)!;
      if (this.chains.inForce(r.statement.backing, w.index).force !== r.term) continue; // the term ended: stale on its face
      if (!w.record.carries.has(r.statement.backing)) continue; // a drop, graded not contradicted (C2.4.5)
      if (!w.record.carries.get(r.statement.backing)!.includes(r.statement.id)) {
        out.push({
          property: "P3 contradicted receipt",
          detail: `${r.statement.id} receipted after ${r.after ?? "genesis"} by ${r.op}, missing from ${w.record.name}@${w.index}`,
        });
      }
    }
    // P4 structural: one commitment in flight, sequences strictly increase.
    for (const op of this.ops) {
      for (let i = 1; i < op.signed.length; i++) {
        if (op.signed[i]!.seq !== op.signed[i - 1]!.seq + 1) out.push({ property: "P4 sequence", detail: op.key });
        if (op.signed[i]!.signedAt < op.signed[i - 1]!.signedAt + this.venue.lag && !this.venue.shown(op.signed[i - 1]!.name)) {
          // signed the next before the last was shown or the lag passed
          const prev = op.signed[i - 1]!;
          if (!this.venue.shown(prev.name)) out.push({ property: "P4 in flight", detail: `${op.key} signed ${op.signed[i]!.name} with ${prev.name} unresolved` });
        }
      }
    }
    // P5 every receipt final (the floor's theorem, C2.5.3 with C2.6): where the venue includes at exactly
    // the lag and nothing is dropped, crashed, dark or withheld, honest conduct loses no co-signed
    // statement to a handover. Elsewhere a receipt may lapse; P3 says it is never contradicted.
    // Judged at the end, for receipts old enough to have been committed and witnessed.
    if (this.clean && atEnd) {
      const quiesce = 2 * this.venue.lag + 2;
      for (const r of this.receipts) {
        if (r.at > this.venue.height - quiesce) continue;
        if (!this.finalHistory(r.statement.backing).includes(r.statement.id)) {
          out.push({ property: "P5 receipt lost", detail: `${r.statement.id} receipted by ${r.op} at ${r.at} after ${r.after ?? "genesis"} is not in the final history` });
        }
      }
    }
    return out;
  }
}

function isPrefix(prefix: readonly string[], list: readonly string[]): boolean {
  if (prefix.length > list.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== list[i]) return false;
  return true;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Explore many seeds; return the first violation with its seed and trace, or null. */
export function explore(config: Config, seeds: number): { seed: number; violations: Violation[]; trace: string[] } | null {
  for (let seed = 1; seed <= seeds; seed++) {
    const m = new Model(config, seed);
    const v = m.run();
    if (v.length) return { seed, violations: v, trace: m.trace };
  }
  return null;
}
