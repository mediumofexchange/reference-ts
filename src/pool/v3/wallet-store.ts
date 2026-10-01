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
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { verifySignatureStrict } from "../../keys.js";
import type { RecordPublisher, RecordVenue } from "../../record-venue.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../../venue-records.js";
import { identifierOf, isField, isValue } from "../field.js";
import { commitmentOf, ownerOf } from "../notes.js";
import { deriveSettlementOwnerSecret, prepareExactOutput, type PreparedOutput } from "./capsules.js";
import { decodeReceipt, encodeReceipt, verifyReceipt, type Receipt } from "./commitments.js";
import { adoptedDomain, requireConfigurationVerifier } from "./configuration.js";
import { requireReferenceVenue } from "./guard.js";
import { EvidenceStore } from "./evidence-store.js";
import type { SegmentHeader } from "./headers.js";
import { ownedNotes, seedWitness, type OwnedNote } from "./holdings.js";
import { readFrontier, type PackageReader } from "./package-reader.js";
import type { SignedTerms } from "./reader.js";
import { acceptanceBytes, acceptanceId, decodeRecord, encodePublication, encodeRecord, evidenceHashes, settlementAuthorization,
  statementBytes, statementHash, type Record, type SignedAcceptance } from "./records.js";
import { paddingRequestId, presenterSecret, settlementRho } from "./redemption.js";
import { KeptStateMismatch, ReplayStore, type Demand } from "./replay-store.js";
import type { CanonicalCheckpoint, FrontierResult } from "./scope-reader.js";
import { locked, tagOf } from "./recovery.js";
import { applyForceEffects, openForceState, type ForceState } from "./state.js";
import { declaredParallel } from "./verify-ahead.js";
import { decodeRootTerms, rootTermsName } from "./terms.js";
import { cellBytes, decodeWalletSnapshot, encodeWalletSnapshot, MAX_WALLET_BACKUP_BYTES, openWalletBackup, sealWalletBackup,
  WALLET_BACKUP_OVERHEAD, walletBackupDigest, type WalletCell, type WalletSnapshot } from "./wallet-backup.js";
import { copyPaymentRequest, type PaymentRequest } from "./wallet-request.js";
import { authorizeSettlement, burnTask, demandTask, issueTask, settleTask, spendTask, withdrawalRecord, type NoteInput, type OutputNote,
  type ProofTask } from "./witness.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const PROFILE = "moe/wallet/v3/6", MAX_OWNER = (1n << 63n) - 1n;
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
 * refuses before its source freezes. Every record the wallet builds, a payment (kind 2) or an act, is one saved
 * record under one alias namespace, with the notes it reserves, the output openings and zero input a reproof
 * rebuilds it from, and the records a reproof superseded. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallet_identity (id INTEGER PRIMARY KEY CHECK(id=1),
    profile TEXT NOT NULL, domain TEXT NOT NULL, venue TEXT NOT NULL, seed BLOB NOT NULL, owner INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS receiver_requests (alias TEXT PRIMARY KEY, request_id BLOB NOT NULL UNIQUE,
    backing BLOB NOT NULL, value TEXT NOT NULL, cm TEXT NOT NULL UNIQUE) STRICT;
  CREATE TABLE IF NOT EXISTS receiver_fulfilled (alias TEXT PRIMARY KEY, cm TEXT NOT NULL UNIQUE,
    checkpoint BLOB NOT NULL, judging_index TEXT NOT NULL, terms BLOB NOT NULL, signature BLOB NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS saved_records (alias TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('1','2','3','4','5','6')),
    intent TEXT NOT NULL, statement TEXT NOT NULL UNIQUE, record BLOB NOT NULL, backing BLOB NOT NULL, operator BLOB NOT NULL,
    demand TEXT, zero BLOB, status TEXT NOT NULL CHECK(status IN ('prepared','final','failed')), receipt BLOB, checkpoint BLOB,
    judging_index TEXT, judged TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS saved_inputs (nf TEXT NOT NULL, alias TEXT NOT NULL REFERENCES saved_records(alias),
    PRIMARY KEY(nf, alias)) STRICT;
  CREATE TABLE IF NOT EXISTS saved_outputs (cm TEXT PRIMARY KEY, alias TEXT NOT NULL REFERENCES saved_records(alias),
    value TEXT NOT NULL, owner TEXT NOT NULL, rho TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS saved_superseded (statement TEXT NOT NULL, alias TEXT NOT NULL REFERENCES saved_records(alias),
    record BLOB NOT NULL, receipt BLOB) STRICT;
  CREATE TABLE IF NOT EXISTS backer_acceptances (alias TEXT PRIMARY KEY, demand TEXT NOT NULL, deadline TEXT NOT NULL,
    owner TEXT NOT NULL, signature BLOB NOT NULL, UNIQUE(demand, deadline)) STRICT;
  CREATE TABLE IF NOT EXISTS wallet_custody (id INTEGER PRIMARY KEY CHECK(id=1), export BLOB, restored_from TEXT) STRICT;`;
const DEFINITIONS = new Map(SCHEMA.split(";").map(s => s.replace(/\s+/g, " ").trim()).filter(s => s !== "")
  .map(s => { const sql = s.replace("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE "); return [sql.split(" ")[2]!, sql] as const; }));
/** The wallet's state tables and columns in export order; fixed names, never SQL
 * supplied by a backup. Identity and custody rows are not transferred: the
 * destination takes the seed, a fresh owner fence and its own provenance. */
const TABLES = [
  ["receiver_requests", ["alias", "request_id", "backing", "value", "cm"]],
  ["receiver_fulfilled", ["alias", "cm", "checkpoint", "judging_index", "terms", "signature"]],
  ["saved_records", ["alias", "kind", "intent", "statement", "record", "backing", "operator", "demand", "zero", "status", "receipt",
    "checkpoint", "judging_index", "judged"]],
  ["saved_inputs", ["nf", "alias"]],
  ["saved_outputs", ["cm", "alias", "value", "owner", "rho"]],
  ["saved_superseded", ["statement", "alias", "record", "receipt"]],
  ["backer_acceptances", ["alias", "demand", "deadline", "owner", "signature"]],
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
  const { verifier, venue, reference } = options;
  const ownReference = structuredClone(reference), venueId = requireReferenceVenue(ownReference, venue);
  const verify = verifier.verify.bind(verifier);
  const identities = requireConfigurationVerifier(verifier.identities), parallel = declaredParallel(verifier);
  const reader: PackageReader = { verifier: { verify, ...(identities === undefined ? {} : { identities }),
    ...(parallel === undefined ? {} : { parallel }) },
    venue, reference: ownReference };
  return { domain: adoptedDomain(), venueId, reader };
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
  /** The positive inputs' nullifiers this payment reserves until it is final or failed. */
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
/** A demand of this seed standing over the backing (C3.3): its identity, notice and the holdings it names. */
export interface StandingDemand {
  readonly id: Uint8Array;
  readonly quantity: bigint;
  readonly instant: bigint;
  readonly deadline: bigint;
  readonly holdings: readonly bigint[];
}
/** One backing's holdings at an independently witnessed index; no claim about other backings or venues. */
export interface WalletView {
  readonly backing: Uint8Array;
  readonly judgingIndex: bigint;
  readonly checkpoint: Commitment | undefined;
  readonly holdings: readonly Holding[];
  /** This seed's demands standing in that view, saved here or not: one a lost wallet made is found from the seed. */
  readonly demands: readonly StandingDemand[];
}

/** K's strict Ed25519 signature over exact bytes, from a signer the backer holds. K's secret never enters the
 * wallet; every signature is checked against the terms' obligor before it is used or saved. */
export type BackerSigner = (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;
/** A saved redemption act (pool-recovery C3, pool-v3 §3): an issue or burn, or a demand, its withdrawal or settlement. */
export interface Act {
  readonly kind: 1 | 3 | 4 | 5 | 6;
  /** The exact canonical record every submission retry sends. */
  readonly record: Uint8Array;
  readonly statement: Uint8Array;
  /** The demand's identity, for a demand, its withdrawal and its settlement. */
  readonly demand: Uint8Array | undefined;
  /** The positive inputs' nullifiers it reserves while prepared: a burn's, a demand's, and a settlement's (its demand's). */
  readonly inputs: readonly bigint[];
  /** prepared: not yet in canonical history; final: its effect is; failed: it can no longer take effect as saved. */
  readonly status: "prepared" | "final" | "failed";
  readonly receipt: Receipt | undefined;
  readonly final: { readonly checkpoint: Commitment; readonly judgingIndex: bigint } | undefined;
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
  readonly releases: FrontierResult["releases"];
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
/** C3.3: a demand names whole notes, so one note of exactly `total` or a pair summing to it; ties by commitment.
 * A holder presenting part of a note, or more than two, first pays itself the exact amount. */
function exact(notes: readonly OwnedNote[], total: bigint): OwnedNote[] {
  const sorted = [...notes].sort((a, b) => a.cm < b.cm ? -1 : a.cm > b.cm ? 1 : 0);
  const single = sorted.find(n => n.opening.value === total);
  if (single !== undefined) return [single];
  for (let i = 0; i < sorted.length; i++) {
    const other = sorted.find((n, j) => j > i && sorted[i]!.opening.value + n.opening.value === total);
    if (other !== undefined) return [sorted[i]!, other];
  }
  throw new V3WalletError("FUNDS", "no available note or pair of notes is exactly the quantity; pay yourself that amount first");
}

export class V3Wallet {
  private readonly db: DatabaseSync;
  private readonly options: PackageReader;
  private readonly domain: Uint8Array;
  private readonly venueId: Uint8Array;
  private readonly seed: Uint8Array;
  private readonly owner: bigint;
  private readonly path: string;
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
      requireThat(meta.profile === PROFILE, "CONFLICT", "wallet database has another profile");
      requireThat(meta.domain === hex(this.domain) && meta.venue === hex(this.venueId), "CONFLICT", "wallet configuration or venue changed");
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
    // A prepared record always reserves its inputs, and saving one other than a settlement re-checks every
    // reservation: no wallet writes two outside settlements (`saveAct`).
    requireThat(this.db.prepare(`SELECT 1 FROM saved_inputs i JOIN saved_records a ON a.alias=i.alias WHERE a.status='prepared'
      AND a.kind!='6' GROUP BY i.nf HAVING COUNT(*) > 1`).get() === undefined, "INVALID", "backup state reserves a note twice");
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
    // A file of another layout, or one that is no database, is never replaced here: it may be the holder's
    // only copy of the evidence. The holder removes it to sync again from nothing.
    try { return this.retained ??= new EvidenceStore(`${this.path}.evidence`); } catch (error) {
      if (error instanceof Error && /in use/.test(error.message)) throw new V3WalletError("STORAGE", "another handle holds this wallet's evidence file");
      throw new V3WalletError("STORAGE", "the wallet's evidence file cannot be read; remove it to sync again");
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
   * it again in full (`{ full: true }`). A transport must not call this wallet's reads or `supply`: they
   * would wait for the turn it holds.
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
  private async read<T>(packageBytes: Uint8Array, signed: SignedTerms, use: (view: Frontier) => T, releases = false): Promise<T> {
    const bytes = copyUnshared(packageBytes), terms = { terms: copyUnshared(signed.terms), signature: copyUnshared(signed.signature) };
    const backing = rootTermsName(terms.terms);
    return this.inTurn(async () => {
      let view: Frontier;
      try {
        this.mutable();
        view = await this.frontier(bytes, terms, backing, releases);
      } catch (error) {
        // A replaced or exported handle says so, whatever its read met once another handle held the files.
        if (!(error instanceof V3WalletError)) this.mutable();
        if (error instanceof Error && error.message === "the kept replay file is in use") {
          throw new V3WalletError("STORAGE", "another handle holds this wallet's kept replay file");
        }
        throw error;
      }
      // The read awaited: a handle replaced or exported meanwhile answers nothing from it.
      this.mutable();
      return use(view);
    });
  }
  private async frontier(bytes: Uint8Array, terms: SignedTerms, backing: Uint8Array, releases: boolean) {
    const at = this.options.venue.witnessedIndex();
    requireThat(isValue(at), "INVALID", "invalid witnessed index");
    const observed = heldView(this.options.venue, this.venueId, at), store = this.kept();
    // Kept answers stand only while the venue's finality rule does (§13.2). A venue whose clock is behind what
    // the kept state was read through is not the view that state was read from: nothing kept is used, and
    // the venue is asked for everything. (One replaced at the same clock is believed, as any venue's answers are.)
    const seen = store?.answersThrough();
    if (store !== undefined && seen !== undefined && at < seen) store.discardKept();
    // The scanner's keys live for this read only.
    const options = { ...this.options, venue: observed.venue, witness: seedWitness(this.seed, this.domain), evidence: this.evidence(), releases,
      ...(store === undefined ? {} : { store }) };
    for (let again = false; ; again = true) {
      try {
        const result = await readFrontier(bytes, terms, at, options);
        const canonical = result.canonical;
        let force: ForceState | undefined, notes: OwnedNote[] = [];
        if (canonical !== undefined) {
          force = openForceState(canonical.state);
          // Each publication past its own backing's adoption index: each scoped backing has its own.
          const adoption = canonical.state.adoptionIndices;
          for (const publication of result.force) {
            if (publication.index > (adoption.get(publication.backing) ?? 0n)) applyForceEffects(force, publication.record);
          }
          const spent = force;
          // The scan ran inside the replay, once per output: only this seed's witnessed outputs are read here.
          notes = ownedNotes(this.seed, this.domain, backing, canonical.state).filter(note => !spent.hasNullifier(note.nf));
        }
        return { terms, backing, at, observed, canonical, force, notes, chain: result.ranges.chain, scopeChains: result.scopeChains,
          lag: result.ranges.lag, clock: result.clock, releases: result.releases };
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
  /** Where a new demand, withdrawal or release takes effect: under service while the operator could admit it
   * (`admissible`), or at the venue in a gap (C2b.3.2). The gap route is taken where the backing declares silence
   * and its horizon (index plus lag) is past the canonical checkpoint by more than the duration: no checkpoint
   * witnessed later than this read, the gap is then open at every index the act could first be witnessed at, so
   * the act is bound to the snapshot (the canonical checkpoint) and its holder publishes it (`publish`). The
   * operator's term and the scope's other clocks do not decide force there; the backing's own gap does. */
  private route(view: Frontier): { readonly header: SegmentHeader; readonly gap: boolean } {
    const { canonical, clock, at, lag } = view;
    if (canonical !== undefined && clock !== null && clock !== undefined && at + lag - canonical.index > BigInt(clock.duration)) {
      return { header: canonical.header, gap: true };
    }
    return { header: this.admissible(view), gap: false };
  }
  /** Whether this seed presents `demand`: its presenter key is the seed's derivation over its own notice (C3.3).
   * Only this seed derives that key, so a demand found in public evidence is recognized with no saved state. */
  private presents(demand: Demand): boolean {
    const secret = presenterSecret(this.seed, this.domain, demand.tags, demand.instant, demand.deadline);
    try { return same(ed25519.getPublicKey(secret), demand.presenter); } finally { secret.fill(0); }
  }
  /** This seed's demand `id` standing over the view's backing (admitted, or with force in a gap). Withdrawing and
   * settling need one, so its notice is read from the view, never from a saved record. */
  private standing(view: Frontier, id: Uint8Array): Demand {
    const demand = view.force?.demand(hex(id));
    requireThat(demand !== undefined && same(demand.backing, view.backing), "ABSENT", "the demand does not stand in canonical history");
    requireThat(this.presents(demand), "UNKNOWN", "the demand is not this wallet's");
    return demand;
  }
  /** This seed's demands standing over the view's backing, found through its unspent notes' tags. */
  private demandsOf(view: Frontier): StandingDemand[] {
    const { force, notes, backing } = view, found = new Map<string, StandingDemand>();
    if (force === undefined) return [];
    for (const note of notes) {
      for (const [id, demand] of force.demandsWithTag(tagOf(note.nf))) {
        if (found.has(id) || !same(demand.backing, backing) || !this.presents(demand)) continue;
        const holdings = demand.tags.filter(tag => tag !== 0n).map(tag => notes.find(n => tagOf(n.nf) === tag)?.cm);
        if (holdings.some(cm => cm === undefined)) continue;
        found.set(id, Object.freeze({ id: hexToBytes(id), quantity: demand.quantity, instant: demand.instant, deadline: demand.deadline,
          holdings: Object.freeze(holdings as bigint[]) }));
      }
    }
    return [...found].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, demand]) => demand);
  }
  /** C3.5's disclosure count for `demand` in `segment`: the distinct outputs of its releases bound to that segment
   * that the venue witnessed without force, each a strict signature of the demand's presenter key. Only that key
   * signs a release, so another party's copies disclose no new output and add nothing. */
  private disclosures(view: Frontier, demand: Uint8Array, presenter: Uint8Array, segment: Uint8Array): bigint {
    const outputs = new Set<bigint>();
    for (const release of view.releases) {
      if (same(release.demand, demand) && same(release.segment, segment) &&
          verifySignatureStrict(release.releaseSignature, release.releaseMessage, presenter)) outputs.add(release.output);
    }
    return BigInt(outputs.size);
  }
  /** A settlement of `demand` this wallet holds prepared with `rho`: `rho_out` reads no acceptance or owner, so a
   * second one at the same count would disclose with the first, from which K computes it for any owner (C3.5). */
  private pendingSettlement(demand: string, rho: bigint): boolean {
    return this.db.prepare("SELECT record FROM saved_records WHERE kind='6' AND demand=? AND status='prepared'").all(demand)
      .some(row => decodeRecord(row.record as Uint8Array).publicInputs[9] === rho);
  }
  /** A payment's fate. final: all four outputs are in canonical history, imports included (own change/zero outputs
   * are fresh, and a reproof spends the same nullifiers into the same commitments, so only this payment creates
   * them in whichever segment admitted it); failed: a reserved input was spent otherwise. */
  private paid(name: string, record: Record, canonical: CanonicalCheckpoint, force: ForceState) {
    if (record.publicInputs.slice(9, 13).every(cm => canonical.state.hasOutput(cm))) return "final" as const;
    return this.spent(name, force) ? "failed" as const : undefined;
  }
  private spent(name: string, force: ForceState): boolean {
    return this.db.prepare("SELECT nf FROM saved_inputs WHERE alias=?").all(name).some(r => force.hasNullifier(BigInt(r.nf as string)));
  }
  /** A prepared record goes final or failed; a failed one that evidence later shows admitted goes final. */
  private resolve(rows: readonly { alias: string; status: "final" | "failed" }[], checkpoint: Uint8Array, at: bigint): void {
    if (rows.length !== 0) this.transaction(() => {
      const update = this.db.prepare(`UPDATE saved_records SET status=?, checkpoint=?, judging_index=? WHERE alias=? AND (status='prepared'
        OR (status='failed' AND ?1='final'))`);
      for (const { alias: name, status } of rows) update.run(status, status === "final" ? checkpoint : null,
        status === "final" ? at.toString() : null, name);
    });
  }
  /** Each saved record of `backing` not yet final that the evidence now decides. A payment by its outputs (`paid`):
   * it moves with its segment by reproof, so a dead segment does not fail it. An act is final once its statement
   * is in canonical history, imports included, or (a demand, withdrawal or settlement) has force at the venue. An
   * output alone never decides an act: a settlement's or an issue's output is public before admission, so another
   * statement can create it first (C3.8). An act fails once it can no longer take effect as saved: its segment is no
   * longer the canonical one (a dead segment never becomes canonical again; a new alias acts in the live one), a
   * demand's instant has left C3.3's window at every horizon from this read on, an issue's or settlement's output
   * exists from another statement (a settlement's also from one with force), a reserved input was spent otherwise,
   * a withdrawal's demand was settled, or a settlement's demand no longer stands or its acceptance deadline has
   * passed (no door admits it after). Demands are judged after the acts that end them. A view older than the one a
   * record was built from decides no failure for it. A failure read from one view is local accounting: an operator
   * reading behind this wallet may still admit the record, which then goes final. */
  private resolutions(backing: Uint8Array, canonical: CanonicalCheckpoint, force: ForceState, at: bigint, lag: bigint):
    { alias: string; status: "final" | "failed" }[] {
    const rows = this.db.prepare("SELECT alias,kind,record,demand,status,judged FROM saved_records WHERE status!='final' AND backing=? ORDER BY kind='4'").all(backing);
    const decided = new Map<string, "final" | "failed">(), spent = (name: string) => this.spent(name, force);
    const ended = (demand: string, kind: "5" | "6") => this.db.prepare("SELECT alias,status FROM saved_records WHERE demand=? AND kind=?").all(demand, kind)
      .some(r => r.status === "final" || decided.get(r.alias as string) === "final");
    for (const row of rows) {
      const name = row.alias as string, record = decodeRecord(row.record as Uint8Array), p = record.publicInputs;
      const statement = statementHash(record), demand = row.demand as string | null;
      // A view older than the one the record was built from is not the record's history: it decides no failure.
      const stale = at < BigInt(row.judged as string);
      if (row.kind === "2") {
        const status = this.paid(name, record, canonical, force);
        if (status !== undefined && status !== row.status && !(stale && status === "failed")) decided.set(name, status);
        continue;
      }
      const admitted = canonical.state.hasEvent(statement) || (record.kind >= 4 && force.isEffective(hex(statement)));
      const dead = !same(identifierOf(p[2]!, p[3]!), canonical.segment);
      let status: "final" | "failed" | undefined;
      if (admitted) status = "final";
      else if (row.status === "failed" || stale) continue;
      else if (record.kind === 4) {
        // A relayed publication is witnessed at an index w ≥ at, so C3.3's window (w − 2·lag ≤ instant) is closed
        // for good once at > instant + 2·lag. An operator reading behind the venue is covered by failed → final.
        status = ended(demand!, "5") || ended(demand!, "6") ? "final" : dead || at > p[14]! + 2n * lag || spent(name) ? "failed" : undefined;
      } else if (dead) status = "failed";
      else switch (record.kind) {
        case 1: status = canonical.state.hasOutput(p[8]!) ? "failed" : undefined; break;
        case 3: status = spent(name) ? "failed" : undefined; break;
        case 5: status = ended(demand!, "6") ? "failed" : undefined; break;
        case 6: status = force.demand(demand!) === undefined || force.hasOutput(p[14]!) || spent(name) ||
          at > settlementAuthorization(record).acceptance.deadline ? "failed" : undefined; break;
      }
      if (status !== undefined) decided.set(name, status);
    }
    return [...decided].map(([name, status]) => ({ alias: name, status }));
  }
  /** The prover's record must be exactly the task, unauthorized, and its proof verify under the wallet's own
   * verifier. Only the proof is taken from it: the record returned is the wallet's own, and an issue or a
   * settlement is encoded once its authorization is added. */
  private async proven(task: ProofTask, prove: LocalProver): Promise<Record> {
    // The evidence read awaited: an export or another handle may have taken over meanwhile.
    this.mutable();
    const proven = await prove(task);
    let proof: Uint8Array;
    try {
      // Each prover field is read once.
      const { kind, domain, publicInputs, authorization, capsules } = proven;
      proof = copyUnshared(proven.proof);
      const inputs = [...publicInputs], outputs = [...capsules].map(c => copyUnshared(c));
      requireThat(kind === task.kind && same(copyUnshared(domain), this.domain) && copyUnshared(authorization).length === 0 &&
        inputs.length === task.publicInputs.length && inputs.every((v, i) => v === task.publicInputs[i]) &&
        outputs.length === task.capsules.length && outputs.every((c, i) => same(c, task.capsules[i]!)),
        "INVALID", "prover returned another statement");
    } catch (error) {
      if (error instanceof V3WalletError) throw error;
      throw new V3WalletError("INVALID", "prover returned a malformed record");
    }
    requireThat(await this.options.verifier.verify(task.kind, [...task.publicInputs], new Uint8Array(proof)) === true, "INVALID", "proof does not verify");
    return { domain: new Uint8Array(this.domain), kind: task.kind, publicInputs: [...task.publicInputs], proof,
      authorization: new Uint8Array(), capsules: task.capsules.map(c => new Uint8Array(c)) };
  }
  /** A record's canonical bytes; a proof of no admissible length is the prover's malformed record. */
  private encoded(record: Record): Uint8Array {
    try { return encodeRecord(record); } catch (error) {
      if (error instanceof EncodingError) throw new V3WalletError("INVALID", "prover returned a malformed record");
      throw error;
    }
  }
  /** A nullifier a saved record reserves while it can still take effect: a payment or a burn not failed, or a
   * demand still prepared. A demand that stands holds its notes by its own lock (C3.7, `locked`), which ends
   * with the demand, however it ends and whoever saved the act ending it, or at its deadline. */
  private reserved(nf: bigint): boolean {
    return this.db.prepare(`SELECT 1 FROM saved_inputs i JOIN saved_records a ON a.alias=i.alias WHERE i.nf=?
      AND (a.status='prepared' OR (a.status='final' AND a.kind!='4'))`).get(nf.toString()) !== undefined;
  }
  /** A new payment or act is built only from a view at least as recent as every view a saved record was built or
   * decided at: an older one may show a note free that a standing demand or a saved record holds, and a dead
   * segment live. Indices are u64 decimal text, compared by length, then lexically. */
  private current(at: bigint): void {
    const latest = (column: string) => this.db.prepare(`SELECT ${column} AS v FROM saved_records WHERE ${column} IS NOT NULL
      ORDER BY length(${column}) DESC, ${column} DESC LIMIT 1`).get()?.v as string | undefined;
    requireThat([latest("judged"), latest("judging_index")].every(v => v === undefined || at >= BigInt(v)), "CHANGED_VIEW",
      "the venue view is older than one this wallet's records were judged at");
  }
  private holdingsOf(notes: readonly OwnedNote[], force: ForceState | undefined, at: bigint): Holding[] {
    return notes.map(note => Object.freeze({ cm: note.cm, value: note.opening.value,
      status: this.reserved(note.nf) ? "reserved" as const :
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
    const row = this.db.prepare("SELECT * FROM saved_records WHERE alias=? AND kind='2'").get(name);
    if (row === undefined) return undefined;
    const [, payee, value, fee, feeValue] = JSON.parse(row.intent as string) as [string, string, string, string | null, string | null];
    const saved = this.saved(name, row);
    return { record: saved.record, statement: saved.statement, payee: BigInt(payee), value: BigInt(value),
      fee: fee === null ? undefined : { cm: BigInt(fee), value: BigInt(feeValue!) }, inputs: saved.inputs, status: saved.status,
      receipt: saved.receipt, final: saved.final,
      superseded: this.db.prepare("SELECT record,receipt FROM saved_superseded WHERE alias=? ORDER BY rowid").all(name).map(old =>
        ({ record: copyUnshared(old.record as Uint8Array), receipt: old.receipt === null ? undefined : decodeReceipt(old.receipt as Uint8Array) })) };
  }
  /** The fields a payment and an act share, read from a saved record's row. */
  private saved(name: string, row: { readonly [column: string]: unknown }) {
    const record = copyUnshared(row.record as Uint8Array);
    return { record, statement: statementHash(decodeRecord(record)),
      inputs: this.db.prepare("SELECT nf FROM saved_inputs WHERE alias=?").all(name).map(r => BigInt(r.nf as string))
        .sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      status: row.status as "prepared" | "final" | "failed", receipt: row.receipt === null ? undefined : decodeReceipt(row.receipt as Uint8Array),
      final: row.checkpoint === null ? undefined :
        { checkpoint: decodeCommitment(row.checkpoint as Uint8Array), judgingIndex: BigInt(row.judging_index as string) } };
  }

  /** This backing's holdings and this seed's standing demands through the
   * complete canonical frontier at the venue's current index; resolves saved
   * payments and acts final or failed from that evidence. A payment still
   * prepared after its segment stopped being canonical needs `reprove`; an act
   * whose segment ended fails and is made again under a new alias. */
  async sync(packageBytes: Uint8Array, signed: SignedTerms): Promise<WalletView> {
    this.mutable();
    return this.read(packageBytes, signed, view => {
      const { backing, at, lag, observed, canonical, force, notes } = view;
      const decided = canonical !== undefined && force !== undefined ? this.resolutions(backing, canonical, force, at, lag) : [];
      observed.check();
      if (canonical !== undefined) this.resolve(decided, encodeCommitment(canonical.commitment), at);
      return { backing, judgingIndex: at, checkpoint: canonical?.commitment, holdings: this.holdingsOf(notes, force, at),
        demands: this.demandsOf(view) };
    });
  }

  /** pool-fees C1.2.3–5: pay one exact request, and optionally one exact fee
   * request, from this seed's holdings in the canonical segment. The record is
   * saved with its input and output reservations before it is returned; an
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
    const intent = JSON.stringify([hex(backing), payee.cm.toString(), value.toString(), fee?.request.cm.toString() ?? null,
      fee?.value.toString() ?? null]);
    const sameOrder = (): boolean | undefined => {
      const row = this.db.prepare("SELECT kind,intent FROM saved_records WHERE alias=?").get(name);
      if (row === undefined) return undefined;
      requireThat(row.kind === "2", "CONFLICT", "alias names a saved act");
      return row.intent === intent;
    };
    const existing = sameOrder();
    if (existing !== undefined) {
      requireThat(existing, "CONFLICT", "alias names another payment order");
      return this.payment(name)!;
    }
    requireThat(typeof prove === "function", "INVALID", "a local prover is required");
    const theirs = [payee.cm, ...(fee === undefined ? [] : [fee.request.cm])];
    const taken = this.db.prepare("SELECT 1 FROM saved_outputs WHERE cm=?");
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
      this.current(view.at);
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
    const bytes = this.encoded(await this.proven(spendTask({ domain: this.domain, header }, inputs, outputs), prove));
    const statement = hex(statementHash(decodeRecord(bytes))), reserved = selected.map(note => note.nf.toString());
    this.transaction(() => {
      // A concurrent exact call may have saved first: adopt its record, never this proof.
      const winner = sameOrder();
      if (winner !== undefined) { requireThat(winner, "CONFLICT", "alias names another payment order"); return; }
      requireThat(selected.every(note => !this.reserved(note.nf)), "CONFLICT", "an input is reserved by another payment or act");
      requireThat(outputs.every(out => taken.get(out.cm.toString()) === undefined), "CONFLICT", "an output belongs to another payment");
      this.db.prepare("INSERT INTO saved_records VALUES(?,'2',?,?,?,?,?,NULL,?,'prepared',NULL,NULL,NULL,?)").run(name, intent, statement,
        bytes, backing, header.operator, zero?.requestId ?? null, at.toString());
      for (const nf of reserved) this.db.prepare("INSERT INTO saved_inputs VALUES(?,?)").run(nf, name);
      // Every opening is kept so a reproof can rebuild the same outputs (C1.2.5).
      for (const { cm, opening } of outputs) this.db.prepare("INSERT INTO saved_outputs VALUES(?,?,?,?,?)")
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
    const row = this.db.prepare("SELECT backing,zero,judged FROM saved_records WHERE alias=?").get(name)!;
    const backing = copyUnshared(row.backing as Uint8Array);
    requireThat(same(rootTermsName(copyUnshared(signed.terms)), backing), "INVALID", "terms do not name the payment's backing");
    requireThat(typeof prove === "function", "INVALID", "a local prover is required");
    const old = decodeRecord(saved.record), p = old.publicInputs;
    const planned = await this.read(packageBytes, signed, view => {
      const { canonical, force, notes, at, observed } = view;
      requireThat(canonical !== undefined && force !== undefined, "ABSENT", "no canonical checkpoint to spend from");
      requireThat(at >= BigInt(row.judged as string), "CHANGED_VIEW", "the venue view is older than the saved record's");
      const status = this.paid(name, old, canonical, force);
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
      const opening = this.db.prepare("SELECT value,owner,rho FROM saved_outputs WHERE cm=? AND alias=?");
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
    const bytes = this.encoded(await this.proven(spendTask({ domain: this.domain, header }, inputs, outputs), prove));
    const statement = hex(statementHash(decodeRecord(bytes)));
    this.transaction(() => {
      // A concurrent reproof or resolution may have replaced the record first: keep it.
      const current = this.db.prepare("SELECT receipt FROM saved_records WHERE alias=? AND statement=? AND status='prepared'")
        .get(name, hex(saved.statement));
      if (current === undefined) return;
      this.db.prepare("INSERT INTO saved_superseded VALUES(?,?,?,?)").run(hex(saved.statement), name, saved.record, current.receipt as Uint8Array | null);
      this.db.prepare("UPDATE saved_records SET statement=?, record=?, operator=?, receipt=NULL, judged=? WHERE alias=?")
        .run(statement, bytes, header.operator, at.toString(), name);
    });
    return this.payment(name)!;
  }

  /** The saved act under this local alias, with its current local status. */
  act(name: string): Act | undefined {
    name = alias(name); this.active();
    const row = this.db.prepare("SELECT * FROM saved_records WHERE alias=? AND kind!='2'").get(name);
    if (row === undefined) return undefined;
    const saved = this.saved(name, row);
    return { kind: Number(row.kind) as Act["kind"], record: saved.record, statement: saved.statement,
      demand: row.demand === null ? undefined : hexToBytes(row.demand as string), inputs: saved.inputs, status: saved.status,
      receipt: saved.receipt, final: saved.final };
  }
  /** The saved act under `name` if it is this exact intent; another intent, or a payment, under it refuses. */
  private savedAct(name: string, kind: Act["kind"], intent: string): Act | undefined {
    const row = this.db.prepare("SELECT kind,intent FROM saved_records WHERE alias=?").get(name);
    if (row === undefined) return undefined;
    requireThat(row.kind !== "2", "CONFLICT", "alias names a payment");
    requireThat(row.kind === String(kind) && row.intent === intent, "CONFLICT", "alias names another act");
    return this.act(name);
  }
  /** Save a proven or signed act once: a concurrent exact call that saved first wins, and its record is kept. */
  private saveAct(name: string, kind: Act["kind"], intent: string, bytes: Uint8Array, backing: Uint8Array, operator: Uint8Array,
    demand: string | undefined, inputs: readonly bigint[], at: bigint): Act {
    const record = decodeRecord(bytes), statement = hex(statementHash(record));
    this.transaction(() => {
      if (this.savedAct(name, kind, intent) !== undefined) return;
      // A settlement takes its demand's notes whatever else reserves them: while the demand stands its lock refuses any
      // other spend of them at the door (C3.7), and the settlement's admission fails every other record that spends one.
      requireThat(kind === 6 || inputs.every(nf => !this.reserved(nf)), "CONFLICT", "an input is reserved by another payment or act");
      requireThat(this.db.prepare("SELECT 1 FROM saved_records WHERE statement=?").get(statement) === undefined, "CONFLICT",
        "another alias saved this statement");
      requireThat(kind !== 6 || !this.pendingSettlement(demand!, record.publicInputs[9]!), "CONFLICT",
        "another settlement of this demand is prepared at this disclosure count; publish it, or sync to resolve it");
      this.db.prepare("INSERT INTO saved_records VALUES(?,?,?,?,?,?,?,?,NULL,'prepared',NULL,NULL,NULL,?)").run(name, String(kind), intent,
        statement, bytes, backing, operator, demand ?? null, at.toString());
      for (const nf of inputs) this.db.prepare("INSERT INTO saved_inputs VALUES(?,?)").run(nf.toString(), name);
    });
    return this.act(name)!;
  }
  /** The backer's signature over `message`, checked strictly against the obligor before anything uses it. */
  private async backerSignature(sign: BackerSigner, message: Uint8Array, obligor: Uint8Array): Promise<Uint8Array> {
    const answer = await sign(new Uint8Array(message));
    this.mutable();
    const signature = answer instanceof Uint8Array ? copyUnshared(answer) : new Uint8Array();
    requireThat(verifySignatureStrict(signature, message, obligor), "INVALID", "the signer is not the backing's obligor");
    return signature;
  }
  /** The caller's terms copied once, with their backing and obligor: every later step reads the copy. */
  private termsOf(signed: SignedTerms): { readonly backing: Uint8Array; readonly obligor: Uint8Array; readonly own: SignedTerms } {
    const own = { terms: copyUnshared(signed.terms), signature: copyUnshared(signed.signature) };
    return { backing: rootTermsName(own.terms), obligor: decodeRootTerms(own.terms).obligor, own };
  }
  /** pool-v3 §3.1: issue the exact request's value to its output, authorized by K through `sign` (§5). The
   * record is saved before it is returned; an exact alias retry returns it without evidence, proving or signing. */
  async issue(name: string, request: PaymentRequest, value: bigint, packageBytes: Uint8Array, signed: SignedTerms,
    prove: LocalProver, sign: BackerSigner): Promise<Act> {
    name = alias(name); this.mutable();
    const { backing, obligor, own } = this.termsOf(signed);
    const output = copyPaymentRequest(request, { domain: this.domain, backing, value });
    const intent = JSON.stringify([hex(backing), output.cm.toString(), value.toString()]);
    const existing = this.savedAct(name, 1, intent);
    if (existing !== undefined) return existing;
    requireThat(typeof prove === "function" && typeof sign === "function", "INVALID", "a local prover and a backer signer are required");
    const planned = await this.read(packageBytes, own, view => {
      if (this.savedAct(name, 1, intent) !== undefined) return undefined;
      requireThat(view.canonical !== undefined && !view.canonical.state.hasOutput(output.cm), "CONFLICT", "request is already paid");
      this.current(view.at);
      const header = this.admissible(view);
      view.observed.check();
      return { header, at: view.at };
    });
    if (planned === undefined) return this.act(name)!;
    const proven = await this.proven(issueTask({ domain: this.domain, header: planned.header }, output), prove);
    const authorization = await this.backerSignature(sign, statementBytes(proven), obligor);
    return this.saveAct(name, 1, intent, this.encoded({ ...proven, authorization }), backing, planned.header.operator, undefined, [],
      planned.at);
  }

  /** C3.3: demand `quantity` of the terms' backing from this seed's whole notes (one of exactly that value, or a
   * pair summing to it), with the instant at the read's witnessed index and the holder's own deadline, strictly
   * ahead of the operator's horizon; in a gap (`route`), strictly after the last index C3.3's window lets its
   * publication be witnessed at (index plus twice the lag), so it can have force anywhere in that window. The
   * presenter key and any zero padding are derived from the seed and the notice, so a retry or a rebuilt wallet
   * names the same demand. The notes stay reserved while it is prepared and are then held by its lock (C3.7). */
  async demand(name: string, quantity: bigint, deadline: bigint, packageBytes: Uint8Array, signed: SignedTerms,
    prove: LocalProver): Promise<Act> {
    name = alias(name); this.mutable();
    const { backing, own } = this.termsOf(signed);
    requireThat(isValue(quantity) && quantity > 0n && isValue(deadline), "INVALID", "invalid demand");
    const intent = JSON.stringify([hex(backing), quantity.toString(), deadline.toString()]);
    const existing = this.savedAct(name, 4, intent);
    if (existing !== undefined) return existing;
    requireThat(typeof prove === "function", "INVALID", "a local prover is required");
    const planned = await this.read(packageBytes, own, view => {
      if (this.savedAct(name, 4, intent) !== undefined) return undefined;
      const { force, notes, at, lag, observed } = view;
      this.current(view.at);
      const { header, gap } = this.route(view);
      requireThat(deadline > at + lag, "INVALID", "the deadline is not strictly ahead of the operator's horizon");
      requireThat(!gap || deadline > at + 2n * lag, "INVALID", "the deadline is not after every index C3.3's window allows");
      const holdings = this.holdingsOf(notes, force, at);
      const selected = exact(notes.filter((_, i) => holdings[i]!.status === "available"), quantity);
      observed.check();
      const inputs: NoteInput[] = selected.map(note => ({ note, anchor: note.anchor, path: note.path }));
      if (inputs.length === 1) {
        inputs.push({ ...inputs[0]!, note: prepareExactOutput(this.seed, this.domain, paddingRequestId(this.seed, this.domain,
          selected[0]!.nf), backing, 0n) });
      }
      return { header, inputs, nfs: selected.map(note => note.nf), at };
    });
    if (planned === undefined) return this.act(name)!;
    const { header, inputs, nfs, at } = planned;
    const tags = inputs.map(i => i.note.opening.value === 0n ? 0n : tagOf(i.note.nf));
    const secret = presenterSecret(this.seed, this.domain, tags, at, deadline), presenter = ed25519.getPublicKey(secret);
    secret.fill(0);
    const bytes = this.encoded(await this.proven(demandTask({ domain: this.domain, header }, inputs,
      { backing, quantity, presenter, instant: at, deadline }), prove));
    return this.saveAct(name, 4, intent, bytes, backing, header.operator, hex(statementHash(decodeRecord(bytes))), nfs, at);
  }

  /** C3.4: the backer's acceptance of a demand standing over its backing, with C4.7's owner derived from this
   * seed, the demand and the acceptance deadline (so distinct demands never share an owner), signed by K through
   * `sign`. The deadline is at or before the demand's and later than the horizon, or no release could be witnessed
   * inside it. Saved before it is returned; an exact alias retry returns it without evidence or signing. The
   * backer's settled note is found by `sync` from the seed once a settlement with this acceptance takes effect. */
  async accept(name: string, demand: Uint8Array, deadline: bigint, packageBytes: Uint8Array, signed: SignedTerms,
    sign: BackerSigner): Promise<SignedAcceptance> {
    name = alias(name); this.mutable();
    const { backing, obligor, own } = this.termsOf(signed), id = identifier(demand), key = hex(id);
    requireThat(isValue(deadline), "INVALID", "invalid acceptance deadline");
    const saved = (): SignedAcceptance | undefined => {
      const row = this.db.prepare("SELECT * FROM backer_acceptances WHERE alias=?").get(name);
      if (row === undefined) return undefined;
      requireThat(row.demand === key && row.deadline === deadline.toString(), "CONFLICT", "alias names another acceptance");
      return { domain: new Uint8Array(this.domain), demand: new Uint8Array(id), owner: BigInt(row.owner as string), deadline,
        signature: copyUnshared(row.signature as Uint8Array) };
    };
    const existing = saved();
    if (existing !== undefined) return existing;
    const taken = () => requireThat(this.db.prepare("SELECT 1 FROM backer_acceptances WHERE demand=? AND deadline=?")
      .get(key, deadline.toString()) === undefined, "CONFLICT", "another alias saved this acceptance");
    taken();
    requireThat(typeof sign === "function", "INVALID", "a backer signer is required");
    const owner = ownerOf(deriveSettlementOwnerSecret(this.seed, this.domain, id, deadline).value);
    requireThat(owner !== 0n, "STORAGE", "the derived owner is zero");
    await this.read(packageBytes, own, ({ force, at, lag, observed }) => {
      const standing = force?.demand(key);
      requireThat(standing !== undefined && same(standing.backing, backing), "ABSENT", "the demand does not stand in canonical history");
      requireThat(deadline <= standing.deadline, "INVALID", "an acceptance deadline is at or before the demand's");
      requireThat(deadline > at + lag, "INVALID", "the acceptance deadline is not later than the horizon");
      observed.check();
    });
    const acceptance = { domain: new Uint8Array(this.domain), demand: new Uint8Array(id), owner, deadline };
    const signature = await this.backerSignature(sign, acceptanceBytes(acceptance), obligor);
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM backer_acceptances WHERE alias=?").get(name) !== undefined) return;
      taken();
      this.db.prepare("INSERT INTO backer_acceptances VALUES(?,?,?,?,?)").run(name, key, deadline.toString(), owner.toString(), signature);
    });
    return saved()!;
  }

  /** C3.5–C3.6: settle this seed's demand that the backer's acceptance answers (`standing`: a demand saved here,
   * or one a lost wallet made, found from the seed): the demand's own notes in its positions into one output of
   * its quantity to the acceptance's owner, with `rho_out` derived from the seed, the input nullifiers, the
   * canonical segment and the disclosure count, and the release signed by the presenter. The acceptance must
   * verify under the terms' obligor, be due no later than the demand and stand at the horizon. The disclosure
   * count is read from the venue record (`disclosures`), so a release witnessed without force is followed by a
   * settlement of a new output, and a wallet rebuilt from its seed re-proves the same one. In a gap (`route`) the
   * settlement is bound to the snapshot and its release is published (`publish`). Saved before it is returned. */
  async settle(name: string, acceptance: SignedAcceptance, packageBytes: Uint8Array, signed: SignedTerms, prove: LocalProver): Promise<Act> {
    name = alias(name); this.mutable();
    const { backing, obligor, own: terms } = this.termsOf(signed);
    const own = { domain: copyUnshared(acceptance.domain), demand: identifier(acceptance.demand), owner: acceptance.owner,
      deadline: acceptance.deadline, signature: copyUnshared(acceptance.signature) };
    requireThat(same(own.domain, this.domain) && isField(own.owner) && own.owner !== 0n && isValue(own.deadline) &&
      verifySignatureStrict(own.signature, acceptanceBytes(own), obligor),
      "INVALID", "the acceptance does not answer a demand under the backing's obligor");
    const intent = JSON.stringify([hex(backing), hex(acceptanceId(own))]);
    const existing = this.savedAct(name, 6, intent);
    if (existing !== undefined) return existing;
    requireThat(typeof prove === "function", "INVALID", "a local prover is required");
    const key = hex(own.demand);
    const planned = await this.read(packageBytes, terms, view => {
      if (this.savedAct(name, 6, intent) !== undefined) return undefined;
      const { canonical, force, notes, at, lag, observed } = view;
      this.current(at);
      const demand = this.standing(view, own.demand);
      requireThat(own.deadline <= demand.deadline, "INVALID", "the acceptance is due after the demand");
      requireThat(own.deadline >= at + lag, "INVALID", "the acceptance deadline is behind the horizon");
      const { header } = this.route(view);
      const real = demand.tags.filter(tag => tag !== 0n).map(tag => notes.find(note => tagOf(note.nf) === tag));
      requireThat(real.every(note => note !== undefined), "ABSENT", "a demanded note is not unspent in canonical history");
      const placed = real.map(note => ({ note: note!, anchor: note!.anchor, path: note!.path }));
      const inputs: NoteInput[] = demand.tags.map(tag => tag !== 0n ? placed.find(i => tagOf(i.note.nf) === tag)! :
        { ...placed[0]!, note: prepareExactOutput(this.seed, this.domain, paddingRequestId(this.seed, this.domain, placed[0]!.note.nf),
          backing, 0n) });
      const count = this.disclosures(view, own.demand, demand.presenter, canonical!.segment);
      const rho = settlementRho(this.seed, this.domain, inputs.map(i => i.note.nf), canonical!.segment, count);
      const opening = { backing, value: demand.quantity, owner: own.owner, rho }, cm = commitmentOf(this.domain, opening);
      requireThat(!force!.hasOutput(cm), "CONFLICT", "the settlement's output already exists");
      requireThat(!this.pendingSettlement(key, rho), "CONFLICT", "another settlement of this demand is prepared at this disclosure count; publish it, or sync to resolve it");
      observed.check();
      return { header, inputs, output: { opening, cm }, at, demand, nfs: placed.map(i => i.note.nf) };
    }, true);
    if (planned === undefined) return this.act(name)!;
    const { header, inputs, output, at, demand, nfs } = planned;
    const proven = await this.proven(settleTask({ domain: this.domain, header }, inputs, output, own.demand), prove);
    const presenter = presenterSecret(this.seed, this.domain, demand.tags, demand.instant, demand.deadline);
    let bytes: Uint8Array;
    try { bytes = encodeRecord(authorizeSettlement(proven, own, presenter)); } catch (error) {
      if (error instanceof EncodingError) throw new V3WalletError("INVALID", "prover returned a malformed record");
      throw error;
    } finally { presenter.fill(0); }
    return this.saveAct(name, 6, intent, bytes, backing, header.operator, key, nfs, at);
  }

  /** C3.6: withdraw this seed's demand `demand` (its identity) standing in canonical history (or with force in a
   * gap), saved here or found from the seed (`standing`), signed by its presenter for the canonical segment; in a
   * gap (`route`) the withdrawal is published (`publish`). Once the withdrawal is final the demand's notes are
   * available again; C3.1 advises paying them to a fresh note before presenting them again. */
  async withdraw(name: string, demand: Uint8Array, packageBytes: Uint8Array, signed: SignedTerms): Promise<Act> {
    name = alias(name); this.mutable();
    const { backing, own } = this.termsOf(signed), id = identifier(demand), key = hex(id);
    const intent = JSON.stringify([hex(backing), key]);
    const existing = this.savedAct(name, 5, intent);
    if (existing !== undefined) return existing;
    const planned = await this.read(packageBytes, own, view => {
      if (this.savedAct(name, 5, intent) !== undefined) return undefined;
      this.current(view.at);
      const notice = this.standing(view, id);
      const { header } = this.route(view);
      view.observed.check();
      return { header, at: view.at, notice };
    });
    if (planned === undefined) return this.act(name)!;
    const { notice } = planned;
    const presenter = presenterSecret(this.seed, this.domain, notice.tags, notice.instant, notice.deadline);
    try {
      const bytes = encodeRecord(withdrawalRecord({ domain: this.domain, header: planned.header }, id, presenter));
      return this.saveAct(name, 5, intent, bytes, backing, planned.header.operator, key, [], planned.at);
    } finally { presenter.fill(0); }
  }

  /** pool-v3 §3.3: burn `quantity` from this seed's available notes (the smallest covering note or pair), the rest
   * returned as one fresh change output. The backer burns the notes settlements paid it where its terms say so. */
  async burn(name: string, quantity: bigint, packageBytes: Uint8Array, signed: SignedTerms, prove: LocalProver): Promise<Act> {
    name = alias(name); this.mutable();
    const { backing, own } = this.termsOf(signed);
    requireThat(isValue(quantity) && quantity > 0n, "INVALID", "invalid burn quantity");
    const intent = JSON.stringify([hex(backing), quantity.toString()]);
    const existing = this.savedAct(name, 3, intent);
    if (existing !== undefined) return existing;
    requireThat(typeof prove === "function", "INVALID", "a local prover is required");
    const planned = await this.read(packageBytes, own, view => {
      if (this.savedAct(name, 3, intent) !== undefined) return undefined;
      const { force, notes, at, observed } = view;
      this.current(view.at);
      const header = this.admissible(view);
      const holdings = this.holdingsOf(notes, force, at);
      const selected = select(notes.filter((_, i) => holdings[i]!.status === "available"), quantity);
      observed.check();
      const inputs: NoteInput[] = selected.map(note => ({ note, anchor: note.anchor, path: note.path }));
      if (inputs.length === 1) inputs.push({ ...inputs[0]!, note: this.fresh(backing, 0n) });
      const change = this.fresh(backing, selected.reduce((n, note) => n + note.opening.value, 0n) - quantity);
      return { header, inputs, change, nfs: selected.map(note => note.nf), at };
    });
    if (planned === undefined) return this.act(name)!;
    const { header, inputs, change, nfs, at } = planned;
    const bytes = this.encoded(await this.proven(burnTask({ domain: this.domain, header }, quantity, inputs, change), prove));
    return this.saveAct(name, 3, intent, bytes, backing, header.operator, undefined, nfs, at);
  }

  /** The operator's receipt for a saved record: it must sign this exact statement, proof and authorization. */
  private async receiptOf(saved: { readonly record: Uint8Array; readonly statement: Uint8Array }, operator: Uint8Array,
    service: { submit(record: Uint8Array): Promise<Receipt> }): Promise<Receipt> {
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
      operator }, receipt) && same(receipt.statementHash, saved.statement) &&
      same(receipt.proofHash, digests.proofHash) && same(receipt.signatureHash, digests.signatureHash),
      "INVALID", "receipt does not authenticate the saved record");
    return receipt;
  }
  /** Submit a saved payment's or act's exact record (one alias namespace); keep the first operator receipt that
   * signs its statement in the record's own segment. A receipt is pending operator liability (C2.10.9), not
   * finality; `sync` decides that from evidence. */
  async submit(name: string, service: { submit(record: Uint8Array): Promise<Receipt> }): Promise<Receipt> {
    name = alias(name); this.mutable();
    const row = this.db.prepare("SELECT * FROM saved_records WHERE alias=?").get(name);
    requireThat(row !== undefined, "UNKNOWN", "unknown payment or act");
    const saved = this.saved(name, row);
    if (saved.receipt !== undefined) return saved.receipt;
    const receipt = await this.receiptOf(saved, row.operator as Uint8Array, service);
    const current = this.transaction(() => {
      const statement = hex(saved.statement), bytes = encodeReceipt(receipt);
      if (this.db.prepare("SELECT 1 FROM saved_records WHERE alias=? AND statement=?").get(name, statement) !== undefined) {
        this.db.prepare("UPDATE saved_records SET receipt=? WHERE alias=? AND receipt IS NULL").run(bytes, name);
        return true;
      }
      // A reproof during submission replaced the record: the receipt stays with the
      // superseded record as evidence of that operator's acceptance (C2.10.9).
      this.db.prepare("UPDATE saved_superseded SET receipt=? WHERE alias=? AND statement=? AND receipt IS NULL").run(bytes, name, statement);
      return false;
    });
    requireThat(current, "CONFLICT", "the payment was re-proven during submission");
    return this.saved(name, this.db.prepare("SELECT * FROM saved_records WHERE alias=?").get(name)!).receipt!;
  }
  /** C2b.3.2: publish a saved demand, withdrawal or settlement (its release, carrying the acceptance) at the backing's
   * venue, routed to the act's backing, exactly as saved: a retry republishes the same bytes, which are the same
   * publication. The venue decides nothing; `sync` reads the act final once the publication has force. One
   * published outside an open gap has no force, and a release witnessed without force discloses its output and
   * counts towards the next settlement's disclosure count. Venue refusals surface as the publisher's `VenueError`. */
  async publish(name: string, publisher: RecordPublisher): Promise<void> {
    name = alias(name); this.mutable();
    const row = this.db.prepare("SELECT kind,record,backing FROM saved_records WHERE alias=? AND kind!='2'").get(name);
    requireThat(row !== undefined, "UNKNOWN", "unknown act");
    const kind = ({ "4": 1, "6": 3, "5": 4 } as const)[row.kind as string];
    requireThat(kind !== undefined, "INVALID", "only a demand, a withdrawal or a release is published");
    const send = publisher?.publishRecord;
    requireThat(typeof send === "function", "INVALID", "a venue publisher is required");
    const backing = copyUnshared(row.backing as Uint8Array);
    const bytes = encodePublication({ domain: new Uint8Array(this.domain), backing, kind, record: decodeRecord(row.record as Uint8Array) });
    await send.call(publisher, 4, backing, bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.seed.fill(0);
    this.retained?.close(); this.replays?.close(); this.db.close();
  }
}
