// C4.1–7 and pool-fees C1.2.3–5 on guarded reference venues: one seed receives
// exact requests and pays from its own restored holdings of one backing, whose
// canonical segment may scope several (C2.10). Node 24,
// plaintext local custody: database/WAL/host backups require protected storage and
// one active copy; the offline handoff is encrypted and freezes its source. A saved fulfillment or final payment is historical local
// accounting, never a second credit or permission to spend. Request
// authentication and independent public-evidence retention are caller
// obligations; this module supplies neither transport nor physical
// storage/rollback protection.
//
// Reads cost what is new (pool-v3 §14, storage decision 2026-09-29 items 6 and 8).
// Beside the database the wallet keeps two files that hold no secret and are in
// no backup, so losing either costs a first sync and nothing else:
// - `<path>.evidence`, its own copy of the public evidence (evidence-store.ts):
//   `supply` runs the caller's transport into it, and a read's package then
//   carries only that read's own items;
// - `<path>.replay` with its digest, the kept classes, replay state and venue
//   answers of its reads (replay-store.ts), with an incremental witness for
//   each of this seed's notes, kept where the verifier declares its circuits.
//   It shows which outputs are this seed's, so it needs the database's protection.
import { randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, linkSync, openSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import type { RecordVenue } from "../../record-venue.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../../venue-records.js";
import { identifierOf, isValue } from "../field.js";
import { commitmentOf } from "../notes.js";
import { prepareExactOutput, type PreparedOutput } from "./capsules.js";
import { decodeReceipt, encodeReceipt, verifyReceipt, type Receipt } from "./commitments.js";
import { configurationBytes, configurationHash, decodeConfiguration, requireConfigurationVerifier } from "./configuration.js";
import { requireReferenceVenue } from "./guard.js";
import { EvidenceStore } from "./evidence-store.js";
import type { SegmentHeader } from "./headers.js";
import { ownedNotes, seedWitness, type OwnedNote } from "./holdings.js";
import { readFrontier, type PackageReader } from "./package-reader.js";
import type { SignedTerms } from "./reader.js";
import { decodeRecord, encodeRecord, evidenceHashes, statementHash, type Record } from "./records.js";
import { KeptStateMismatch, ReplayStore } from "./replay-store.js";
import type { CanonicalCheckpoint, FrontierResult } from "./scope-reader.js";
import { locked, tagOf } from "./recovery.js";
import { applyForceEffects, openForceState, type ForceState, type WitnessPredicate } from "./state.js";
import { rootTermsName } from "./terms.js";
import { cellBytes, decodeWalletSnapshot, encodeWalletSnapshot, MAX_WALLET_BACKUP_BYTES, openWalletBackup, sealWalletBackup,
  WALLET_BACKUP_OVERHEAD, walletBackupDigest, type WalletCell, type WalletSnapshot } from "./wallet-backup.js";
import { copyPaymentRequest, type PaymentRequest } from "./wallet-request.js";
import { spendTask, type NoteInput, type OutputNote, type ProofTask } from "./witness.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const PROFILE = "moe/wallet/v3/3", MAX_OWNER = (1n << 63n) - 1n;
export class V3WalletError extends Error {
  constructor(readonly code: "INVALID" | "UNKNOWN" | "CONFLICT" | "FENCED" | "STORAGE" |
    "ABSENT" | "SPENT" | "LOCKED" | "CHANGED_VIEW" | "FUNDS" | "SILENCE", message: string) { super(message); this.name = "V3WalletError"; }
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
/** The whole schema: created from here and, at export, compared with the
 * stored definitions (whitespace aside), so a database of any other shape
 * refuses before its source freezes. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallet_identity (id INTEGER PRIMARY KEY CHECK(id=1),
    profile TEXT NOT NULL, domain TEXT NOT NULL, venue TEXT NOT NULL, seed BLOB NOT NULL, owner INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS receiver_requests (alias TEXT PRIMARY KEY, request_id BLOB NOT NULL UNIQUE,
    backing BLOB NOT NULL, value TEXT NOT NULL, cm TEXT NOT NULL UNIQUE) STRICT;
  CREATE TABLE IF NOT EXISTS receiver_fulfilled (alias TEXT PRIMARY KEY, cm TEXT NOT NULL UNIQUE,
    checkpoint BLOB NOT NULL, judging_index TEXT NOT NULL, terms BLOB NOT NULL, signature BLOB NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS payer_payments (alias TEXT PRIMARY KEY, statement TEXT NOT NULL UNIQUE, record BLOB NOT NULL,
    backing BLOB NOT NULL, operator BLOB NOT NULL, payee TEXT NOT NULL, value TEXT NOT NULL, fee TEXT, fee_value TEXT,
    status TEXT NOT NULL CHECK(status IN ('prepared','final','failed')), receipt BLOB, checkpoint BLOB, judging_index TEXT,
    zero BLOB, judged TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS payer_inputs (nf TEXT PRIMARY KEY, alias TEXT NOT NULL REFERENCES payer_payments(alias)) STRICT;
  CREATE TABLE IF NOT EXISTS payer_outputs (cm TEXT PRIMARY KEY, alias TEXT NOT NULL REFERENCES payer_payments(alias),
    value TEXT NOT NULL, owner TEXT NOT NULL, rho TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS payer_superseded (statement TEXT NOT NULL, alias TEXT NOT NULL REFERENCES payer_payments(alias),
    record BLOB NOT NULL, receipt BLOB) STRICT;
  CREATE TABLE IF NOT EXISTS wallet_custody (id INTEGER PRIMARY KEY CHECK(id=1), export BLOB, restored_from TEXT) STRICT;`;
const DEFINITIONS = new Map(SCHEMA.split(";").map(s => s.replace(/\s+/g, " ").trim()).filter(s => s !== "")
  .map(s => { const sql = s.replace("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE "); return [sql.split(" ")[2]!, sql] as const; }));
/** The wallet's state tables and columns in export order; fixed names, never SQL
 * supplied by a backup. Identity and custody rows are not transferred: the
 * destination takes the seed, a fresh owner fence and its own provenance. */
const TABLES = [
  ["receiver_requests", ["alias", "request_id", "backing", "value", "cm"]],
  ["receiver_fulfilled", ["alias", "cm", "checkpoint", "judging_index", "terms", "signature"]],
  ["payer_payments", ["alias", "statement", "record", "backing", "operator", "payee", "value", "fee", "fee_value",
    "status", "receipt", "checkpoint", "judging_index", "zero", "judged"]],
  ["payer_inputs", ["nf", "alias"]],
  ["payer_outputs", ["cm", "alias", "value", "owner", "rho"]],
  ["payer_superseded", ["statement", "alias", "record", "receipt"]],
] as const;
/** A restoration the constructor consumes synchronously: the seed, the state
 * rows, the envelope's digest, and the domain and venue it was opened under. */
interface Installation {
  readonly seed: Uint8Array; readonly tables: WalletSnapshot["tables"]; readonly digest: string | null;
  readonly domain: Uint8Array; readonly venue: Uint8Array;
}
let installing: Installation | undefined;
function persistentPath(path: string): void {
  requireThat(typeof path === "string" && path.trim() !== "" && path !== ":memory:" && !path.startsWith("file:"),
    "STORAGE", "a persistent filesystem path is required");
}
/** Each caller field read once: the wallet's domain, guarded venue identity and
 * the owned reader options every later step uses. */
function ownOptions(options: PackageReader) {
  const { configuration, verifier, venue, reference } = options;
  const ownReference = structuredClone(reference), venueId = requireReferenceVenue(ownReference, venue);
  const ownConfiguration = decodeConfiguration(configurationBytes(configuration)), verify = verifier.verify.bind(verifier);
  const identities = verifier.identities;
  requireConfigurationVerifier(ownConfiguration, identities);
  const reader: PackageReader = { configuration: ownConfiguration, verifier: identities === undefined ? { verify } : { verify, identities },
    venue, reference: ownReference };
  return { domain: configurationHash(ownConfiguration), venueId, reader };
}
/** The canonical checkpoint and witnessed index a request was found paid at. Its evidence is what the
 * wallet's evidence file retains; nothing here stores or proves that evidence. */
export interface Fulfillment {
  readonly request: PaymentRequest;
  readonly checkpoint: Commitment;
  readonly judgingIndex: bigint;
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
  /** Earlier records of this payment in segments that stopped being canonical, oldest
   * first, with any receipt: evidence of that operator's acceptance, never finality. */
  readonly superseded: readonly { readonly record: Uint8Array; readonly receipt: Receipt | undefined }[];
}
export interface Holding { readonly cm: bigint; readonly value: bigint; readonly status: "available" | "reserved" | "locked" }
/** One backing's holdings at an independently witnessed index; no claim about other backings or venues. */
export interface WalletView {
  readonly backing: Uint8Array;
  readonly judgingIndex: bigint;
  readonly checkpoint: Commitment | undefined;
  readonly holdings: readonly Holding[];
}

/** The venue as one read sees it: its clock held at `at`. The read is acted on only while the venue's
 * identity, lag and witnessed index are still those (`check`, called synchronously before every write or
 * proof). An answer through a witnessed index is final (pool-v3 §13.1–13.2), so a clock that has not moved
 * means every answer the read used, kept or newly asked, still stands; nothing is asked twice. No supplied
 * transcript is ever accepted as venue authority. */
function heldView(source: RecordVenue, id: Uint8Array, at: bigint) {
  const lag = source.lag();
  const venue: RecordVenue = {
    get id() { return new Uint8Array(id); }, lag: () => lag, witnessedIndex: () => at,
    range: (request, limits) => source.range(request, limits),
  };
  return { venue, check() {
    requireThat(same(source.id, id) && source.lag() === lag && source.witnessedIndex() === at, "CHANGED_VIEW", "venue changed during verification");
  } };
}

/** One backing's frontier as a wallet read found it, at the index the view is held at. */
interface Frontier {
  readonly terms: SignedTerms; readonly backing: Uint8Array; readonly at: bigint; readonly lag: bigint;
  readonly observed: ReturnType<typeof heldView>;
  readonly canonical: CanonicalCheckpoint | undefined; readonly force: ForceState | undefined; readonly notes: OwnedNote[];
  readonly chain: FrontierResult["ranges"]["chain"]; readonly scopeChains: FrontierResult["scopeChains"]; readonly clock: FrontierResult["clock"];
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
  private readonly path: string;
  /** This seed's outputs, which a replay keeps witnesses for. */
  private readonly witness: WitnessPredicate;
  /** The wallet's evidence file and kept replay file, each opened at the first read that needs it. */
  private retained: EvidenceStore | undefined;
  private replays: ReplayStore | undefined;
  /** The last read or supply: one runs at a time, since they share the two files. */
  private turn: Promise<void> = Promise.resolve();
  private closed = false;
  private poisoned = false;

  constructor(path: string, options: PackageReader) {
    const restore = installing; installing = undefined;
    const own = ownOptions(options);
    this.venueId = own.venueId; this.domain = own.domain; this.options = own.reader; this.path = path;
    requireThat(restore === undefined || (same(restore.domain, this.domain) && same(restore.venue, this.venueId)),
      "CONFLICT", "wallet configuration or venue changed");
    persistentPath(path);
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;");
      requireThat(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal" &&
        this.db.prepare("PRAGMA synchronous").get()?.synchronous === 2, "STORAGE", "WAL and FULL synchronization required");
      this.db.exec("BEGIN IMMEDIATE");
      // An earlier receiver-only profile's seed is never silently replaced.
      requireThat(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='receiver_identity'").get() === undefined,
        "CONFLICT", "wallet database has an earlier profile");
      this.db.exec(SCHEMA);
      let meta = this.metadata();
      requireThat(restore === undefined || meta === undefined, "CONFLICT", "recovery destination is no longer pristine");
      if (meta === undefined) {
        requireThat([...TABLES.map(([table]) => table), "wallet_custody"].every(table =>
          this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n === 0), "STORAGE", "wallet identity is missing");
        this.db.prepare("INSERT INTO wallet_identity VALUES(1,?,?,?,?,0)").run(PROFILE, hex(this.domain), hex(this.venueId),
          restore?.seed ?? randomBytes(32));
        this.db.prepare("INSERT INTO wallet_custody VALUES(1,NULL,?)").run(restore?.digest ?? null);
        if (restore !== undefined) this.install(restore.tables);
        meta = this.metadata()!;
      }
      // A database from before offline handoff has no custody row: it was never exported.
      this.db.exec("INSERT OR IGNORE INTO wallet_custody VALUES(1,NULL,NULL)");
      requireThat(meta.profile === PROFILE && meta.domain === hex(this.domain) && meta.venue === hex(this.venueId),
        "CONFLICT", "wallet configuration or venue changed");
      requireThat(typeof meta.owner === "bigint" && meta.owner >= 0n && meta.owner < MAX_OWNER,
        "STORAGE", "wallet owner counter exhausted");
      this.seed = identifier(meta.seed as Uint8Array); this.owner = meta.owner + 1n;
      this.witness = seedWitness(this.seed, this.domain);
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
  /** Inside the constructor's transaction: the snapshot's rows in storage order,
   * so each table keeps its order; SQLite's strict types, uniqueness and
   * references refuse state that no wallet could have written. */
  private install(tables: WalletSnapshot["tables"]): void {
    try {
      TABLES.forEach(([table, columns], t) => {
        const insert = this.db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
        for (const row of tables[t]!) insert.run(...row);
      });
    } catch (error) {
      if (error instanceof V3WalletError) throw error;
      throw new V3WalletError("INVALID", "backup state does not fit the wallet schema");
    }
    requireThat(this.db.prepare("PRAGMA foreign_key_check").all().length === 0 && this.db.prepare(`SELECT 1 FROM receiver_fulfilled f
      LEFT JOIN receiver_requests r ON r.alias=f.alias AND r.cm=f.cm WHERE r.alias IS NULL`).get() === undefined,
      "INVALID", "backup state has unmatched references");
  }
  private active(): void {
    requireThat(!this.closed && !this.poisoned, "STORAGE", "wallet is closed or needs reopening");
    requireThat(this.metadata()?.owner === this.owner, "FENCED", "another handle owns this wallet");
  }
  private frozen(): boolean {
    return this.db.prepare("SELECT export FROM wallet_custody WHERE id=1").get()?.export !== null;
  }
  /** Every operation that could change or act on wallet state: after an export
   * only its restored copy may, so nothing reaches a service or prover here. */
  private mutable(): void {
    this.active();
    requireThat(!this.frozen(), "FENCED", "wallet was exported; only its restored copy may act");
  }
  private transaction<T>(action: () => T, whileFrozen = false): T {
    this.active();
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      if (whileFrozen) this.active(); else this.mutable();
      const result = action(); committing = true; this.db.exec("COMMIT"); return result;
    }
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

  /** One read or supply at a time, in call order: they share the evidence file and the kept replay file,
   * whose state a read in progress holds open. A failed turn does not hold up the next. */
  private inTurn<T>(action: () => Promise<T>): Promise<T> {
    const result = this.turn.then(action);
    this.turn = result.then(() => {}, () => {});
    return result;
  }
  /** The wallet's own evidence file (§14): what suppliers and packages brought, authenticated when a read uses it. */
  private evidence(): EvidenceStore {
    try { return this.retained ??= new EvidenceStore(`${this.path}.evidence`); } catch (error) {
      if (error instanceof TypeError) throw new V3WalletError("STORAGE", "the wallet's evidence file has another layout");
      throw error;
    }
  }
  /** The kept state of the wallet's reads (§14 kept classes): a file where the verifier declares its circuits,
   * which name kept state; otherwise each read keeps its own in memory. */
  private kept(): ReplayStore | undefined {
    const declared = this.options.verifier.identities;
    if (declared === undefined || Object.keys(declared).length === 0) return undefined;
    try { return this.replays ??= new ReplayStore(`${this.path}.replay`, { digest: `${this.path}.replay.sha256` }); } catch (error) {
      if (error instanceof Error && /in use/.test(error.message)) throw new V3WalletError("STORAGE", "another handle holds this wallet's kept replay file");
      throw error;
    }
  }

  /**
   * Bring public evidence into the wallet's own evidence file: `transport` is the caller's, for example
   * `evidence => client.sync(backing, evidence)` (service-client.ts) or an import of a package from any other
   * source. It runs in turn with the wallet's reads. Transport only: what it keeps is authenticated when a
   * read uses it, selects nothing and proves nothing. A later read's package then needs only that read's own
   * items (the configuration, fault evidence). Where a read stays unresolved over what the file holds, supply
   * it again in full (`{ full: true }`).
   */
  async supply<T>(transport: (evidence: EvidenceStore) => Promise<T>): Promise<T> {
    this.mutable();
    requireThat(typeof transport === "function", "INVALID", "an evidence transport is required");
    return this.inTurn(async () => { this.mutable(); return transport(this.evidence()); });
  }

  /** Independently read the terms' backing at the venue's current witnessed
   * index, in any scope (C2.10.3–7), over the package and what the wallet's
   * evidence file retains; restore this seed's unspent positive notes of that
   * backing, force effects applied. Other scoped backings' notes of the
   * shared history are that backing's view, not this one's. `use` decides from
   * the view synchronously, inside the read's turn: the state it reads is the
   * kept file's, which a later read moves on. The caller's bytes are copied
   * before the first await. */
  private async read<T>(packageBytes: Uint8Array, signed: SignedTerms, use: (view: Frontier) => T): Promise<T> {
    const bytes = copyUnshared(packageBytes), terms = { terms: copyUnshared(signed.terms), signature: copyUnshared(signed.signature) };
    const backing = rootTermsName(terms.terms);
    return this.inTurn(async () => {
      let view: Frontier;
      try {
        this.mutable();
        view = await this.frontier(bytes, terms, backing);
      } catch (error) {
        // A replaced or exported handle says so, whatever its read met once another handle held the files.
        if (!(error instanceof V3WalletError)) this.mutable();
        throw error;
      }
      return use(view);
    });
  }
  private async frontier(bytes: Uint8Array, terms: SignedTerms, backing: Uint8Array) {
    const at = this.options.venue.witnessedIndex();
    requireThat(isValue(at), "INVALID", "invalid witnessed index");
    const observed = heldView(this.options.venue, this.venueId, at), store = this.kept();
    const options = { ...this.options, venue: observed.venue, witness: this.witness, evidence: this.evidence(), ...(store === undefined ? {} : { store }) };
    for (let again = false; ; again = true) {
      try {
        const result = await readFrontier(bytes, terms, at, options);
        const canonical = result.canonical;
        let force: ForceState | undefined, notes: OwnedNote[] = [];
        if (canonical !== undefined) {
          force = openForceState(canonical.state);
          // This backing's own adoption index: each scoped backing has its own.
          const adopted = canonical.state.adoptionIndices.get(hex(backing)) ?? 0n;
          for (const publication of result.force) if (publication.index > adopted) applyForceEffects(force, publication.record);
          const spent = force;
          // The scan ran inside the replay, once per output: only this seed's witnessed outputs are read here.
          notes = ownedNotes(this.seed, this.domain, backing, canonical.state).filter(note => !spent.hasNullifier(note.nf));
        }
        return { terms, backing, at, observed, canonical, force, notes, chain: result.ranges.chain, scopeChains: result.scopeChains,
          lag: result.ranges.lag, clock: result.clock };
      } catch (error) {
        // §14: kept witnesses answer only at their namespaces' tips. A read below one (a venue view older than
        // an earlier read's) discards the kept state and replays; with nothing kept the failure stays visible.
        if (!(error instanceof KeptStateMismatch) || store === undefined || again) throw error;
        store.discardKept();
      }
    }
  }
  /** The canonical segment's header, if a new statement for it could still be
   * admitted: no scoped backing's operator term has ended (one ending ends the
   * segment for every scoped backing, C2.10.9) and, where the backing declares
   * silence, the operator's witnessing horizon has not reached the clock (the
   * journal's own admission rule). Advisory: the operator judges admission.
   * The header is the one the read authenticated for the canonical checkpoint. */
  private admissible(view: Frontier): SegmentHeader {
    const { canonical, chain, scopeChains, clock, at, lag } = view;
    requireThat(canonical !== undefined, "ABSENT", "no canonical checkpoint to spend from");
    const header = canonical.header;
    // A statement for an ended term would be refused.
    requireThat(header.entries.every(entry => {
      const term = (same(entry.backing, view.backing) ? chain : scopeChains?.get(hex(entry.backing)))?.at(-1);
      return term !== undefined && same(term.operator, header.operator) && same(term.link, entry.link);
    }), "CONFLICT", "the canonical segment's operator term has ended");
    requireThat(clock === null || clock === undefined || (clock.boundary === null &&
      at + lag - canonical.index <= BigInt(clock.duration)), "SILENCE", "the canonical segment's silence clock closes admission");
    return header;
  }
  /** final: all four outputs are in canonical history, imports included (own
   * change/zero outputs are fresh, so no other statement creates them); failed:
   * a reserved input was spent otherwise. Statement identities are not imported
   * into a successor segment, so they cannot decide this. */
  private resolution(name: string, record: Record, canonical: { state: { hasOutput(cm: bigint): boolean } }, force: ForceState) {
    if (record.publicInputs.slice(9, 13).every(cm => canonical.state.hasOutput(cm))) return "final" as const;
    const inputs = this.db.prepare("SELECT nf FROM payer_inputs WHERE alias=?").all(name);
    return inputs.some(r => force.hasNullifier(BigInt(r.nf as string))) ? "failed" as const : undefined;
  }
  private resolve(updates: readonly { alias: string; status: "final" | "failed" }[], checkpoint: Uint8Array | undefined, at: bigint): void {
    if (updates.length !== 0) this.transaction(() => {
      const update = this.db.prepare("UPDATE payer_payments SET status=?, checkpoint=?, judging_index=? WHERE alias=? AND status='prepared'");
      for (const { alias: name, status } of updates) update.run(status, status === "final" ? checkpoint! : null,
        status === "final" ? at.toString() : null, name);
    });
  }
  /** The prover's record must be exactly the task and verify under the wallet's own verifier. */
  private async proven(task: ProofTask, prove: LocalProver): Promise<Uint8Array> {
    // The evidence read awaited: an export or another handle may have taken over meanwhile.
    this.mutable();
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
    return bytes;
  }
  private holdingsOf(notes: readonly OwnedNote[], force: ForceState | undefined, at: bigint): Holding[] {
    const reserved = this.db.prepare("SELECT 1 FROM payer_inputs WHERE nf=?");
    return notes.map(note => Object.freeze({ cm: note.cm, value: note.opening.value,
      status: reserved.get(note.nf.toString()) !== undefined ? "reserved" as const :
        force !== undefined && locked(force, tagOf(note.nf), at) ? "locked" as const : "available" as const }));
  }

  /** Secret material for independently secured offline backup; never send to a
   * payer/service. `restoreSeed` recovers holdings from it, not local state. */
  recoverySeed(): Uint8Array { this.active(); return new Uint8Array(this.seed); }

  /** frozen: this database was exported and only its restored copy may act;
   * restoredFrom: the digest of the encrypted handoff this database was restored
   * from, which reconciles a lost restore reply. */
  custody(): { readonly frozen: boolean; readonly restoredFrom?: string } {
    this.active();
    const row = this.db.prepare("SELECT export, restored_from FROM wallet_custody WHERE id=1").get()!;
    return { frozen: row.export !== null, ...(row.restored_from === null ? {} : { restoredFrom: row.restored_from as string }) };
  }

  /** Offline handoff of the complete local state: the seed, labels, requests,
   * fulfillments, payments, reservations, openings, receipts and superseded
   * records, sealed under the caller's random 32-byte key. The export and the
   * source's freeze commit together, so the source never acts again and the
   * backup cannot miss a later request, reservation or fulfillment. A repeated
   * call (also after restart, for a lost reply) returns the same bytes, and only
   * to the same key. The caller keeps the key and `walletBackupDigest(bytes)`
   * independently and activates one restore. Unsupported schema or excess size
   * refuses before freezing. Quiesce operations first: freezing cannot recall a
   * submission already sent; the restored copy's exact retry reconciles it. */
  exportBackup(key: Uint8Array): Uint8Array {
    requireThat(key instanceof Uint8Array && key.length === 32, "INVALID", "backup key must be 32 bytes");
    const ownedKey = copyUnshared(key);
    try {
      return this.transaction(() => {
        const old = this.db.prepare("SELECT export FROM wallet_custody WHERE id=1").get()!.export as Uint8Array | null;
        if (old !== null) {
          const bytes = copyUnshared(old);
          try { openWalletBackup(bytes, ownedKey, this.domain, this.venueId, walletBackupDigest(bytes)).fill(0); }
          catch { throw new V3WalletError("INVALID", "invalid wallet backup or recovery credentials"); }
          return bytes;
        }
        // Exact definitions, not only names: any other shape could export, freeze and then never restore.
        const stored = new Map(this.db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table'").all()
          .map(row => [row.name as string, String(row.sql).replace(/\s+/g, " ").trim()]));
        requireThat(stored.size === DEFINITIONS.size && [...DEFINITIONS].every(([name, sql]) => stored.get(name) === sql),
          "INVALID", "unsupported wallet schema");
        let size = WALLET_BACKUP_OVERHEAD + 4 + Buffer.byteLength(PROFILE) + 32;
        const tables = TABLES.map(([table, columns]) => {
          const rows: WalletCell[][] = [];
          size += 4;
          for (const row of this.db.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).iterate()) {
            const cells = columns.map(column => row[column] as WalletCell);
            size += cells.reduce((n, cell) => n + cellBytes(cell), 0);
            requireThat(size <= MAX_WALLET_BACKUP_BYTES, "INVALID", "wallet exceeds the offline backup limit");
            rows.push(cells);
          }
          return rows;
        });
        requireThat(size <= MAX_WALLET_BACKUP_BYTES, "INVALID", "wallet exceeds the offline backup limit");
        const plaintext = encodeWalletSnapshot({ profile: PROFILE, seed: this.seed, tables });
        try {
          const bytes = sealWalletBackup(plaintext, ownedKey, this.domain, this.venueId);
          this.db.prepare("UPDATE wallet_custody SET export=? WHERE id=1").run(bytes);
          return bytes;
        } finally { plaintext.fill(0); }
      }, true);
    } finally { ownedKey.fill(0); }
  }

  /** Restore an encrypted handoff into a new destination for the same
   * configuration and venue. The envelope must hash to the independently kept
   * digest and open under the key; the state commits in one transaction with
   * that digest as provenance, in a staging file linked to `path` only once
   * complete. A refused or interrupted restore leaves nothing at `path`; if a
   * reply is lost and `path` exists, `custody().restoredFrom` confirms it. */
  static restoreBackup(path: string, options: PackageReader, bytes: Uint8Array, key: Uint8Array, expectedDigest: string): V3Wallet {
    const own = ownOptions(options);
    let plaintext: Uint8Array;
    try { plaintext = openWalletBackup(bytes, key, own.domain, own.venueId, expectedDigest); }
    catch { throw new V3WalletError("INVALID", "invalid wallet backup or recovery credentials"); }
    let snapshot: WalletSnapshot;
    try { snapshot = decodeWalletSnapshot(plaintext, TABLES.map(([, columns]) => columns.length)); }
    catch { throw new V3WalletError("INVALID", "invalid wallet snapshot"); }
    finally { plaintext.fill(0); }
    requireThat(snapshot.profile === PROFILE, "INVALID", "wallet snapshot has another profile");
    try { return V3Wallet.create(path, own, { seed: snapshot.seed, tables: snapshot.tables, digest: expectedDigest }); }
    finally { snapshot.seed.fill(0); }
  }

  /** C4.6: a new wallet from a backed-up seed alone. `sync` finds the same
   * positive unspent notes, change included, from complete public evidence; no
   * request, label, fulfillment or pending payment returns (C4.2), and new
   * requests draw fresh identifiers. A payment another copy prepared but did not
   * finish is unknown here; its inputs show available until spent. One active
   * copy of a seed remains the holder's precondition. */
  static restoreSeed(path: string, options: PackageReader, seed: Uint8Array): V3Wallet {
    const own = identifier(seed);
    try { return V3Wallet.create(path, ownOptions(options), { seed: own, tables: TABLES.map(() => []), digest: null }); }
    finally { own.fill(0); }
  }

  /** The wallet is built and committed in an exclusively created staging file
   * beside `path`, checkpointed and closed, then hard-linked to `path`, which
   * fails if anything exists there; the parent is trusted local storage. So
   * `path` either does not exist or holds the complete restore, and a
   * destination another process created first is never touched. The staging
   * name is removed in every case; only a crash can leave it, holding
   * plaintext wallet state for the holder to delete. */
  private static create(path: string, own: ReturnType<typeof ownOptions>, restore: Omit<Installation, "domain" | "venue">): V3Wallet {
    persistentPath(path);
    const fresh = () => requireThat(!existsSync(path) && !existsSync(`${path}-wal`) && !existsSync(`${path}-shm`),
      "CONFLICT", "recovery requires a new destination");
    fresh();
    const staging = `${path}.restore-${hex(randomBytes(8))}`;
    try { closeSync(openSync(staging, "wx", 0o600)); }
    catch { throw new V3WalletError("STORAGE", "cannot create the recovery destination"); }
    try {
      installing = { ...restore, domain: own.domain, venue: own.venueId };
      let wallet: V3Wallet;
      try { wallet = new V3Wallet(staging, own.reader); } finally { installing = undefined; }
      try {
        requireThat(wallet.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy === 0, "STORAGE", "staging checkpoint was blocked");
      } finally { wallet.close(); }
      fresh();
      try { linkSync(staging, path); } catch (error) {
        requireThat((error as NodeJS.ErrnoException).code !== "EEXIST", "CONFLICT", "recovery requires a new destination");
        throw new V3WalletError("STORAGE", "cannot create the recovery destination");
      }
    } finally {
      for (const file of [staging, `${staging}-wal`, `${staging}-shm`]) rmSync(file, { force: true });
    }
    return new V3Wallet(path, own.reader);
  }

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
      judgingIndex: BigInt(row.judging_index as string),
      terms: { terms: copyUnshared(row.terms as Uint8Array), signature: copyUnshared(row.signature as Uint8Array) } };
  }

  /** C4.5: final acceptance against the complete canonical frontier at the
   * independently witnessed current index. Pending receipts cannot fulfill.
   * The evidence read is what the wallet's evidence file retains; the caller
   * must arrange independent retention of it and of the authenticated venue
   * evidence, since keeping a copy cannot guarantee availability. */
  async fulfill(name: string, packageBytes: Uint8Array, signed: SignedTerms): Promise<Fulfillment> {
    name = alias(name); this.mutable();
    const note = this.prepared(name);
    requireThat(this.fulfillment(name) === undefined, "CONFLICT", "request already fulfilled");
    requireThat(same(rootTermsName(copyUnshared(signed.terms)), note.opening.backing), "INVALID", "terms do not name requested backing");
    await this.read(packageBytes, signed, ({ terms, backing, at, observed, canonical, force }) => {
      requireThat(same(backing, note.opening.backing), "INVALID", "terms do not name requested backing");
      requireThat(canonical !== undefined && force !== undefined, "ABSENT", "no canonical payment");
      const paid = canonical.state.output(note.cm);
      requireThat(paid?.capsule !== undefined && same(paid.capsule, note.capsule),
        "ABSENT", "exact requested output and capsule are absent");
      requireThat(!force.hasNullifier(note.nf), "SPENT", "payment is already spent");
      requireThat(!locked(force, tagOf(note.nf), at), "LOCKED", "payment is locked by a standing demand");
      const checkpoint = encodeCommitment(canonical.commitment);
      // No async callback between the venue check and the durable write.
      observed.check();
      this.transaction(() => {
        requireThat(this.db.prepare("SELECT 1 FROM receiver_fulfilled WHERE alias=? OR cm=?").get(name, note.cm.toString()) === undefined,
          "CONFLICT", "request or payment already fulfilled");
        this.db.prepare("INSERT INTO receiver_fulfilled VALUES(?,?,?,?,?,?)").run(name, note.cm.toString(), checkpoint,
          at.toString(), terms.terms, terms.signature);
      });
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
        { checkpoint: decodeCommitment(row.checkpoint as Uint8Array), judgingIndex: BigInt(row.judging_index as string) },
      superseded: this.db.prepare("SELECT record,receipt FROM payer_superseded WHERE alias=? ORDER BY rowid").all(name).map(old =>
        ({ record: copyUnshared(old.record as Uint8Array), receipt: old.receipt === null ? undefined : decodeReceipt(old.receipt as Uint8Array) })) };
  }

  /** This backing's holdings through the complete canonical frontier at the
   * venue's current index; resolves saved payments final or failed from that
   * evidence. A payment still prepared after its segment stopped being
   * canonical needs `reprove`. */
  async sync(packageBytes: Uint8Array, signed: SignedTerms): Promise<WalletView> {
    this.mutable();
    return this.read(packageBytes, signed, ({ backing, at, observed, canonical, force, notes }) => {
      const updates: { alias: string; status: "final" | "failed" }[] = [];
      if (canonical !== undefined && force !== undefined) {
        for (const row of this.db.prepare("SELECT alias,record FROM payer_payments WHERE status='prepared' AND backing=?").all(backing)) {
          const status = this.resolution(row.alias as string, decodeRecord(row.record as Uint8Array), canonical, force);
          if (status !== undefined) updates.push({ alias: row.alias as string, status });
        }
      }
      observed.check();
      this.resolve(updates, canonical === undefined ? undefined : encodeCommitment(canonical.commitment), at);
      return { backing, judgingIndex: at, checkpoint: canonical?.commitment, holdings: this.holdingsOf(notes, force, at) };
    });
  }

  /** pool-fees C1.2.3–5: pay one exact request, and optionally one exact fee
   * request, from this seed's holdings in the canonical segment. The record is
   * saved with permanent input/output reservations before it is returned; an
   * exact alias retry returns the saved record without evidence or proving,
   * and the same alias with another order refuses (C1.2.5).
   * Selection is advisory: the operator and later replay judge spentness. */
  async prepare(name: string, order: PaymentOrder, packageBytes: Uint8Array, signed: SignedTerms,
    prove: LocalProver): Promise<Payment> {
    name = alias(name); this.mutable();
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

    const planned = await this.read(packageBytes, signed, view => {
      const { canonical, force, notes, at, observed } = view;
      // A concurrent exact call may have saved while this one read: answer it before selection.
      const racing = sameOrder();
      if (racing !== undefined) {
        requireThat(racing, "CONFLICT", "alias names another payment order");
        return undefined;
      }
      requireThat(canonical !== undefined, "ABSENT", "no canonical checkpoint to spend from");
      requireThat(theirs.every(cm => !canonical.state.hasOutput(cm)), "CONFLICT", "request is already paid");
      const header = this.admissible(view);
      // The venue view behind this decision is checked before proving.
      observed.check();
      const holdings = this.holdingsOf(notes, force, at), available = notes.filter((_, i) => holdings[i]!.status === "available");
      const selected = select(available, total), sum = selected.reduce((n, note) => n + note.opening.value, 0n);
      const inputs: NoteInput[] = selected.map(note => ({ note, anchor: note.anchor, path: note.path }));
      // A zero input names the same backing and needs no membership (C1.2.3).
      const zero = inputs.length === 1 ? this.fresh(backing, 0n) : undefined;
      if (zero !== undefined) inputs.push({ ...inputs[0]!, note: zero });
      const outputs: OutputNote[] = [payee, ...(fee === undefined ? [] : [fee.request]), this.fresh(backing, sum - total)];
      while (outputs.length < 4) outputs.push(this.fresh(backing, 0n));
      // Public order labels no position (C1.2.3); the saved record fixes it for retries.
      for (let i = outputs.length - 1; i > 0; i--) { const j = randomInt(i + 1); [outputs[i], outputs[j]] = [outputs[j]!, outputs[i]!]; }
      return { header, selected, inputs, zero, outputs, at };
    });
    if (planned === undefined) return this.payment(name)!;
    const { header, selected, inputs, zero, outputs, at } = planned;
    const bytes = await this.proven(spendTask({ domain: this.domain, header }, inputs, outputs), prove);
    const statement = hex(statementHash(decodeRecord(bytes))), reserved = selected.map(note => note.nf.toString());
    this.transaction(() => {
      // A concurrent exact call may have saved first: adopt its record, never this proof.
      const winner = sameOrder();
      if (winner !== undefined) { requireThat(winner, "CONFLICT", "alias names another payment order"); return; }
      const input = this.db.prepare("SELECT 1 FROM payer_inputs WHERE nf=?");
      requireThat(reserved.every(nf => input.get(nf) === undefined), "CONFLICT", "an input is reserved by another payment");
      requireThat(outputs.every(out => taken.get(out.cm.toString()) === undefined), "CONFLICT", "an output belongs to another payment");
      this.db.prepare("INSERT INTO payer_payments VALUES(?,?,?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL,?,?)").run(name, statement, bytes,
        backing, header.operator, payee.cm.toString(), value.toString(), fee?.request.cm.toString() ?? null, fee?.value.toString() ?? null,
        zero?.requestId ?? null, at.toString());
      for (const nf of reserved) this.db.prepare("INSERT INTO payer_inputs VALUES(?,?)").run(nf, name);
      // Every opening is kept so a reproof can rebuild the same outputs (C1.2.5).
      for (const { cm, opening } of outputs) this.db.prepare("INSERT INTO payer_outputs VALUES(?,?,?,?,?)")
        .run(cm.toString(), name, opening.value.toString(), opening.owner.toString(), opening.rho.toString());
    });
    return this.payment(name)!;
  }

  /** pool-fees C1.2.5 and C4.4: once a prepared payment's segment is no longer
   * the canonical one (its term ended or silence lapsed its tail), prove the
   * same statement again in the canonical segment. The input nullifiers,
   * outputs, capsules and order are the saved ones; only the segment, scope
   * and anchors change. A payment already final or failed by the current
   * evidence is resolved without proving. One whose record already names the
   * canonical segment is returned unchanged while that segment can admit it,
   * and refused with the admission code (CONFLICT, SILENCE) while it cannot. A
   * view older than the one the saved record was built from is refused: a dead
   * segment never becomes canonical again. Both records spend the same
   * nullifiers into the same commitments, so at most one can ever be admitted
   * into canonical history. The superseded record and any receipt are kept. */
  async reprove(name: string, packageBytes: Uint8Array, signed: SignedTerms, prove: LocalProver): Promise<Payment> {
    name = alias(name); this.mutable();
    const saved = this.payment(name);
    requireThat(saved !== undefined, "UNKNOWN", "unknown payment");
    if (saved.status !== "prepared") return saved;
    const row = this.db.prepare("SELECT backing,zero,judged FROM payer_payments WHERE alias=?").get(name)!;
    const backing = copyUnshared(row.backing as Uint8Array);
    requireThat(same(rootTermsName(copyUnshared(signed.terms)), backing), "INVALID", "terms do not name the payment's backing");
    requireThat(typeof prove === "function", "INVALID", "a local prover is required");
    const old = decodeRecord(saved.record), p = old.publicInputs;
    const planned = await this.read(packageBytes, signed, view => {
      const { canonical, force, notes, at, observed } = view;
      requireThat(canonical !== undefined && force !== undefined, "ABSENT", "no canonical checkpoint to spend from");
      requireThat(at >= BigInt(row.judged as string), "CHANGED_VIEW", "the venue view is older than the saved record's");
      const status = this.resolution(name, old, canonical, force);
      if (status !== undefined) {
        observed.check();
        this.resolve([{ alias: name, status }], encodeCommitment(canonical.commitment), at);
        return this.payment(name)!;
      }
      const header = this.admissible(view);
      if (same(identifierOf(p[2]!, p[3]!), canonical.segment)) return saved;
      observed.check();
      // The same notes, now read in the canonical segment's accepted history.
      const zero = row.zero === null ? undefined : prepareExactOutput(this.seed, this.domain, row.zero as Uint8Array, backing, 0n);
      const positive = saved.inputs.map(nf => notes.find(note => note.nf === nf));
      requireThat(positive.every(note => note !== undefined), "ABSENT", "a reserved input is not in canonical history");
      requireThat(!positive.some(note => locked(force, tagOf(note.nf), at)), "LOCKED", "a reserved input is locked by a standing demand");
      const placed = positive.map(note => ({ note, anchor: note.anchor, path: note.path }));
      const inputs: NoteInput[] = p.slice(7, 9).map(nf => {
        if (zero !== undefined && nf === zero.nf) return { ...placed[0]!, note: zero };
        const input = placed.find(i => i.note.nf === nf);
        requireThat(input !== undefined, "STORAGE", "saved inputs do not reproduce the record");
        return input;
      });
      const opening = this.db.prepare("SELECT value,owner,rho FROM payer_outputs WHERE cm=? AND alias=?");
      const outputs: OutputNote[] = p.slice(9, 13).map((cm, i) => {
        const out = opening.get(cm.toString(), name);
        requireThat(out !== undefined, "STORAGE", "saved outputs do not reproduce the record");
        const note = { backing, value: BigInt(out.value as string), owner: BigInt(out.owner as string), rho: BigInt(out.rho as string) };
        requireThat(commitmentOf(this.domain, note) === cm, "STORAGE", "saved outputs do not reproduce the record");
        return { opening: note, cm, capsule: old.capsules[i]! };
      });
      return { header, inputs, outputs, at };
    });
    if (!("header" in planned)) return planned;
    const { header, inputs, outputs, at } = planned;
    const bytes = await this.proven(spendTask({ domain: this.domain, header }, inputs, outputs), prove);
    const statement = hex(statementHash(decodeRecord(bytes)));
    this.transaction(() => {
      // A concurrent reproof or resolution may have replaced the record first: keep it.
      const current = this.db.prepare("SELECT receipt FROM payer_payments WHERE alias=? AND statement=? AND status='prepared'")
        .get(name, hex(saved.statement));
      if (current === undefined) return;
      this.db.prepare("INSERT INTO payer_superseded VALUES(?,?,?,?)").run(hex(saved.statement), name, saved.record, current.receipt as Uint8Array | null);
      this.db.prepare("UPDATE payer_payments SET statement=?, record=?, operator=?, receipt=NULL, judged=? WHERE alias=?")
        .run(statement, bytes, header.operator, at.toString(), name);
    });
    return this.payment(name)!;
  }

  /** Submit the saved exact record; keep the first operator receipt that signs
   * its statement in the record's own segment. A receipt is pending operator
   * liability (C2.10.9), not finality; `sync` decides that from evidence. */
  async submit(name: string, service: { submit(record: Uint8Array): Promise<Receipt> }): Promise<Receipt> {
    name = alias(name); this.mutable();
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
    const current = this.transaction(() => {
      const statement = hex(saved.statement), bytes = encodeReceipt(receipt);
      if (this.db.prepare("SELECT 1 FROM payer_payments WHERE alias=? AND statement=?").get(name, statement) !== undefined) {
        this.db.prepare("UPDATE payer_payments SET receipt=? WHERE alias=? AND receipt IS NULL").run(bytes, name);
        return true;
      }
      // A reproof during submission replaced the record: the receipt stays with the
      // superseded record as evidence of that operator's acceptance (C2.10.9).
      this.db.prepare("UPDATE payer_superseded SET receipt=? WHERE alias=? AND statement=? AND receipt IS NULL").run(bytes, name, statement);
      return false;
    });
    requireThat(current, "CONFLICT", "the payment was re-proven during submission");
    return this.payment(name)!.receipt!;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.seed.fill(0);
    this.retained?.close(); this.replays?.close(); this.db.close();
  }
}
