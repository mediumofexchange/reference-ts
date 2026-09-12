// Node 24 optional entry point. C2.4, C2.6–8, C2.10.8–9: one durable
// operator journal, with canonical public history and original signed replies.
// The signing key must have exactly one journal on its venue. SQLite fences
// handles of that journal; it cannot fence another database or a copied key.
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encodeBacking, makeBacking, type Backing } from "../backing.js";
import { compareBytes, copyBytes } from "../bytes.js";
import { decodeCommitment, directoryRoot, encodeCommitment, signCommitment, verifyCommitment, type Commitment } from "../commitment.js";
import { revokedAt } from "../revocation.js";
import { VenueError, type Venue } from "../venue.js";
import { PoolAuthorityView } from "./authority.js";
import { readPoolCheckpoint, readPoolCheckpoints, type PoolCheckpointEvidence } from "./checkpoint.js";
import { mergePoolEvidence, replayedPoolEvidence } from "./evidence.js";
import { preparePoolOpening } from "./opening.js";
import { poolReceiptInHistory, poolReceiptAttestsEvidence, signPoolReceipt, type PoolReceipt } from "./receipt.js";
import { Segment, type ImportEvidence, type SegmentTrail, type SignedBacking, type StatementVerifier } from "./segment.js";
import { configurationHash, copyConfiguration, copySegmentHeader, decodeStatement, encodeStatement, ISSUE,
  parsePublicInputs, segmentBytes, statementHash, type OpeningCheckpoint, type PoolConfiguration, type SegmentHeader, type Statement } from "./statement.js";
import { copyPoolCheckpointEvidence, decodeStoredOpening, decodeStoredReceipt, encodeStoredOpening, encodeStoredReceipt } from "./store-codec.js";

const PROFILE = "pool-store/v2";
const U64 = 1n << 64n;
const SQLITE_LIMIT = (1n << 63n) - 1n;
const same = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;
const encoded = (c: Commitment | undefined) => c === undefined ? null : bytesToHex(encodeCommitment(c));

export class PoolStoreError extends Error {
  constructor(readonly code: "STORAGE" | "FENCED" | "BUSY" | "CONFLICT" | "UNAVAILABLE" | "STALE" | "SCHEDULE" | "UNSUPPORTED", message: string) {
    super(message); this.name = "PoolStoreError";
  }
}
function requireThat(ok: boolean, code: PoolStoreError["code"], message: string): asserts ok {
  if (!ok) throw new PoolStoreError(code, message);
}
function decimal(value: unknown): bigint {
  requireThat(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "STORAGE", "invalid stored counter");
  return BigInt(value);
}
function commandText(command: Command): string {
  switch (command?.kind) {
    case "open": return JSON.stringify({ kind: command.kind, opening: command.opening, at: command.at, observed: command.observed });
    case "commit": return JSON.stringify({ kind: command.kind, at: command.at, observed: command.observed });
    case "admit": return JSON.stringify({ kind: command.kind, statement: command.statement });
    case "published": return JSON.stringify({ kind: command.kind, sequence: command.sequence });
    default: throw new PoolStoreError("STORAGE", "unknown journal command");
  }
}
function scopeRequest(backings: readonly SignedBacking[]): string {
  return JSON.stringify({ kind: "open", backings: [...backings].sort((a, b) => compareBytes(a.backing.name, b.backing.name))
    .map(b => [bytesToHex(encodeBacking(b.backing)), bytesToHex(b.signature)]) });
}
function uniqueImports(evidence: readonly ImportEvidence[]): ImportEvidence[] {
  return [...new Map(evidence.map(e => [encoded(e.checkpoint.commitment), e])).values()];
}
function requiredImports(header: SegmentHeader, evidence: readonly ImportEvidence[]): ImportEvidence[] {
  const key = (c: OpeningCheckpoint) => `${bytesToHex(c.operator)}:${c.sequence}:${bytesToHex(c.root)}`;
  const supplied = new Map(evidence.map(e => [key(e.checkpoint.commitment), e]));
  const required = new Map<string, ImportEvidence>();
  const pending = header.entries.flatMap(e => e.opening === undefined ? [] : [e.opening]);
  while (pending.length !== 0) {
    const opening = pending.pop()!, name = key(opening);
    if (required.has(name)) continue;
    const item = supplied.get(name);
    requireThat(item !== undefined, "UNAVAILABLE", "required opening history is missing");
    required.set(name, item);
    pending.push(...item.trail.header.entries.flatMap(e => e.opening === undefined ? [] : [e.opening]));
  }
  return [...required.values()];
}
function historyImports(evidence: readonly PoolCheckpointEvidence[]): ImportEvidence[] {
  return evidence.flatMap(e => e.history === undefined ? [] : [{ checkpoint: { commitment: e.commitment, directory: e.directory },
    trail: e.history.trail, length: e.history.length }]);
}

interface Signed {
  commitment: Commitment;
  segment: Segment;
  length: bigint;
  at: bigint;
  observed: string | null;
  published: boolean;
}
interface Engine {
  revision: bigint;
  segment?: Segment;
  imports: ImportEvidence[];
  validation: PoolCheckpointEvidence[];
  recheckImports: () => void;
  signed: Signed[];
  receipts: Map<string, PoolReceipt>;
}
type Command =
  | { kind: "open"; opening: string; at: string; observed: string | null }
  | { kind: "commit"; at: string; observed: string | null }
  | { kind: "admit"; statement: string }
  | { kind: "published"; sequence: string };

export interface PoolStoreSummary {
  readonly highestSignedSequence: bigint;
  readonly latest?: Commitment;
}
export interface PoolStoreView extends PoolStoreSummary {
  readonly trail?: SegmentTrail;
  /** Local checkpoints and retained validation evidence, including directory-
   * or snapshot-only descent steps and retired segments. */
  readonly checkpoints: readonly PoolCheckpointEvidence[];
}
/** Fault injection only; uncommitted signatures are never passed to the hook. */
export type PoolStoreCheckpoint = "applied" | "stored" | "committed";

export class PoolStore {
  /** Public construction identity, copied so transport checks cannot mutate it. */
  get configurationDomain(): Uint8Array { return copyBytes(this.domain); }
  private readonly db: DatabaseSync;
  private readonly config: PoolConfiguration;
  private readonly secret: Uint8Array;
  private readonly operator: Uint8Array;
  private readonly venueId: Uint8Array;
  private readonly domain: Uint8Array;
  private readonly lag: bigint;
  private readonly owner: bigint;
  private readonly resumedAt: bigint | undefined;
  private observedIndex: bigint;
  private engine: Engine | undefined;
  private busy = false;
  private closed = false;
  private readonly requiredSegment: Uint8Array | undefined;

  constructor(path: string, configuration: PoolConfiguration, secret: Uint8Array,
    private readonly venue: Venue, private readonly verifier: StatementVerifier,
    private readonly checkpoint?: (phase: PoolStoreCheckpoint) => void,
    requiredSegment?: SegmentHeader) {
    requireThat(typeof path === "string" && path.trim() !== "" && path !== ":memory:" && !path.startsWith("file:"), "STORAGE", "a persistent filesystem path is required");
    this.config = copyConfiguration(configuration); this.domain = configurationHash(this.config);
    // Optional local operating constraint, never a replacement for authority,
    // replay or finality. Own the bytes before invoking the venue adapter.
    this.requiredSegment = requiredSegment === undefined ? undefined : segmentBytes(requiredSegment);
    this.secret = copyBytes(secret); this.operator = ed25519.getPublicKey(this.secret);
    this.venueId = copyBytes(venue.id); this.lag = venue.lag(); this.observedIndex = venue.witnessedIndex();
    this.clock();
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      requireThat(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal" &&
        this.db.prepare("PRAGMA synchronous").get()?.synchronous === 2, "STORAGE", "persistent WAL with FULL synchronization is required");
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1),
        profile TEXT NOT NULL, domain TEXT NOT NULL, operator TEXT NOT NULL, venue TEXT NOT NULL,
        owner INTEGER NOT NULL, tip INTEGER NOT NULL, observed TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY CHECK(seq>0), id TEXT NOT NULL UNIQUE,
        request TEXT NOT NULL, command TEXT NOT NULL, response TEXT NOT NULL) STRICT;`);
      let meta = this.metadata();
      if (meta === undefined) {
        requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n === 0, "STORAGE", "journal identity is missing");
        this.db.prepare("INSERT INTO identity VALUES(1,?,?,?,?,0,0,?)").run(PROFILE, bytesToHex(this.domain),
          bytesToHex(this.operator), bytesToHex(this.venueId), this.observedIndex.toString());
        meta = this.metadata()!;
      }
      this.identity(meta);
      if (this.requiredSegment !== undefined) {
        // Check within the ownership transaction, before fencing another handle.
        // Every retained opening must match; later scopes cannot be hidden by
        // selecting only the first opening. Full replay still follows on use.
        const rows = this.db.prepare("SELECT command FROM events WHERE json_extract(command,'$.kind')='open'").all();
        for (const row of rows) {
          const command = JSON.parse(String(row.command)) as { opening: string };
          this.requireSegment(decodeStoredOpening(command.opening, this.config).trail.header);
        }
      }
      const now = this.clock();
      requireThat(now >= decimal(meta.observed), "STORAGE", "venue clock is behind the durable journal");
      requireThat(typeof meta.owner === "bigint" && meta.owner < SQLITE_LIMIT, "STORAGE", "journal owner counter exhausted");
      this.owner = meta.owner + 1n;
      this.resumedAt = meta.tip === 0n ? undefined : now;
      this.db.prepare("UPDATE identity SET owner=?,observed=? WHERE id=1").run(this.owner, now.toString());
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      this.db.close(); this.secret.fill(0); throw error;
    }
  }

  private metadata() {
    const query = this.db.prepare("SELECT * FROM identity WHERE id=1"); query.setReadBigInts(true);
    return query.get();
  }
  private requireSegment(header: SegmentHeader): void {
    requireThat(this.requiredSegment === undefined || same(this.requiredSegment, segmentBytes(header)),
      "UNSUPPORTED", "journal segment differs from the configured local profile");
  }
  private identity(meta: ReturnType<PoolStore["metadata"]>): void {
    requireThat(meta?.profile === PROFILE && meta.domain === bytesToHex(this.domain) &&
      meta.operator === bytesToHex(this.operator) && meta.venue === bytesToHex(this.venueId), "STORAGE", "journal identity does not match");
    const query = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(seq),0) AS tip FROM events"); query.setReadBigInts(true);
    const counts = query.get()!;
    requireThat(typeof meta.tip === "bigint" && meta.tip === counts.tip && meta.tip === counts.n, "STORAGE", "journal is truncated or noncontiguous");
  }
  private clock(): bigint {
    const now = this.venue.witnessedIndex();
    if (typeof now !== "bigint" || now < this.observedIndex || typeof this.lag !== "bigint" || this.lag < 0n ||
      this.venue.lag() !== this.lag || !same(this.venue.id, this.venueId)) throw new VenueError("pool journal venue view changed or moved backwards");
    this.observedIndex = now; return now;
  }
  private transaction<T>(action: () => T): T {
    requireThat(!this.closed, "STORAGE", "store is closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const meta = this.metadata(); this.identity(meta);
      requireThat(meta!.owner === this.owner, "FENCED", "another process owns this journal");
      requireThat(this.engine === undefined || meta!.tip === this.engine.revision, "STORAGE", "journal changed behind its owner");
      const result = action(); this.db.exec("COMMIT"); return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* an uncertain commit is recovered by replay */ }
      this.engine = undefined; throw error;
    }
  }
  private async run<T>(action: (engine: Engine) => Promise<T>): Promise<T> {
    requireThat(!this.closed, "STORAGE", "store is closed");
    requireThat(!this.busy, "BUSY", "a journal operation is in progress");
    this.busy = true;
    try { await this.load(); return await action(this.engine!); }
    catch (error) { this.engine = undefined; throw error; }
    finally { this.busy = false; }
  }

  private async load(): Promise<void> {
    if (this.engine !== undefined) { this.transaction(() => {}); return; }
    const rows = this.transaction(() => {
      const q = this.db.prepare("SELECT seq,id,request,command,response FROM events ORDER BY seq"); q.setReadBigInts(true);
      return q.all();
    });
    const engine: Engine = { revision: 0n, imports: [], validation: [], recheckImports: () => {}, signed: [], receipts: new Map() };
    for (const row of rows) {
      requireThat(row.seq === engine.revision + 1n && typeof row.command === "string" && typeof row.response === "string", "STORAGE", "invalid journal row");
      const command = JSON.parse(row.command) as Command;
      requireThat(commandText(command) === row.command, "STORAGE", "noncanonical journal command");
      await this.replay(engine, command, row.response);
      if (command.kind === "open" || command.kind === "commit") {
        requireThat(typeof row.id === "string" && /^command:[a-zA-Z0-9._:-]{1,128}$/.test(row.id) &&
          row.request === (command.kind === "open" ? scopeRequest(this.terms(engine.segment!)) : "commit"), "STORAGE", "stored command identity differs from replay");
      } else if (command.kind === "admit") {
        const receipt = decodeStoredReceipt(row.response), hash = bytesToHex(receipt.statementHash);
        requireThat(row.id === `statement:${hash}` && row.request === hash, "STORAGE", "stored statement identity differs from replay");
      } else {
        requireThat(row.id === `published:${command.sequence}` && row.request === "published", "STORAGE", "stored publication identity differs from replay");
      }
      engine.revision++;
    }
    this.engine = engine;
    this.transaction(() => {}); // A new owner may have appeared while proofs ran.
  }
  private async replay(engine: Engine, command: Command, response: string): Promise<void> {
    if (command.kind === "open") {
      const saved = decodeStoredOpening(command.opening, this.config);
      requireThat(saved.trail.statements.length === 0, "STORAGE", "an opening has local statements");
      engine.segment = await Segment.replay(saved.trail, this.verifier, saved.evidence);
      engine.imports = uniqueImports([...engine.imports, ...saved.evidence]);
      // Older envelopes held only import trails. Reconstruct their snapshots
      // for the same record validation before NEW service. Historical signed
      // replies remain available even if finality can no longer be established.
      engine.validation = mergePoolEvidence([...engine.validation,
        ...(saved.validation ?? await this.importedEvidence(engine))]);
    }
    if (command.kind === "open" || command.kind === "commit") {
      const segment = engine.segment;
      requireThat(segment !== undefined, "STORAGE", "commitment without a segment");
      const commitment = decodeCommitment(hexToBytes(response));
      const highest = engine.signed.at(-1)?.commitment.sequence ?? 0n;
      requireThat(encoded(commitment) === response && verifyCommitment(commitment) && same(commitment.operator, this.operator) && commitment.sequence === highest + 1n &&
        same(commitment.root, directoryRoot(segment.directory())) &&
        (command.kind !== "open" || segment.header.sequence === commitment.sequence), "STORAGE", "stored commitment disagrees with replay");
      const at = decimal(command.at);
      requireThat(at <= this.observedIndex && at >= (engine.signed.at(-1)?.at ?? 0n), "STORAGE", "stored signed clock is inconsistent");
      requireThat(command.observed === null || typeof command.observed === "string", "STORAGE", "invalid observed commitment");
      if (command.observed !== null) {
        const observed = decodeCommitment(hexToBytes(command.observed));
        requireThat(encoded(observed) === command.observed && verifyCommitment(observed) && same(observed.operator, this.operator) && observed.sequence < commitment.sequence,
          "STORAGE", "invalid signing baseline");
      }
      engine.signed.push({ commitment, segment, length: segment.length, at, observed: command.observed, published: false });
    } else if (command.kind === "admit") {
      const segment = engine.segment; requireThat(segment !== undefined, "STORAGE", "receipt without a segment");
      const decoded = decodeStatement(hexToBytes(command.statement));
      requireThat(bytesToHex(encodeStatement(decoded.domain, decoded.statement)) === command.statement, "STORAGE", "noncanonical stored statement");
      requireThat(same(decoded.domain, this.domain), "STORAGE", "statement domain differs from journal");
      const before = segment.length; await segment.admit(decoded.statement);
      const receipt = decodeStoredReceipt(response);
      requireThat(segment.length === before + 1n && receipt.after === engine.signed.at(-1)?.commitment.sequence &&
        poolReceiptInHistory(segment, receipt) && poolReceiptAttestsEvidence(segment.authority(), decoded.statement, receipt),
        "STORAGE", "stored receipt disagrees with replay");
      engine.receipts.set(bytesToHex(receipt.statementHash), receipt);
    } else if (command.kind === "published") {
      const last = engine.signed.at(-1);
      requireThat(last !== undefined && last.commitment.sequence === decimal(command.sequence) && response === "", "STORAGE", "publication names another commitment");
      last.published = true;
    } else throw new PoolStoreError("STORAGE", "unknown journal command");
  }

  private prior(id: string, request: string): string | undefined {
    const row = this.db.prepare("SELECT request,response FROM events WHERE id=?").get(id);
    if (row === undefined) return undefined;
    requireThat(row.request === request && typeof row.response === "string", "CONFLICT", "command identifier names different content");
    return row.response;
  }
  private commandId(id: string): string {
    requireThat(typeof id === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(id), "CONFLICT", "invalid command identifier");
    return `command:${id}`;
  }
  private append(engine: Engine, id: string, request: string, command: Command, response: string, stable: () => void): void {
    this.checkpoint?.("applied"); stable();
    requireThat(engine.revision < SQLITE_LIMIT, "STORAGE", "journal is full");
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(engine.revision + 1n, id, request, commandText(command), response);
    this.db.prepare("UPDATE identity SET tip=?,observed=? WHERE id=1").run(engine.revision + 1n, this.observedIndex.toString());
    this.checkpoint?.("stored"); stable();
    // Memory is updated only after SQLite commits; all uncertain outcomes reload.
  }
  private latest(): Commitment | undefined {
    const latest = this.venue.previousFor(this.operator, U64, this.clock());
    if (latest !== undefined && (!verifyCommitment(latest) || !same(latest.operator, this.operator))) throw new VenueError("invalid operator record");
    return latest;
  }
  private held(signed: Signed): boolean {
    const exact = this.venue.previousFor(this.operator, signed.commitment.sequence + 1n, this.clock());
    return encoded(exact) === encoded(signed.commitment);
  }
  private current(engine: Engine): boolean {
    const last = engine.signed.at(-1); if (last === undefined) return false;
    const latest = encoded(this.latest());
    return latest === encoded(last.commitment) || (last.published && this.clock() < last.at + this.lag && latest === last.observed);
  }
  private ready(engine: Engine, action: "admit" | "commit"): void {
    const segment = engine.segment; requireThat(segment !== undefined, "STALE", "activate a segment first");
    const authority = new PoolAuthorityView(this.config, this.venue, this.terms(segment));
    const last = engine.signed.at(-1)!;
    const schedule = authority.schedule(segment.header, {
      ...(this.held(last) ? {} : { unwitnessedSignedAt: last.at }),
      ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }),
    });
    requireThat(schedule !== undefined, "STALE", "scope term ended");
    requireThat(this.current(engine), "STALE", "the signed state is not current; prepare its canonical replacement");
    requireThat(action === "admit" ? schedule.admissionOpen : schedule.commitNow, "SCHEDULE", "scope signing schedule is closed");
    this.checkRevocations(engine);
  }
  private terms(segment: Segment): SignedBacking[] {
    return segment.header.entries.map(e => {
      const signed = segment.backing(e.backing);
      requireThat(signed !== undefined, "STORAGE", "segment scope terms are missing"); return signed;
    });
  }
  private stable(now: bigint, observed: string | null): void {
    if (this.clock() !== now || encoded(this.latest()) !== observed || this.clock() !== now) throw new VenueError("venue changed during journal operation");
  }
  private unrevoked(statement: Statement, segment: Segment): void {
    if (statement.kind !== ISSUE) return;
    const inputs = parsePublicInputs(statement.kind, statement.publicInputs);
    if (inputs.kind !== ISSUE) throw new PoolStoreError("STORAGE", "issuance parse mismatch");
    const backing = segment.backing(inputs.backing)?.backing;
    requireThat(backing !== undefined && revokedAt(this.venue, backing) === undefined, "UNSUPPORTED", "revoked issuance cannot be admitted or newly committed");
  }
  private checkRevocations(engine: Engine): void {
    const segment = engine.segment!;
    const statements = segment.trail().statements;
    for (const { backing } of this.terms(segment)) {
      const revoked = revokedAt(this.venue, backing); if (revoked === undefined) continue;
      let finalized = 0n;
      for (const signed of engine.signed) if (signed.segment === segment && this.held(signed)) {
        const at = this.venue.witnessedAtSequence(this.operator, signed.commitment.sequence);
        if (at !== undefined && at < revoked && signed.length > finalized) finalized = signed.length;
      }
      requireThat(!statements.slice(Number(finalized)).some(statement => {
        const inputs = parsePublicInputs(statement.kind, statement.publicInputs);
        return inputs.kind === ISSUE && same(inputs.backing, backing.name);
      }), "UNSUPPORTED", "active history contains issuance without pre-revocation finality; recovery is required");
    }
    engine.recheckImports();
  }
  private checkImportSupport(imports: readonly ImportEvidence[]): void {
    for (const item of imports) for (const { backing } of item.trail.backings) {
      // A shared ancestor's out-of-scope backing can affect mixed spends.
      // Without recovery, its venue redemption nullifiers cannot be checked.
      requireThat(backing.evidence.silence === undefined, "UNSUPPORTED", "imported pool silence recovery is not implemented");
    }
  }

  private revocationView(evidence: readonly PoolCheckpointEvidence[]): () => void {
    const cutoffs = new Map<string, { backing: Backing; at: bigint | undefined }>();
    for (const e of evidence) for (const { backing } of e.history?.trail.backings ?? []) {
      const key = bytesToHex(backing.obligor);
      if (!cutoffs.has(key)) cutoffs.set(key, { backing: makeBacking(backing), at: revokedAt(this.venue, backing) });
    }
    return () => {
      for (const { backing, at } of cutoffs.values()) {
        if (revokedAt(this.venue, backing) !== at) throw new VenueError("revocation record changed during journal operation");
      }
    };
  }

  /** Re-establish historical import finality from retained bytes. An opening
   * that is held under its full scope also proves its own canonical descent.
   * Unpublished or publicly lapsed openings retain their journal and receipts;
   * ready() still gates service by currency and whole-scope authority. Run
   * before new service, after exact retry lookup: finality failure cannot
   * erase a previously signed receipt, checkpoint or publication outbox. */
  private async validateOpening(engine: Engine, segment: Segment): Promise<void> {
    const available = mergePoolEvidence([...engine.validation, ...this.localEvidence(engine)]);
    const recheck = this.revocationView(available);
    const targets = requiredImports(segment.header, historyImports(available)).map(e => e.checkpoint.commitment);
    const opening = engine.signed.find(s => s.segment === segment && s.commitment.sequence === segment.header.sequence)!;
    if (this.held(opening)) {
      const at = this.venue.witnessedAtSequence(this.operator, opening.commitment.sequence);
      requireThat(at !== undefined, "UNAVAILABLE", "opening witnessed index is unavailable");
      if (new PoolAuthorityView(this.config, this.venue, this.terms(segment)).authorizes(segment.header, at)) targets.push(opening.commitment);
    }
    if (targets.length !== 0) {
      const checked = await readPoolCheckpoints({ configuration: this.config, venue: this.venue,
        checkpoints: targets, evidence: available, verifier: this.verifier });
      requireThat(checked.kind === "final", "UNAVAILABLE", "retained opening evidence is unavailable or invalid");
      this.checkImportSupport(historyImports(checked.evidence));
    }
    recheck();
    engine.recheckImports = recheck;
    this.transaction(() => {});
  }

  /** Canonically prepare and durably sign an empty opening. Publishing is explicit. */
  async activate(id: string, backings: readonly SignedBacking[], evidence: readonly PoolCheckpointEvidence[] = []): Promise<Commitment> {
    const commandId = this.commandId(id);
    const own = backings.map(b => ({ backing: makeBacking(b.backing), signature: copyBytes(b.signature) }))
      .sort((a, b) => compareBytes(a.backing.name, b.backing.name));
    const request = scopeRequest(own);
    // Copy the import material before the first await via its canonical local codec.
    const provided = evidence.map(e => ({ commitment: decodeCommitment(encodeCommitment(e.commitment)),
      directory: e.directory.map(d => ({ name: copyBytes(d.name), digest: copyBytes(d.digest) })),
      ...(e.snapshots === undefined ? {} : { snapshots: e.snapshots.map(s => ({ backing: copyBytes(s.backing), header: copySegmentHeader(s.header),
        historyHash: copyBytes(s.historyHash), issued: s.issued, burned: s.burned,
        backings: s.backings.map(b => ({ backing: makeBacking(b.backing), signature: copyBytes(b.signature) })) })) }),
      ...(e.history === undefined ? {} : { history: { trail: decodeStoredOpening(encodeStoredOpening(e.history.trail, []), this.config).trail,
        length: e.history.length } }) }));
    return this.run(async engine => {
      const prior = this.transaction(() => this.prior(commandId, request));
      if (prior !== undefined) return decodeCommitment(hexToBytes(prior));
      for (const b of own) requireThat(b.backing.evidence.silence === undefined, "UNSUPPORTED", "pool silence recovery is not implemented");
      const now = this.clock(), observed = encoded(this.latest());
      const available = mergePoolEvidence([...provided, ...engine.validation, ...this.localEvidence(engine)]);
      const recheck = this.revocationView(available);
      const last = engine.signed.at(-1);
      if (this.resumedAt !== undefined) requireThat(now >= this.resumedAt + this.lag, "SCHEDULE", "restart lag has not passed");
      if (last !== undefined) {
        requireThat(this.held(last) || now >= last.at + this.lag, "SCHEDULE", "one commitment remains in flight");
        const authority = new PoolAuthorityView(this.config, this.venue, this.terms(last.segment));
        const ended = last.segment.header.entries.some(e => {
          const term = authority.termForLink(e.backing, e.link);
          requireThat(term !== undefined, "UNAVAILABLE", "old scope term is unavailable");
          return term.until !== undefined && term.until <= now;
        });
        if (!ended && this.current(engine)) {
          requireThat(this.held(last) && last.length === last.segment.length, "STALE", "elective scope change must first witness its entire live tail");
          const checked = await readPoolCheckpoint({ configuration: this.config, venue: this.venue, checkpoint: last.commitment,
            evidence: available, verifier: this.verifier });
          requireThat(checked.kind === "final", "UNAVAILABLE", "old scope checkpoint is not proven final");
        }
      }
      const highest = last?.commitment.sequence ?? 0n;
      const prepared = await preparePoolOpening({ configuration: this.config, venue: this.venue, operator: this.operator,
        highestSignedSequence: highest, backings: own, evidence: available, verifier: this.verifier });
      requireThat(prepared.kind === "prepared", "UNAVAILABLE", "canonical pool opening is unavailable or invalid");
      recheck();
      this.stable(now, observed);
      const segment = prepared.segment;
      this.requireSegment(segment.header);
      const validation = prepared.evidence.map(e => copyPoolCheckpointEvidence(e, this.config));
      const allImports = requiredImports(segment.header, historyImports(validation));
      const opening = encodeStoredOpening(segment.trail(), allImports, validation);
      const restored = await Segment.replay(segment.trail(), this.verifier, allImports);
      requireThat(same(directoryRoot(restored.directory()), directoryRoot(segment.directory())), "STORAGE", "retained imports differ from the prepared opening");
      const result = this.transaction(() => {
        this.stable(now, observed);
        const schedule = new PoolAuthorityView(this.config, this.venue, own).schedule(segment.header, {
          ...(last !== undefined && !this.held(last) ? { unwitnessedSignedAt: last.at } : {}),
          ...(this.resumedAt === undefined ? {} : { resumedAt: this.resumedAt }),
        });
        requireThat(schedule?.commitNow === true, "SCHEDULE", "opening signing schedule is closed");
        this.checkImportSupport(historyImports(validation)); recheck();
        const signed = signCommitment(this.secret, segment.header.sequence, directoryRoot(segment.directory()));
        this.append(engine, commandId, request, { kind: "open", opening, at: now.toString(), observed }, bytesToHex(encodeCommitment(signed)), () => {
          recheck(); this.stable(now, observed);
        });
        return signed;
      });
      engine.segment = segment; engine.imports = uniqueImports([...engine.imports, ...allImports]);
      engine.validation = mergePoolEvidence([...engine.validation, ...validation]); engine.recheckImports = recheck;
      engine.signed.push({ commitment: result, segment, length: 0n, at: now, observed, published: false }); engine.revision++;
      this.checkpoint?.("committed"); return decodeCommitment(encodeCommitment(result));
    });
  }

  /** Verify/admit, then atomically retain the statement and original receipt. */
  async submit(statement: Statement): Promise<PoolReceipt> {
    const hash = bytesToHex(statementHash(this.domain, statement.kind, statement.publicInputs));
    // Identity ignores new proof bytes on retries; only a new identity needs
    // complete evidence. Copy before run() reaches its first await.
    const own = { ...statement, publicInputs: [...statement.publicInputs],
      ...(statement.proof instanceof Uint8Array ? { proof: copyBytes(statement.proof) } : {}),
      ...(statement.obligorSignature instanceof Uint8Array ? { obligorSignature: copyBytes(statement.obligorSignature) } : {}) };
    return this.run(async engine => {
      const prior = engine.receipts.get(hash);
      if (prior !== undefined) return decodeStoredReceipt(encodeStoredReceipt(prior));
      if (engine.segment !== undefined) await this.validateOpening(engine, engine.segment);
      this.ready(engine, "admit");
      const segment = engine.segment!, now = this.clock(), observed = encoded(this.latest());
      this.unrevoked(own, segment);
      const accepted = await segment.admit(own);
      const result = this.transaction(() => {
        const stable = () => {
          this.stable(now, observed); this.ready(engine, "admit"); this.unrevoked(own, segment); this.stable(now, observed);
        };
        stable();
        const receipt = signPoolReceipt(this.secret, segment.authority(), accepted, engine.signed.at(-1)!.commitment.sequence);
        this.append(engine, `statement:${hash}`, hash, { kind: "admit", statement: bytesToHex(encodeStatement(this.domain, own)) },
          encodeStoredReceipt(receipt), stable);
        return receipt;
      });
      engine.receipts.set(hash, result); engine.revision++;
      this.checkpoint?.("committed"); return decodeStoredReceipt(encodeStoredReceipt(result));
    });
  }

  async commit(id: string): Promise<Commitment> {
    const commandId = this.commandId(id);
    return this.run(async engine => {
      const prior = this.transaction(() => this.prior(commandId, "commit"));
      if (prior !== undefined) return decodeCommitment(hexToBytes(prior));
      if (engine.segment !== undefined) await this.validateOpening(engine, engine.segment);
      this.ready(engine, "commit");
      const segment = engine.segment!, now = this.clock(), observed = encoded(this.latest());
      const highest = engine.signed.at(-1)!.commitment.sequence;
      requireThat(highest + 1n < U64, "STORAGE", "signed sequence counter exhausted");
      const stable = () => {
        this.stable(now, observed); this.ready(engine, "commit");
        this.stable(now, observed);
      };
      const result = this.transaction(() => {
        stable();
        const signed = signCommitment(this.secret, highest + 1n, directoryRoot(segment.directory()));
        this.append(engine, commandId, "commit", { kind: "commit", at: now.toString(), observed }, bytesToHex(encodeCommitment(signed)), stable);
        return signed;
      });
      engine.signed.push({ commitment: result, segment, length: segment.length, at: now, observed, published: false }); engine.revision++;
      this.checkpoint?.("committed"); return decodeCommitment(encodeCommitment(result));
    });
  }

  /** Retry the latest durable outbox bytes. No venue call occurs in a database transaction. */
  async publish(): Promise<Commitment> {
    return this.run(async engine => {
      const last = engine.signed.at(-1); requireThat(last !== undefined, "STALE", "no signed commitment to publish");
      // An adapter may refuse duplicate sequences after a lost response.
      // Exact held bytes already satisfy publication; do not send them again.
      const held = this.held(last);
      this.transaction(() => {}); // Fence again after the adapter's read callback.
      if (!held) this.venue.publish(decodeCommitment(encodeCommitment(last.commitment)));
      if (!last.published) {
        this.transaction(() => this.append(engine, `published:${last.commitment.sequence}`, "published",
          { kind: "published", sequence: last.commitment.sequence.toString() }, "", () => {}));
        last.published = true; engine.revision++;
        this.checkpoint?.("committed");
      }
      return decodeCommitment(encodeCommitment(last.commitment));
    });
  }

  private localEvidence(engine: Engine): PoolCheckpointEvidence[] {
    return engine.signed.map(s => this.checkpointEvidence(s));
  }
  private async importedEvidence(engine: Engine): Promise<PoolCheckpointEvidence[]> {
    const evidence: PoolCheckpointEvidence[] = [];
    for (const item of engine.imports) {
      const segment = await Segment.replay({ ...item.trail, statements: item.trail.statements.slice(0, Number(item.length)) }, this.verifier, engine.imports);
      evidence.push(this.checkpointEvidence({ segment, length: item.length, commitment: item.checkpoint.commitment }));
    }
    return evidence;
  }
  private checkpointEvidence(s: Pick<Signed, "segment" | "length" | "commitment">): PoolCheckpointEvidence {
    return replayedPoolEvidence(decodeCommitment(encodeCommitment(s.commitment)), s.segment, s.length);
  }
  /** Fenced public status without constructing trails or checkpoint evidence.
   * Initial journal loading still performs the existing complete replay. */
  async summary(): Promise<PoolStoreSummary> {
    return this.run(async engine => {
      this.transaction(() => {});
      const latest = engine.signed.at(-1)?.commitment;
      return { highestSignedSequence: latest?.sequence ?? 0n,
        ...(latest === undefined ? {} : { latest: decodeCommitment(encodeCommitment(latest)) }) };
    });
  }
  async view(): Promise<PoolStoreView> {
    return this.run(async engine => {
      this.transaction(() => {});
      return { highestSignedSequence: engine.signed.at(-1)?.commitment.sequence ?? 0n,
      ...(engine.segment === undefined ? {} : { trail: engine.segment.trail() }),
      ...(engine.signed.at(-1) === undefined ? {} : { latest: decodeCommitment(encodeCommitment(engine.signed.at(-1)!.commitment)) }),
      checkpoints: mergePoolEvidence([...engine.validation, ...this.localEvidence(engine)])
        .map(e => copyPoolCheckpointEvidence(e, this.config)) };
    });
  }
  close(): void {
    requireThat(!this.busy, "BUSY", "cannot close during a journal operation");
    if (!this.closed) { this.db.close(); this.secret.fill(0); this.engine = undefined; this.closed = true; }
  }
}
