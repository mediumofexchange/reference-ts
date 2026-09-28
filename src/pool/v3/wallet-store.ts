// C4.1–7 and pool-fees C1.2.3–5 on guarded reference venues: one seed receives
// exact requests and pays from its own restored single-backing holdings. Node 24,
// plaintext local custody: database/WAL/backups require protected storage and
// one active copy. A saved fulfillment or final payment is historical local
// accounting, never a second credit or permission to spend. Request
// authentication and independent public-evidence retention are caller
// obligations; this module supplies neither transport nor physical
// storage/rollback protection.
import { randomBytes, randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { copyRequest, type RangeRequest, type RangeLimits } from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../../venue-records.js";
import { identifierOf, isValue } from "../field.js";
import { ScopeTree } from "../scope.js";
import { prepareExactOutput, type PreparedOutput } from "./capsules.js";
import { decodeReceipt, encodeReceipt, verifyReceipt, type Receipt } from "./commitments.js";
import { configurationBytes, configurationHash, decodeConfiguration } from "./configuration.js";
import { requireReferenceVenue } from "./guard.js";
import { decodeSegmentHeader, segmentIdentity, type SegmentHeader } from "./headers.js";
import { ownedNotes, type OwnedNote } from "./holdings.js";
import { decodeEvidencePackage } from "./package.js";
import { PACKAGE_LIMITS, readSingleBackingFrontier, type PackageReader } from "./package-reader.js";
import { decodedTrails, type SignedTerms } from "./reader.js";
import { decodeRecord, encodeRecord, evidenceHashes, statementHash, type Record } from "./records.js";
import { locked, tagOf } from "./recovery.js";
import { applyForceEffects, openForceState, type ForceState } from "./state.js";
import { rootTermsName } from "./terms.js";
import { copyPaymentRequest, type PaymentRequest } from "./wallet-request.js";
import { spendTask, type NoteInput, type OutputNote, type ProofTask } from "./witness.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const PROFILE = "moe/wallet/v3/1", MAX_OWNER = (1n << 63n) - 1n;
export class V3WalletError extends Error {
  constructor(readonly code: "INVALID" | "UNKNOWN" | "CONFLICT" | "FENCED" | "STORAGE" |
    "ABSENT" | "SPENT" | "LOCKED" | "CHANGED_VIEW" | "FUNDS", message: string) { super(message); this.name = "V3WalletError"; }
}
function requireThat(ok: boolean, code: V3WalletError["code"], message: string): asserts ok {
  if (!ok) throw new V3WalletError(code, message);
}
function alias(value: string): string {
  requireThat(typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value), "INVALID", "invalid local alias");
  return value;
}
function identifier(value: Uint8Array): Uint8Array {
  const result = copyUnshared(value);
  requireThat(result.length === 32, "INVALID", "expected a 32-byte identifier"); return result;
}
export interface Fulfillment {
  readonly request: PaymentRequest;
  readonly checkpoint: Commitment;
  readonly judgingIndex: bigint;
  readonly package: Uint8Array;
  readonly terms: SignedTerms;
}
/** What the payer agreed to pay: the payee's exact request and amount and, for
 * a direct fee, the fee recipient's exact request and price (pool-fees C1.2.4). */
export interface PaymentOrder {
  readonly request: PaymentRequest;
  readonly value: bigint;
  readonly fee?: { readonly request: PaymentRequest; readonly value: bigint } | undefined;
}
/** Trusted local proving only: the task carries spend secrets. */
export type LocalProver = (task: ProofTask) => Promise<Record>;
export interface Payment {
  /** The exact canonical record every submission retry sends. */
  readonly record: Uint8Array;
  readonly statement: Uint8Array;
  readonly payee: bigint;
  readonly value: bigint;
  readonly fee: { readonly cm: bigint; readonly value: bigint } | undefined;
  /** The positive inputs' nullifiers this payment reserves permanently. */
  readonly inputs: readonly bigint[];
  /** prepared: not in canonical history; final: its statement is; failed: an input was spent otherwise. */
  readonly status: "prepared" | "final" | "failed";
  readonly receipt: Receipt | undefined;
  readonly final: { readonly checkpoint: Commitment; readonly judgingIndex: bigint } | undefined;
}
export interface Holding { readonly cm: bigint; readonly value: bigint; readonly status: "available" | "reserved" | "locked" }
/** One backing's holdings at an independently witnessed index; no claim about other backings or venues. */
export interface WalletView {
  readonly backing: Uint8Array;
  readonly judgingIndex: bigint;
  readonly checkpoint: Commitment | undefined;
  readonly holdings: readonly Holding[];
}

/** Record exactly the independent venue answers used by replay, then compare
 * them synchronously before acknowledgment. Index equality alone cannot detect
 * same-index revocation or newly available records. No supplied transcript is
 * ever accepted as venue authority. */
function observedView(source: RecordVenue, id: Uint8Array, at: bigint) {
  const lag = source.lag();
  const answers: { request: RangeRequest; limits: RangeLimits; bytes: Uint8Array | undefined }[] = [];
  const venue: RecordVenue = {
    get id() { return new Uint8Array(id); }, lag: () => lag, witnessedIndex: () => at,
    range(request, limits) {
      const owned = copyRequest(request), bound = { maxBytes: limits.maxBytes, maxEntries: limits.maxEntries };
      const answer = source.range(copyRequest(owned), { ...bound });
      const bytes = answer === undefined ? undefined : copyUnshared(answer);
      answers.push({ request: owned, limits: bound, bytes });
      return bytes === undefined ? undefined : new Uint8Array(bytes);
    },
  };
  const checkIdentity = () => requireThat(same(source.id, id) && source.lag() === lag && source.witnessedIndex() === at,
    "CHANGED_VIEW", "venue changed during verification");
  return { venue, check() {
    checkIdentity();
    for (const answer of answers) {
      const current = source.range(copyRequest(answer.request), { ...answer.limits });
      requireThat(answer.bytes === undefined ? current === undefined : current !== undefined && same(current, answer.bytes),
        "CHANGED_VIEW", "venue range changed during verification");
    }
    checkIdentity();
  } };
}

/** The spendable single-note or least-total pair covering `total`; ties by commitment. */
function select(notes: readonly OwnedNote[], total: bigint): OwnedNote[] {
  const sorted = [...notes].sort((a, b) => a.opening.value < b.opening.value ? -1 : a.opening.value > b.opening.value ? 1 :
    a.cm < b.cm ? -1 : a.cm > b.cm ? 1 : 0);
  const single = sorted.find(n => n.opening.value >= total);
  if (single !== undefined) return [single];
  let best: OwnedNote[] | undefined, sum: bigint | undefined;
  for (let i = 0, j = sorted.length - 1; i < j;) {
    const pair = sorted[i]!.opening.value + sorted[j]!.opening.value;
    if (pair < total) { i++; continue; }
    if (isValue(pair - total) && (sum === undefined || pair < sum)) { best = [sorted[i]!, sorted[j]!]; sum = pair; }
    j--;
  }
  requireThat(best !== undefined, "FUNDS", "no available one- or two-note selection covers the payment");
  return best;
}

export class V3Wallet {
  private readonly db: DatabaseSync;
  private readonly options: PackageReader;
  private readonly domain: Uint8Array;
  private readonly venueId: Uint8Array;
  private readonly seed: Uint8Array;
  private readonly owner: bigint;
  private closed = false;
  private poisoned = false;

  constructor(path: string, options: PackageReader) {
    const { configuration, verifier, venue, reference, importLimits } = options;
    const ownReference = structuredClone(reference);
    this.venueId = requireReferenceVenue(ownReference, venue);
    const ownConfiguration = decodeConfiguration(configurationBytes(configuration));
    this.domain = configurationHash(ownConfiguration);
    this.options = { configuration: ownConfiguration, verifier: { verify: verifier.verify.bind(verifier) }, venue, reference: ownReference,
      ...(importLimits === undefined ? {} : { importLimits: { ...importLimits } }) };
    requireThat(typeof path === "string" && path.trim() !== "" && path !== ":memory:" && !path.startsWith("file:"),
      "STORAGE", "a persistent filesystem path is required");
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;");
      requireThat(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal" &&
        this.db.prepare("PRAGMA synchronous").get()?.synchronous === 2, "STORAGE", "WAL and FULL synchronization required");
      this.db.exec("BEGIN IMMEDIATE");
      // An earlier receiver-only profile's seed is never silently replaced.
      requireThat(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='receiver_identity'").get() === undefined,
        "CONFLICT", "wallet database has an earlier profile");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS wallet_identity (id INTEGER PRIMARY KEY CHECK(id=1),
          profile TEXT NOT NULL, domain TEXT NOT NULL, venue TEXT NOT NULL, seed BLOB NOT NULL, owner INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS receiver_requests (alias TEXT PRIMARY KEY, request_id BLOB NOT NULL UNIQUE,
          backing BLOB NOT NULL, value TEXT NOT NULL, cm TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE IF NOT EXISTS receiver_fulfilled (alias TEXT PRIMARY KEY, cm TEXT NOT NULL UNIQUE,
          checkpoint BLOB NOT NULL, judging_index TEXT NOT NULL, package BLOB NOT NULL, terms BLOB NOT NULL, signature BLOB NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS payer_payments (alias TEXT PRIMARY KEY, statement TEXT NOT NULL UNIQUE, record BLOB NOT NULL,
          backing BLOB NOT NULL, operator BLOB NOT NULL, payee TEXT NOT NULL, value TEXT NOT NULL, fee TEXT, fee_value TEXT,
          status TEXT NOT NULL CHECK(status IN ('prepared','final','failed')), receipt BLOB, checkpoint BLOB, judging_index TEXT) STRICT;
        CREATE TABLE IF NOT EXISTS payer_inputs (nf TEXT PRIMARY KEY, alias TEXT NOT NULL REFERENCES payer_payments(alias)) STRICT;
        CREATE TABLE IF NOT EXISTS payer_outputs (cm TEXT PRIMARY KEY, alias TEXT NOT NULL REFERENCES payer_payments(alias)) STRICT;`);
      let meta = this.metadata();
      if (meta === undefined) {
        requireThat(["receiver_requests", "receiver_fulfilled", "payer_payments", "payer_inputs", "payer_outputs"].every(table =>
          this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n === 0), "STORAGE", "wallet identity is missing");
        this.db.prepare("INSERT INTO wallet_identity VALUES(1,?,?,?,?,0)").run(PROFILE, hex(this.domain), hex(this.venueId), randomBytes(32));
        meta = this.metadata()!;
      }
      requireThat(meta.profile === PROFILE && meta.domain === hex(this.domain) && meta.venue === hex(this.venueId),
        "CONFLICT", "wallet configuration or venue changed");
      requireThat(typeof meta.owner === "bigint" && meta.owner >= 0n && meta.owner < MAX_OWNER,
        "STORAGE", "wallet owner counter exhausted");
      this.seed = identifier(meta.seed as Uint8Array); this.owner = meta.owner + 1n;
      this.db.prepare("UPDATE wallet_identity SET owner=? WHERE id=1").run(this.owner);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve error */ }
      this.db.close(); throw error;
    }
  }

  private metadata() {
    const query = this.db.prepare("SELECT * FROM wallet_identity WHERE id=1"); query.setReadBigInts(true); return query.get();
  }
  private active(): void {
    requireThat(!this.closed && !this.poisoned, "STORAGE", "wallet is closed or needs reopening");
    requireThat(this.metadata()?.owner === this.owner, "FENCED", "another handle owns this wallet");
  }
  private transaction<T>(action: () => T): T {
    this.active();
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try { this.active(); const result = action(); committing = true; this.db.exec("COMMIT"); return result; }
    catch (error) {
      if (committing || !(error instanceof V3WalletError)) this.poisoned = true;
      try { this.db.exec("ROLLBACK"); } catch { this.poisoned = true; }
      throw error;
    }
  }
  private prepared(name: string): PreparedOutput {
    const row = this.db.prepare("SELECT request_id,backing,value,cm FROM receiver_requests WHERE alias=?").get(name);
    requireThat(row !== undefined, "UNKNOWN", "unknown request");
    const out = prepareExactOutput(this.seed, this.domain, row.request_id as Uint8Array, row.backing as Uint8Array, BigInt(row.value as string));
    requireThat(out.opening.value > 0n && out.cm.toString() === row.cm, "STORAGE", "stored request does not reproduce");
    return out;
  }
  private publicRequest(out: PreparedOutput): PaymentRequest {
    return copyPaymentRequest({ domain: this.domain, opening: out.opening, cm: out.cm, capsule: out.capsule },
      { domain: this.domain, backing: out.opening.backing, value: out.opening.value });
  }
  /** A fresh own output (change, zero or zero input) under a random request identifier (C4.2). */
  private fresh(backing: Uint8Array, value: bigint): PreparedOutput {
    for (let draw = 0; draw < 16; draw++) {
      try { return prepareExactOutput(this.seed, this.domain, randomBytes(32), backing, value); }
      catch (error) {
        // C4.2 draws again for the astronomically unlikely zero hash output.
        if (error instanceof EncodingError && /^(owner|commitment|nullifier) must be nonzero$/.test(error.message)) continue;
        throw error;
      }
    }
    throw new V3WalletError("STORAGE", "could not prepare a fresh output");
  }

  /** Independently read the terms' backing at the venue's current witnessed
   * index; restore this seed's unspent positive notes, force effects applied. */
  private async frontier(packageBytes: Uint8Array, signed: SignedTerms) {
    const bytes = copyUnshared(packageBytes), terms = { terms: copyUnshared(signed.terms), signature: copyUnshared(signed.signature) };
    const backing = rootTermsName(terms.terms), at = this.options.venue.witnessedIndex();
    requireThat(isValue(at), "INVALID", "invalid witnessed index");
    const observed = observedView(this.options.venue, this.venueId, at);
    const result = await readSingleBackingFrontier(bytes, terms, at, { ...this.options, venue: observed.venue });
    const canonical = result.canonical;
    let force: ForceState | undefined, notes: OwnedNote[] = [];
    if (canonical !== undefined) {
      force = openForceState(canonical.state);
      for (const publication of result.force) if (publication.index > canonical.state.adoptionIndex) applyForceEffects(force, publication.record);
      const spent = force.nullifiers;
      notes = ownedNotes(this.seed, this.domain, backing, canonical.state).filter(note => !spent.has(note.nf));
    }
    return { bytes, terms, backing, at, observed, canonical, force, notes, chain: result.ranges.chain };
  }
  private holdingsOf(notes: readonly OwnedNote[], force: ForceState | undefined, at: bigint): Holding[] {
    const reserved = this.db.prepare("SELECT 1 FROM payer_inputs WHERE nf=?");
    return notes.map(note => Object.freeze({ cm: note.cm, value: note.opening.value,
      status: reserved.get(note.nf.toString()) !== undefined ? "reserved" as const :
        force !== undefined && locked(force, tagOf(note.nf), at) ? "locked" as const : "available" as const }));
  }

  /** Secret material for independently secured offline backup; never send to a
   * payer/service. This is not encrypted export or seed-only invoice recovery. */
  recoverySeed(): Uint8Array { this.active(); return new Uint8Array(this.seed); }

  /** C4.2: commit fresh randomness and parameters before returning public bytes.
   * Exact alias retries read the saved record; aliases never change terms. */
  request(name: string, backing: Uint8Array, value: bigint): PaymentRequest {
    name = alias(name); const ownBacking = identifier(backing);
    requireThat(isValue(value) && value > 0n, "INVALID", "payment value must be positive u64");
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM receiver_requests WHERE alias=?").get(name) !== undefined) {
        const out = this.prepared(name);
        requireThat(same(out.opening.backing, ownBacking) && out.opening.value === value, "CONFLICT", "request parameters changed");
        return this.publicRequest(out);
      }
      for (let draw = 0; draw < 16; draw++) {
        const out = this.fresh(ownBacking, value);
        if (this.db.prepare("SELECT 1 FROM receiver_requests WHERE request_id=? OR cm=?").get(out.requestId, out.cm.toString()) !== undefined) continue;
        this.db.prepare("INSERT INTO receiver_requests VALUES(?,?,?,?,?)").run(name, out.requestId, ownBacking, value.toString(), out.cm.toString());
        return this.publicRequest(out);
      }
      throw new V3WalletError("STORAGE", "could not prepare a fresh request");
    });
  }

  /** Read the original historical accounting result after a lost reply.
   * Calling fulfill again is a conflict and never authorizes another credit. */
  fulfillment(name: string): Fulfillment | undefined {
    name = alias(name); this.active();
    const row = this.db.prepare("SELECT * FROM receiver_fulfilled WHERE alias=?").get(name);
    if (row === undefined) return undefined;
    return { request: this.publicRequest(this.prepared(name)), checkpoint: decodeCommitment(row.checkpoint as Uint8Array),
      judgingIndex: BigInt(row.judging_index as string), package: copyUnshared(row.package as Uint8Array),
      terms: { terms: copyUnshared(row.terms as Uint8Array), signature: copyUnshared(row.signature as Uint8Array) } };
  }

  /** C4.5: final acceptance against the complete canonical frontier at the
   * independently witnessed current index. Pending receipts cannot fulfill.
   * Caller must arrange independent retention of this public evidence and the
   * authenticated venue evidence; saving a package cannot guarantee availability. */
  async fulfill(name: string, packageBytes: Uint8Array, signed: SignedTerms): Promise<Fulfillment> {
    name = alias(name); this.active();
    const note = this.prepared(name);
    requireThat(this.fulfillment(name) === undefined, "CONFLICT", "request already fulfilled");
    requireThat(same(rootTermsName(copyUnshared(signed.terms)), note.opening.backing), "INVALID", "terms do not name requested backing");
    const { bytes, terms, backing, at, observed, canonical, force } = await this.frontier(packageBytes, signed);
    requireThat(same(backing, note.opening.backing), "INVALID", "terms do not name requested backing");
    requireThat(canonical !== undefined && force !== undefined, "ABSENT", "no canonical payment");
    requireThat(canonical.state.scanOutputs.some(out => out.cm === note.cm && out.capsule !== undefined && same(out.capsule, note.capsule)),
      "ABSENT", "exact requested output and capsule are absent");
    requireThat(!force.nullifiers.has(note.nf), "SPENT", "payment is already spent");
    requireThat(!locked(force, tagOf(note.nf), at), "LOCKED", "payment is locked by a standing demand");
    const checkpoint = encodeCommitment(canonical.commitment);
    // No async callback between final venue readback and the durable write.
    observed.check();
    this.transaction(() => {
      requireThat(this.db.prepare("SELECT 1 FROM receiver_fulfilled WHERE alias=? OR cm=?").get(name, note.cm.toString()) === undefined,
        "CONFLICT", "request or payment already fulfilled");
      this.db.prepare("INSERT INTO receiver_fulfilled VALUES(?,?,?,?,?,?,?)").run(name, note.cm.toString(), checkpoint,
        at.toString(), bytes, terms.terms, terms.signature);
    });
    return this.fulfillment(name)!;
  }

  /** The saved payment under this local alias, with its current local status. */
  payment(name: string): Payment | undefined {
    name = alias(name); this.active();
    const row = this.db.prepare("SELECT * FROM payer_payments WHERE alias=?").get(name);
    if (row === undefined) return undefined;
    const inputs = this.db.prepare("SELECT nf FROM payer_inputs WHERE alias=?").all(name).map(r => BigInt(r.nf as string))
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const fee = row.fee === null ? undefined : { cm: BigInt(row.fee as string), value: BigInt(row.fee_value as string) };
    return { record: copyUnshared(row.record as Uint8Array), statement: statementHash(decodeRecord(row.record as Uint8Array)),
      payee: BigInt(row.payee as string), value: BigInt(row.value as string), fee, inputs,
      status: row.status as Payment["status"],
      receipt: row.receipt === null ? undefined : decodeReceipt(row.receipt as Uint8Array),
      final: row.checkpoint === null ? undefined :
        { checkpoint: decodeCommitment(row.checkpoint as Uint8Array), judgingIndex: BigInt(row.judging_index as string) } };
  }

  /** This backing's holdings through the complete canonical frontier at the
   * venue's current index; resolves saved payments from that evidence. A
   * payment is final only when all four of its outputs are in canonical
   * history, imported ancestry included: its own change and zero outputs are
   * fresh, so no other statement creates them. It is failed only when one of
   * its inputs was spent otherwise. Statement identities are not imported
   * into a successor segment, so they cannot decide this. */
  async sync(packageBytes: Uint8Array, signed: SignedTerms): Promise<WalletView> {
    this.active();
    const { backing, at, observed, canonical, force, notes } = await this.frontier(packageBytes, signed);
    const updates: { alias: string; status: "final" | "failed" }[] = [];
    if (canonical !== undefined && force !== undefined) {
      const rows = this.db.prepare("SELECT alias,record FROM payer_payments WHERE status='prepared' AND backing=?").all(backing);
      const inputs = this.db.prepare("SELECT nf FROM payer_inputs WHERE alias=?");
      for (const row of rows) {
        const name = row.alias as string, outputs = decodeRecord(row.record as Uint8Array).publicInputs.slice(9, 13);
        if (outputs.every(cm => canonical.state.outputsSeen.has(cm))) updates.push({ alias: name, status: "final" });
        else if (inputs.all(name).some(r => force.nullifiers.has(BigInt(r.nf as string)))) updates.push({ alias: name, status: "failed" });
      }
    }
    const checkpoint = canonical === undefined ? undefined : encodeCommitment(canonical.commitment);
    observed.check();
    if (updates.length !== 0) this.transaction(() => {
      const update = this.db.prepare("UPDATE payer_payments SET status=?, checkpoint=?, judging_index=? WHERE alias=? AND status='prepared'");
      for (const { alias: name, status } of updates) update.run(status, status === "final" ? checkpoint! : null,
        status === "final" ? at.toString() : null, name);
    });
    return { backing, judgingIndex: at, checkpoint: canonical?.commitment, holdings: this.holdingsOf(notes, force, at) };
  }

  /** pool-fees C1.2.3–5: pay one exact request, and optionally one exact fee
   * request, from this seed's holdings in the canonical segment. The record is
   * saved with permanent input/output reservations before it is returned; an
   * exact alias retry returns the saved record without evidence or proving,
   * and the same alias with another order refuses (C1.2.5).
   * Selection is advisory: the operator and later replay judge spentness. */
  async prepare(name: string, order: PaymentOrder, packageBytes: Uint8Array, signed: SignedTerms,
    prove: LocalProver): Promise<Payment> {
    name = alias(name); this.active();
    const backing = rootTermsName(copyUnshared(signed.terms));
    // Each caller field is read once; the copies are what is checked and saved.
    const { request: requestIn, value, fee: feeIn } = order;
    const feeRequestIn = feeIn?.request, feeValue = feeIn?.value;
    const payee = copyPaymentRequest(requestIn, { domain: this.domain, backing, value });
    const fee = feeIn === undefined ? undefined : { value: feeValue!,
      request: copyPaymentRequest(feeRequestIn!, { domain: this.domain, backing, value: feeValue! }) };
    const total = value + (fee?.value ?? 0n);
    requireThat(isValue(total) && (fee === undefined || fee.request.cm !== payee.cm), "INVALID", "invalid payment order");
    const intent = [hex(backing), payee.cm.toString(), value.toString(), fee?.request.cm.toString() ?? null, fee?.value.toString() ?? null];
    const sameOrder = (): boolean | undefined => {
      const row = this.db.prepare("SELECT backing,payee,value,fee,fee_value FROM payer_payments WHERE alias=?").get(name);
      if (row === undefined) return undefined;
      return [hex(row.backing as Uint8Array), row.payee, row.value, row.fee, row.fee_value].every((field, i) => field === intent[i]);
    };
    const existing = sameOrder();
    if (existing !== undefined) {
      requireThat(existing, "CONFLICT", "alias names another payment order");
      return this.payment(name)!;
    }
    requireThat(typeof prove === "function", "INVALID", "a local prover is required");
    const theirs = [payee.cm, ...(fee === undefined ? [] : [fee.request.cm])];
    const taken = this.db.prepare("SELECT 1 FROM payer_outputs WHERE cm=?");
    requireThat(theirs.every(cm => taken.get(cm.toString()) === undefined), "CONFLICT", "request is already in a saved payment");

    const view = await this.frontier(packageBytes, signed), { canonical, force, notes, at } = view;
    // A concurrent exact call may have saved while this one read: answer it before selection.
    const racing = sameOrder();
    if (racing !== undefined) {
      requireThat(racing, "CONFLICT", "alias names another payment order");
      return this.payment(name)!;
    }
    requireThat(canonical !== undefined, "ABSENT", "no canonical checkpoint to spend from");
    requireThat(theirs.every(cm => !canonical.state.outputsSeen.has(cm)), "CONFLICT", "request is already paid");
    const header = this.headerOf(view.bytes, canonical.segment, canonical.scope, backing);
    // A statement for an ended term would be refused, and its reservation is permanent.
    const term = view.chain.at(-1);
    requireThat(term !== undefined && same(term.operator, header.operator) && same(term.link, header.entries[0]!.link),
      "CONFLICT", "the canonical segment's operator term has ended");
    const holdings = this.holdingsOf(notes, force, at), available = notes.filter((_, i) => holdings[i]!.status === "available");
    const selected = select(available, total), sum = selected.reduce((n, note) => n + note.opening.value, 0n);
    const inputs: NoteInput[] = selected.map(note => ({ note, anchor: note.tree.root(), path: note.tree.path(note.leaf) }));
    // A zero input names the same backing and needs no membership (C1.2.3).
    if (inputs.length === 1) inputs.push({ ...inputs[0]!, note: this.fresh(backing, 0n) });
    const outputs: OutputNote[] = [payee, ...(fee === undefined ? [] : [fee.request]), this.fresh(backing, sum - total)];
    while (outputs.length < 4) outputs.push(this.fresh(backing, 0n));
    // Public order labels no position (C1.2.3); the saved record fixes it for retries.
    for (let i = outputs.length - 1; i > 0; i--) { const j = randomInt(i + 1); [outputs[i], outputs[j]] = [outputs[j]!, outputs[i]!]; }
    const task = spendTask({ domain: this.domain, header }, inputs, outputs);
    const proven = await prove(task);
    let bytes: Uint8Array;
    try { bytes = encodeRecord(proven); } catch (error) {
      if (error instanceof EncodingError) throw new V3WalletError("INVALID", "prover returned a malformed record");
      throw error;
    }
    const record = decodeRecord(bytes);
    requireThat(record.kind === 2 && same(record.domain, this.domain) && record.authorization.length === 0 &&
      record.publicInputs.length === task.publicInputs.length && record.publicInputs.every((v, i) => v === task.publicInputs[i]) &&
      record.capsules.length === task.capsules.length && record.capsules.every((c, i) => same(c, task.capsules[i]!)),
      "INVALID", "prover returned another statement");
    requireThat(await this.options.verifier.verify(2, [...record.publicInputs], new Uint8Array(record.proof)) === true, "INVALID", "proof does not verify");
    const statement = hex(statementHash(record)), reserved = selected.map(note => note.nf.toString());
    this.transaction(() => {
      // A concurrent exact call may have saved first: adopt its record, never this proof.
      const winner = sameOrder();
      if (winner !== undefined) { requireThat(winner, "CONFLICT", "alias names another payment order"); return; }
      const input = this.db.prepare("SELECT 1 FROM payer_inputs WHERE nf=?");
      requireThat(reserved.every(nf => input.get(nf) === undefined), "CONFLICT", "an input is reserved by another payment");
      requireThat(outputs.every(out => taken.get(out.cm.toString()) === undefined), "CONFLICT", "an output belongs to another payment");
      this.db.prepare("INSERT INTO payer_payments VALUES(?,?,?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL)").run(name, statement, bytes,
        backing, header.operator, payee.cm.toString(), value.toString(), fee?.request.cm.toString() ?? null, fee?.value.toString() ?? null);
      for (const nf of reserved) this.db.prepare("INSERT INTO payer_inputs VALUES(?,?)").run(nf, name);
      for (const out of outputs) this.db.prepare("INSERT INTO payer_outputs VALUES(?,?)").run(out.cm.toString(), name);
    });
    return this.payment(name)!;
  }

  /** Submit the saved exact record; keep the first operator receipt that signs
   * its statement in the record's own segment. A receipt is pending operator
   * liability (C2.10.9), not finality; `sync` decides that from evidence. */
  async submit(name: string, service: { submit(record: Uint8Array): Promise<Receipt> }): Promise<Receipt> {
    name = alias(name);
    const saved = this.payment(name);
    requireThat(saved !== undefined, "UNKNOWN", "unknown payment");
    if (saved.receipt !== undefined) return saved.receipt;
    const row = this.db.prepare("SELECT operator FROM payer_payments WHERE alias=?").get(name)!;
    const record = decodeRecord(saved.record), p = record.publicInputs;
    const answer = await service.submit(new Uint8Array(saved.record));
    let receipt: Receipt;
    try { receipt = decodeReceipt(encodeReceipt(answer)); } catch (error) {
      if (error instanceof EncodingError) throw new V3WalletError("INVALID", "malformed receipt");
      throw error;
    }
    // Only this record's exact proof and authorization can be the admitted event (C2.10.9a).
    const digests = evidenceHashes(record);
    requireThat(verifyReceipt({ domain: this.domain, segment: identifierOf(p[2]!, p[3]!), scopeRoot: p[4]!,
      operator: row.operator as Uint8Array }, receipt) && same(receipt.statementHash, saved.statement) &&
      same(receipt.proofHash, digests.proofHash) && same(receipt.signatureHash, digests.signatureHash),
      "INVALID", "receipt does not authenticate the saved record");
    this.transaction(() => {
      this.db.prepare("UPDATE payer_payments SET receipt=? WHERE alias=? AND receipt IS NULL").run(encodeReceipt(receipt), name);
    });
    return this.payment(name)!.receipt!;
  }

  /** The canonical segment's header from the package's own trails, bound by identity. */
  private headerOf(bytes: Uint8Array, segment: Uint8Array, scope: bigint, backing: Uint8Array): SegmentHeader {
    const trails = decodedTrails(decodeEvidencePackage(bytes, PACKAGE_LIMITS).filter(item => item.kind === 6).map(item => item.payload));
    const found = trails.find(trail => same(sha256(trail.header), segment));
    requireThat(found !== undefined, "ABSENT", "canonical segment header is absent");
    const header = decodeSegmentHeader(found.header);
    requireThat(same(segmentIdentity(header), segment) && new ScopeTree(header.entries).root() === scope &&
      header.entries.length === 1 && same(header.entries[0]!.backing, backing), "INVALID", "canonical segment is not this backing's");
    return header;
  }

  close(): void { if (!this.closed) { this.closed = true; this.seed.fill(0); this.db.close(); } }
}
