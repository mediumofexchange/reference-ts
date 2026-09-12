// Optional Node 24 local wallet. Plaintext custody: the database, WAL and
// host backups are secrets. Offline exports are encrypted; rollback/copies
// still require an independently retained recovery identity and one active copy.
// Fulfillment means one durable local record, not exactly-once external goods.
import { DatabaseSync } from "node:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes } from "../bytes.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../commitment.js";
import { isValue } from "./field.js";
import { commitmentOf, copyNoteOpening, isNoteOpening, nullifierOf, ownerOf, type NoteOpening } from "./notes.js";
import { readPoolCheckpoint, type PoolCheckpointFailure, type PoolCheckpointResult } from "./checkpoint.js";
import { poolReceiptAttestsEvidence, poolReceiptCovers, type PoolReceipt } from "./receipt.js";
import { copySegmentAuthority, decodeStatement, encodeStatement, parsePublicInputs, segmentIdentity, type SegmentAuthority, type Statement } from "./statement.js";
import { decodeStoredReceipt, encodeStoredReceipt } from "./store-codec.js";
import { deriveWalletField, walletChangeRequestId, type WalletPurpose } from "./wallet.js";
import { decodeWalletDelivery, encodeWalletDelivery, walletDeliveryHash } from "./wallet-delivery-wire.js";
import { MAX_WALLET_BACKUP_BYTES, openWalletBackup, sealWalletBackup, walletAuthorityBytes, walletBackupDigest } from "./wallet-backup.js";
import { decodeWalletPairing, encodeWalletPairing, sameWalletTlsKey, validateWalletTls, WALLET_PAIRING_PROFILE, walletCertificateDigest, walletPairingDigest, walletRequestText, type WalletCredentialBinding, type WalletTlsCredentials } from "./wallet-pairing.js";
import { WalletDeliveryClient } from "./wallet-delivery-http.js";

export interface WalletRequest { readonly id: string; readonly backing: Uint8Array; readonly value: bigint; readonly owner: bigint }
export interface WalletDelivery { readonly statement: Statement; readonly opening: NoteOpening; readonly receipt: PoolReceipt }
export interface WalletFulfillment { readonly opening: NoteOpening; readonly receipt: PoolReceipt; readonly checkpoint: Commitment }
/** Unspent in the exact selected history, not latest state or authorization to spend. */
export type WalletNoteResult = PoolCheckpointFailure | {
  readonly kind: "unspent" | "spent";
  readonly checkpoint: Commitment;
  readonly verified: Extract<PoolCheckpointResult, { kind: "final" }>;
};
export interface WalletHolding {
  readonly id: string;
  readonly opening: NoteOpening;
  readonly nullifier: bigint;
  readonly state: "absent" | "spent" | "unspent";
  readonly reservation?: string;
}
export type WalletHoldingsResult = PoolCheckpointFailure | {
  readonly kind: "final";
  readonly checkpoint: Commitment;
  readonly verified: Extract<PoolCheckpointResult, { kind: "final" }>;
  readonly notes: readonly WalletHolding[];
};
export class PoolWalletError extends Error {
  constructor(readonly code: "CONFLICT" | "UNKNOWN" | "INVALID" | "UNAVAILABLE", message: string) { super(message); this.name = "PoolWalletError"; }
}
function requireThat(ok: boolean, code: PoolWalletError["code"], message: string): asserts ok {
  if (!ok) throw new PoolWalletError(code, message);
}
function id(value: string): string {
  requireThat(typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value), "INVALID", "invalid local request id"); return value;
}
function noteText(note: NoteOpening): string {
  const n = copyNoteOpening(note);
  return JSON.stringify([bytesToHex(n.backing), n.value.toString(), n.owner.toString(), n.rho.toString()]);
}
function readNote(text: string): NoteOpening {
  const n = JSON.parse(text) as string[];
  return copyNoteOpening({ backing: hexToBytes(n[0]!), value: BigInt(n[1]!), owner: BigInt(n[2]!), rho: BigInt(n[3]!) });
}
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

// Fixed table/column names, never SQL supplied by the backup. The custody row
// is deliberately not transferable: the old source remains frozen forever.
const TABLES = [
  ["wallet_meta", ["singleton", "domain", "root", "counter"]],
  ["wallet_requests", ["id", "backing", "value", "secret", "owner"]],
  ["wallet_pending", ["id", "frame", "opening", "change_opening", "receipt"]],
  ["wallet_reservations", ["nullifier", "pending"]],
  ["wallet_fulfilled", ["id", "commitment", "opening", "receipt", "checkpoint"]],
  ["wallet_delivery_tokens", ["id", "token"]],
  ["wallet_inbox", ["id", "frame"]],
  ["wallet_transport", ["id", "generation", "key", "cert"]],
  ["wallet_pairings", ["id", "frame"]],
] as const;
type Snapshot = (string | number | null)[][][];
function decodeSnapshot(bytes: Uint8Array, authority: SegmentAuthority): Snapshot {
  let state: unknown, text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); state = JSON.parse(text); }
  catch { throw new PoolWalletError("INVALID", "invalid wallet snapshot"); }
  requireThat(JSON.stringify(state) === text && Array.isArray(state) && (state.length === 7 || state.length === TABLES.length), "INVALID", "invalid wallet snapshot layout");
  const tables = state as unknown[];
  if (tables.length === 7) tables.push([], []); // Historical application snapshots contain no transport state.
  for (let t = 0; t < TABLES.length; t++) {
    const rows = tables[t];
    requireThat(Array.isArray(rows), "INVALID", "invalid wallet snapshot rows");
    for (const row of rows) {
      requireThat(Array.isArray(row) && row.length === TABLES[t]![1].length, "INVALID", "invalid wallet snapshot columns");
      for (let c = 0; c < row.length; c++) requireThat(
        t === 0 && c === 0 ? row[c] === 1 : typeof row[c] === "string" || (t === 2 && c >= 2 && row[c] === null),
        "INVALID", "invalid wallet snapshot cell");
    }
  }
  const snapshot = tables as Snapshot, meta = snapshot[0]!;
  requireThat(meta.length === 1 && meta[0]![1] === bytesToHex(authority.domain) &&
    /^[0-9a-f]{64}$/.test(meta[0]![2] as string) && /^(0|[1-9][0-9]*)$/.test(meta[0]![3] as string), "INVALID", "invalid wallet snapshot identity");
  return snapshot;
}

export class PoolWalletStore {
  private readonly db: DatabaseSync;
  private readonly authority: SegmentAuthority;
  private readonly readOnly: boolean;
  constructor(path: string, authority: SegmentAuthority, options: { readOnly?: boolean } = {}) {
    this.authority = copySegmentAuthority(authority);
    walletAuthorityBytes(this.authority);
    this.readOnly = options.readOnly === true;
    this.db = new DatabaseSync(path, { readOnly: this.readOnly });
    try {
      if (this.readOnly) {
        const meta = this.db.prepare("SELECT domain FROM wallet_meta WHERE singleton=1").get();
        requireThat(meta?.["domain"] === bytesToHex(this.authority.domain), "CONFLICT", "wallet domain changed");
        requireThat(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wallet_custody'").get() !== undefined,
          "INVALID", "migrate legacy wallet with its original writable authority before read-only inspection");
        return; // Explicit evidence reader may select another verified segment.
      }
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;
        CREATE TABLE IF NOT EXISTS wallet_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), domain TEXT NOT NULL, root TEXT NOT NULL, counter TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wallet_requests (id TEXT PRIMARY KEY, backing TEXT NOT NULL, value TEXT NOT NULL, secret TEXT NOT NULL, owner TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS wallet_pending (id TEXT PRIMARY KEY, frame TEXT NOT NULL, opening TEXT, change_opening TEXT, receipt TEXT);
        CREATE TABLE IF NOT EXISTS wallet_reservations (nullifier TEXT PRIMARY KEY, pending TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wallet_fulfilled (id TEXT PRIMARY KEY, commitment TEXT NOT NULL UNIQUE, opening TEXT NOT NULL, receipt TEXT NOT NULL, checkpoint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wallet_delivery_tokens (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS wallet_inbox (id TEXT PRIMARY KEY, frame TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wallet_transport (id TEXT PRIMARY KEY CHECK(id='tls'), generation TEXT NOT NULL, key TEXT NOT NULL, cert TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wallet_pairings (id TEXT PRIMARY KEY, frame TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wallet_custody (singleton INTEGER PRIMARY KEY CHECK(singleton=1), authority TEXT NOT NULL, export BLOB, restored_from TEXT);`);
      this.transaction(() => {
        this.db.prepare("INSERT OR IGNORE INTO wallet_meta VALUES (1, ?, ?, '0')").run(bytesToHex(this.authority.domain), randomBytes(32).toString("hex"));
        const meta = this.db.prepare("SELECT domain FROM wallet_meta WHERE singleton=1").get()!;
        requireThat(meta["domain"] === bytesToHex(this.authority.domain), "CONFLICT", "wallet domain changed");
        const authority = bytesToHex(walletAuthorityBytes(this.authority));
        const custody = this.db.prepare("SELECT authority FROM wallet_custody WHERE singleton=1").get();
        if (custody) requireThat(custody["authority"] === authority, "CONFLICT", "wallet authority changed");
        else {
          this.checkStoredAuthority();
          this.db.prepare("INSERT INTO wallet_custody VALUES (1, ?, NULL, NULL)").run(authority);
        }
      }, true);
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  context(): SegmentAuthority { return copySegmentAuthority(this.authority); }
  private active(): void {
    requireThat(!this.readOnly, "CONFLICT", "wallet is read-only");
    requireThat(this.db.prepare("SELECT 1 FROM wallet_custody WHERE export IS NOT NULL").get() === undefined, "CONFLICT", "wallet source is frozen for offline recovery");
  }
  private transaction<T>(action: () => T, custodyOperation = false): T {
    requireThat(!this.readOnly, "CONFLICT", "wallet is read-only");
    this.db.exec("BEGIN IMMEDIATE");
    try { if (!custodyOperation) this.active(); const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Migration/export checks cannot relabel existing evidence to another authority. */
  private checkStoredAuthority(): void {
    for (const row of this.db.prepare("SELECT generation, key, cert FROM wallet_transport").iterate()) {
      const generation = row["generation"] as string;
      requireThat(/^[1-9][0-9]{0,19}$/.test(generation) && BigInt(generation) < 1n << 64n, "INVALID", "invalid credential generation");
      validateWalletTls({ key: row["key"] as string, cert: row["cert"] as string }, false);
    }
    for (const row of this.db.prepare("SELECT id, frame FROM wallet_pairings").iterate()) {
      id(row["id"] as string);
      requireThat(decodeWalletPairing(row["frame"] as string).domain === bytesToHex(this.authority.domain), "CONFLICT", "pairing domain differs");
    }
    const receipt = (text: string): void => {
      requireThat(same(walletAuthorityBytes(decodeStoredReceipt(text)), walletAuthorityBytes(this.authority)), "CONFLICT", "saved receipt authority differs");
    };
    const statement = (s: Statement): void => {
      const p = parsePublicInputs(s.kind, s.publicInputs);
      requireThat(same(p.domain, this.authority.domain) && same(p.segment, this.authority.segment) && p.scopeRoot === this.authority.scopeRoot, "CONFLICT", "saved statement authority differs");
    };
    for (const row of this.db.prepare("SELECT frame, receipt FROM wallet_pending").iterate()) {
      statement(decodeStatement(hexToBytes(row["frame"] as string)).statement);
      if (row["receipt"] !== null) receipt(row["receipt"] as string);
    }
    for (const row of this.db.prepare("SELECT receipt FROM wallet_fulfilled").iterate()) receipt(row["receipt"] as string);
    for (const row of this.db.prepare("SELECT frame FROM wallet_inbox").iterate()) {
      const delivery = decodeWalletDelivery(row["frame"] as string).delivery;
      statement(delivery.statement); receipt(encodeStoredReceipt(delivery.receipt));
    }
  }
  /** Read only: reconcile a lost restore reply by checking this exact digest. */
  custody(): { frozen: boolean; restoredFrom?: string } {
    const row = this.db.prepare("SELECT export IS NOT NULL AS frozen, restored_from FROM wallet_custody WHERE singleton=1").get()!;
    return { frozen: row["frozen"] === 1, ...(row["restored_from"] === null ? {} : { restoredFrom: row["restored_from"] as string }) };
  }
  /** Offline handoff: quiesce application workflows first. The source's complete
   * state and recoverable encrypted export freeze in the same transaction.
   * Retain key and exact digest independently; never activate two restores. */
  exportBackup(key: Uint8Array): Uint8Array {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT export FROM wallet_custody WHERE singleton=1").get()!["export"];
      if (old !== null) {
        const bytes = Uint8Array.from(old as Uint8Array);
        openWalletBackup(bytes, key, this.authority, walletBackupDigest(bytes)).fill(0);
        return bytes;
      }
      const names = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row["name"] as string).sort();
      requireThat(JSON.stringify(names) === JSON.stringify([...TABLES.map(t => t[0]), "wallet_custody"].sort()), "INVALID", "unsupported wallet schema");
      const snapshot: Snapshot = [];
      let estimatedBytes = 0;
      for (const [table, columns] of TABLES) {
        const actual = this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row["name"]);
        requireThat(JSON.stringify(actual) === JSON.stringify(columns), "INVALID", "unsupported wallet columns");
        const rows: Snapshot[number] = [];
        for (const row of this.db.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY ${columns[0]}`).iterate()) {
          const cells = columns.map(column => row[column] as string | number | null);
          estimatedBytes += Buffer.byteLength(JSON.stringify(cells)) + 1;
          requireThat(estimatedBytes <= MAX_WALLET_BACKUP_BYTES, "INVALID", "wallet exceeds offline backup limit");
          rows.push(cells);
        }
        snapshot.push(rows);
      }
      this.checkStoredAuthority();
      const plaintext = Buffer.from(JSON.stringify(snapshot));
      try {
        decodeSnapshot(plaintext, this.authority);
        const bytes = sealWalletBackup(plaintext, key, this.authority);
        this.db.prepare("UPDATE wallet_custody SET export=? WHERE singleton=1").run(bytes);
        return bytes;
      } finally { plaintext.fill(0); }
    }, true);
  }
  /** Fresh destination only. A failed/interrupted restore may leave a fresh
   * empty wallet; a committed restore retains its digest for reply recovery.
   * Never overwrite a database or blindly retry into a second destination. */
  static restoreBackup(path: string, authority: SegmentAuthority, bytes: Uint8Array, key: Uint8Array, expectedDigest: string): PoolWalletStore {
    const ownedAuthority = copySegmentAuthority(authority);
    const plaintext = openWalletBackup(bytes, key, ownedAuthority, expectedDigest);
    let state: Snapshot;
    try { state = decodeSnapshot(plaintext, ownedAuthority); } finally { plaintext.fill(0); }
    requireThat(path !== ":memory:" && !existsSync(path + "-wal") && !existsSync(path + "-shm"), "CONFLICT", "recovery requires a new destination");
    // Exclusive creation refuses files and symlinks; the parent is trusted local
    // storage. No destructive cleanup: interrupted destinations stay inspectable.
    closeSync(openSync(path, "wx", 0o600));
    const wallet = new PoolWalletStore(path, ownedAuthority);
    try {
      wallet.transaction(() => {
        // Another process can open the newly initialized destination before
        // this transaction. Never erase an acknowledged request or command.
        requireThat(wallet.db.prepare("SELECT counter FROM wallet_meta WHERE singleton=1").get()!["counter"] === "0" &&
          wallet.custody().restoredFrom === undefined && TABLES.slice(1).every(([table]) =>
            wallet.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() === undefined), "CONFLICT", "recovery destination is no longer pristine");
        for (let t = 0; t < TABLES.length; t++) {
          const [table, columns] = TABLES[t]!;
          wallet.db.exec(`DELETE FROM ${table}`);
          const insert = wallet.db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
          for (const row of state[t]!) insert.run(...row);
        }
        wallet.checkStoredAuthority();
        wallet.db.prepare("UPDATE wallet_custody SET restored_from=? WHERE singleton=1").run(expectedDigest);
      });
      return wallet;
    } catch (error) { wallet.close(); throw error; }
  }
  derive(purpose: WalletPurpose, inputs: readonly bigint[], slot = 0): bigint {
    const root = this.db.prepare("SELECT root FROM wallet_meta WHERE singleton=1").get()!["root"] as string;
    return deriveWalletField(hexToBytes(root), this.authority.domain, purpose, inputs, slot);
  }
  /** Secret and counter commit before this public request is returned. */
  request(requestId: string, backing: Uint8Array, value: bigint): WalletRequest {
    return this.makeRequest(requestId, backing, value, false);
  }
  /** Internal change owners cannot alias an already-used invoice. */
  changeRequest(alias: string, backing: Uint8Array, value: bigint): WalletRequest {
    return this.makeRequest(walletChangeRequestId(alias, value), backing, value, true);
  }
  private unusedChange(requestId: string): void {
    requireThat(["wallet_fulfilled", "wallet_inbox", "wallet_delivery_tokens"].every(table =>
      this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(requestId) === undefined), "CONFLICT", "change request is already used");
    const owner = this.db.prepare("SELECT owner FROM wallet_requests WHERE id=?").get(requestId)?.["owner"];
    if (owner !== undefined) for (const row of this.db.prepare("SELECT opening, change_opening FROM wallet_pending").iterate()) {
      for (const column of ["opening", "change_opening"]) requireThat(row[column] === null ||
        readNote(row[column] as string).owner.toString() !== owner, "CONFLICT", "change owner already has a prepared output");
    }
  }
  private makeRequest(requestId: string, backing: Uint8Array, value: bigint, change: boolean): WalletRequest {
    id(requestId);
    requireThat(backing instanceof Uint8Array && backing.length === 32 && isValue(value) && value > 0n, "INVALID", "request needs a backing and positive u64 value");
    const name = bytesToHex(backing);
    return this.transaction(() => {
      if (change) this.unusedChange(requestId);
      const old = this.db.prepare("SELECT * FROM wallet_requests WHERE id=?").get(requestId);
      if (old) {
        requireThat(old["backing"] === name && old["value"] === value.toString(), "CONFLICT", "request id reused with changed terms");
        return { id: requestId, backing: hexToBytes(name), value, owner: BigInt(old["owner"] as string) };
      }
      requireThat(change || !requestId.startsWith("change_"), "INVALID", "change request namespace is reserved");
      const counter = BigInt(this.db.prepare("SELECT counter FROM wallet_meta WHERE singleton=1").get()!["counter"] as string) + 1n;
      const secret = this.derive("request-secret", [counter]), owner = ownerOf(secret);
      this.db.prepare("UPDATE wallet_meta SET counter=? WHERE singleton=1").run(counter.toString());
      this.db.prepare("INSERT INTO wallet_requests VALUES (?, ?, ?, ?, ?)").run(requestId, name, value.toString(), secret.toString(), owner.toString());
      return { id: requestId, backing: hexToBytes(name), value, owner };
    });
  }
  /** Local proof creation only. Never pass this secret to PoolServiceClient. */
  secret(requestId: string): bigint {
    const row = this.db.prepare("SELECT secret FROM wallet_requests WHERE id=?").get(id(requestId));
    requireThat(row !== undefined, "UNKNOWN", "unknown request"); return BigInt(row["secret"] as string);
  }
  /** Provision locally, then share only with the intended payer over an
   * authenticated channel. A capability grants invoice access, not identity. */
  deliveryToken(requestId: string): string {
    id(requestId);
    return this.transaction(() => this.tokenFor(requestId));
  }
  private tokenFor(requestId: string): string {
    requireThat(this.db.prepare("SELECT 1 FROM wallet_requests WHERE id=?").get(requestId) !== undefined, "UNKNOWN", "unknown request");
    const old = this.db.prepare("SELECT token FROM wallet_delivery_tokens WHERE id=?").get(requestId);
    if (old) return old["token"] as string;
    const token = randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO wallet_delivery_tokens VALUES (?, ?)").run(requestId, token);
    return token;
  }
  deliveryCredentials(): (WalletTlsCredentials & { generation: bigint }) | undefined {
    this.active();
    const row = this.db.prepare("SELECT generation, key, cert FROM wallet_transport WHERE id='tls'").get();
    return row === undefined ? undefined : { generation: BigInt(row["generation"] as string), key: row["key"] as string, cert: row["cert"] as string };
  }
  /** CAS and exact retry cover a lost install/rotation reply. All old tokens revoke atomically. */
  installDeliveryCredentials(tls: WalletTlsCredentials, expectedGeneration: bigint): bigint {
    this.active();
    const owned = { key: tls.key, cert: tls.cert }; validateWalletTls(owned);
    requireThat(typeof expectedGeneration === "bigint" && expectedGeneration >= 0n && expectedGeneration < (1n << 64n) - 1n, "INVALID", "invalid credential generation");
    return this.transaction(() => {
      const old = this.deliveryCredentials(), next = expectedGeneration + 1n;
      if (old?.generation === next && old.key === owned.key && old.cert === owned.cert) return next;
      requireThat((old?.generation ?? 0n) === expectedGeneration, "CONFLICT", "credential generation changed");
      requireThat(old === undefined || !sameWalletTlsKey(old.cert, owned.cert), "CONFLICT", "rotation requires a fresh TLS key");
      this.db.prepare("INSERT OR REPLACE INTO wallet_transport VALUES ('tls', ?, ?, ?)").run(next.toString(), owned.key, owned.cert);
      this.db.exec("DELETE FROM wallet_delivery_tokens");
      return next;
    });
  }
  /** One snapshot prevents mixing a rotated certificate with an old capability. */
  deliveryInvitation(requestId: string, endpoint: string): string {
    id(requestId);
    return this.transaction(() => {
      const tls = this.deliveryCredentials(); requireThat(tls !== undefined, "UNKNOWN", "wallet credentials are not provisioned");
      validateWalletTls(tls);
      const row = this.db.prepare("SELECT backing, value, owner FROM wallet_requests WHERE id=?").get(requestId);
      requireThat(row !== undefined, "UNKNOWN", "unknown request");
      return encodeWalletPairing({ profile: WALLET_PAIRING_PROFILE, domain: bytesToHex(this.authority.domain),
        request: { id: requestId, backing: row["backing"] as string, value: row["value"] as string, owner: row["owner"] as string },
        generation: tls.generation.toString(), endpoint, token: this.tokenFor(requestId), cert: tls.cert });
    });
  }
  /** expectedDigest is independently authenticated input, never derived from the received file. */
  acceptPairing(alias: string, frame: string, expectedDigest: string, expectedRequest: WalletRequest, previousDigest?: string): string {
    id(alias); this.active();
    const pair = decodeWalletPairing(frame), digest = walletPairingDigest(frame);
    requireThat(digest === expectedDigest && pair.domain === bytesToHex(this.authority.domain) &&
      JSON.stringify(pair.request) === JSON.stringify(walletRequestText(expectedRequest)), "INVALID", "pairing request or digest differs");
    return this.transaction(() => {
      const old = this.db.prepare("SELECT frame FROM wallet_pairings WHERE id=?").get(alias)?.["frame"] as string | undefined;
      if (old === frame) return digest;
      // Existing aliases keep their invoice on rotation. Historical duplicate
      // aliases must not strand an already-prepared payment on expired TLS.
      if (old === undefined) for (const row of this.db.prepare("SELECT id, frame FROM wallet_pairings WHERE id<>?").iterate(alias)) {
        const other = decodeWalletPairing(row["frame"] as string);
        requireThat(other.domain !== pair.domain || other.request.owner !== pair.request.owner, "CONFLICT", "receiver owner already enrolled under another alias");
      }
      if (old !== undefined) {
        const prior = decodeWalletPairing(old);
        requireThat(previousDigest === walletPairingDigest(old) && prior.domain === pair.domain &&
          JSON.stringify(prior.request) === JSON.stringify(pair.request) && BigInt(pair.generation) > BigInt(prior.generation),
          "CONFLICT", "pairing update is stale or changes invoice");
      } else requireThat(previousDigest === undefined, "CONFLICT", "pairing predecessor is missing");
      this.db.prepare("INSERT OR REPLACE INTO wallet_pairings VALUES (?, ?)").run(alias, frame);
      return digest;
    });
  }
  pairing(alias: string): string {
    this.active();
    const frame = this.db.prepare("SELECT frame FROM wallet_pairings WHERE id=?").get(id(alias))?.["frame"];
    requireThat(typeof frame === "string", "UNKNOWN", "unknown pairing"); return frame;
  }
  pairedDeliveryClient(alias: string): WalletDeliveryClient {
    const frame = this.pairing(alias), pair = decodeWalletPairing(frame);
    return new WalletDeliveryClient(pair.endpoint, pair.token, pair.cert, { pair, current: () => this.pairing(alias) === frame });
  }
  /** Preflight and commit guard for NEW ordinary payments. Existing saved
   * commands remain retryable even in historical wallets with duplicate aliases. */
  assertNewPayment(alias: string): void {
    const pair = decodeWalletPairing(this.pairing(alias));
    for (const row of this.db.prepare("SELECT id, frame FROM wallet_pairings WHERE id<>?").iterate(alias)) {
      const other = decodeWalletPairing(row["frame"] as string);
      requireThat(other.domain !== pair.domain || other.request.owner !== pair.request.owner, "CONFLICT", "receiver owner has ambiguous aliases");
    }
    for (const row of this.db.prepare("SELECT opening, change_opening FROM wallet_pending WHERE id<>?").iterate(alias)) {
      for (const column of ["opening", "change_opening"]) requireThat(row[column] === null ||
        readNote(row[column] as string).owner.toString() !== pair.request.owner,
        "CONFLICT", "receiver owner already has a prepared payment");
    }
  }
  /** Keep the final pairing guard and nullifier reservation in one transaction. */
  preparePayment(alias: string, statement: Statement, opening: NoteOpening, change: NoteOpening): void {
    this.savePending(alias, statement, opening, change, () => {
      this.assertNewPayment(alias);
      const pair = decodeWalletPairing(this.pairing(alias));
      requireThat(statement.kind === 2 && bytesToHex(opening.backing) === pair.request.backing &&
        opening.value.toString() === pair.request.value && opening.owner.toString() === pair.request.owner,
        "CONFLICT", "payment differs from paired invoice");
      if (change.value > 0n) {
        const requestId = walletChangeRequestId(alias, change.value);
        this.unusedChange(requestId);
        const request = this.db.prepare("SELECT backing, value, owner FROM wallet_requests WHERE id=?").get(requestId);
        requireThat(request !== undefined && request["backing"] === bytesToHex(change.backing) &&
          request["value"] === change.value.toString() && request["owner"] === change.owner.toString(),
          "CONFLICT", "change differs from internal request");
      }
    });
  }
  /** Authorization checks never create requests or rotate capabilities. */
  authorizesDelivery(requestId: string, token: string, credential?: WalletCredentialBinding): boolean {
    if (this.readOnly || this.custody().frozen) return false;
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId) ||
        typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;
    const tls = this.deliveryCredentials();
    if (tls ? credential?.generation !== tls.generation || credential.certificateDigest !== walletCertificateDigest(tls.cert) : credential !== undefined) return false;
    const row = this.db.prepare("SELECT token FROM wallet_delivery_tokens WHERE id=?").get(requestId);
    return row !== undefined && timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(row["token"] as string, "hex"));
  }
  /** Save original attested delivery before transport acknowledgment. The
   * handler authorizes capability access; this method validates the payment.
   * Storage is neither proof verification, checkpoint finality nor fulfillment. */
  receiveDelivery(requestId: string, delivery: WalletDelivery): string {
    return this.storeDelivery(requestId, delivery);
  }
  receiveAuthorizedDelivery(requestId: string, token: string, delivery: WalletDelivery, credential?: WalletCredentialBinding): string {
    return this.storeDelivery(requestId, delivery, { token, credential });
  }
  private storeDelivery(requestId: string, delivery: WalletDelivery, auth?: { token: string; credential: WalletCredentialBinding | undefined }): string {
    const { statement, opening, receipt } = this.payment(requestId, delivery);
    requireThat(poolReceiptAttestsEvidence(this.authority, statement, receipt), "INVALID", "delivery differs from receipt evidence");
    const frame = encodeWalletDelivery(requestId, this.authority.domain, { statement, opening, receipt });
    return this.transaction(() => {
      if (auth) requireThat(this.authorizesDelivery(requestId, auth.token, auth.credential), "CONFLICT", "delivery credentials changed");
      const old = this.db.prepare("SELECT frame FROM wallet_inbox WHERE id=?").get(requestId);
      if (old) requireThat(old["frame"] === frame, "CONFLICT", "inbox delivery changed");
      else this.db.prepare("INSERT INTO wallet_inbox VALUES (?, ?)").run(requestId, frame);
      return walletDeliveryHash(frame);
    });
  }
  inbox(requestId: string): WalletDelivery | undefined {
    const row = this.db.prepare("SELECT frame FROM wallet_inbox WHERE id=?").get(id(requestId));
    return row === undefined ? undefined : decodeWalletDelivery(row["frame"] as string).delivery;
  }
  /** Persist the complete proof/signature and private delivery before submit.
   * Reservation refuses rebuilding an input under a different local command.
   * This first slice does not release inputs or support lapse/replacement. */
  prepare(commandId: string, statement: Statement, opening?: NoteOpening, change?: NoteOpening): void {
    this.savePending(commandId, statement, opening, change);
  }
  private savePending(commandId: string, statement: Statement, opening?: NoteOpening, change?: NoteOpening, guard?: () => void): void {
    id(commandId);
    const frame = bytesToHex(encodeStatement(this.authority.domain, statement));
    const own = decodeStatement(hexToBytes(frame)).statement, inputs = parsePublicInputs(own.kind, own.publicInputs);
    requireThat(same(inputs.domain, this.authority.domain) && same(inputs.segment, this.authority.segment) && inputs.scopeRoot === this.authority.scopeRoot, "INVALID", "statement authority differs");
    const note = opening === undefined ? null : noteText(opening);
    const changeNote = change === undefined ? null : noteText(change);
    if (opening !== undefined) requireThat(inputs.outputs.includes(commitmentOf(this.authority.domain, opening)), "INVALID", "delivery is not an output");
    if (change !== undefined) requireThat(inputs.outputs.includes(commitmentOf(this.authority.domain, change)), "INVALID", "change is not an output");
    this.transaction(() => {
      const old = this.db.prepare("SELECT frame, opening, change_opening FROM wallet_pending WHERE id=?").get(commandId);
      if (old) { requireThat(old["frame"] === frame && old["opening"] === note && old["change_opening"] === changeNote, "CONFLICT", "pending command changed"); return; }
      guard?.();
      for (const nf of inputs.nullifiers) requireThat(this.db.prepare("SELECT 1 FROM wallet_reservations WHERE nullifier=?").get(nf.toString()) === undefined, "CONFLICT", "input already reserved");
      this.db.prepare("INSERT INTO wallet_pending VALUES (?, ?, ?, ?, NULL)").run(commandId, frame, note, changeNote);
      for (const nf of inputs.nullifiers) this.db.prepare("INSERT INTO wallet_reservations VALUES (?, ?)").run(nf.toString(), commandId);
    });
  }
  pending(commandId: string): { statement: Statement; opening?: NoteOpening; change?: NoteOpening; receipt?: PoolReceipt } {
    const row = this.db.prepare("SELECT * FROM wallet_pending WHERE id=?").get(id(commandId));
    requireThat(row !== undefined, "UNKNOWN", "unknown pending command");
    return { statement: decodeStatement(hexToBytes(row["frame"] as string)).statement,
      ...(row["opening"] === null ? {} : { opening: readNote(row["opening"] as string) }),
      ...(row["change_opening"] === null ? {} : { change: readNote(row["change_opening"] as string) }),
      ...(row["receipt"] === null ? {} : { receipt: decodeStoredReceipt(row["receipt"] as string) }) };
  }
  async submit(commandId: string, client: { submit(input: { domain: Uint8Array; statement: Statement }): Promise<PoolReceipt> }): Promise<PoolReceipt> {
    this.active();
    const pending = this.pending(commandId);
    const submitted = decodeStatement(encodeStatement(this.authority.domain, pending.statement)).statement;
    const receipt = await client.submit({ domain: this.authority.domain.slice(), statement: submitted });
    requireThat(poolReceiptCovers(this.authority, pending.statement, receipt), "INVALID", "receipt does not cover pending statement under wallet authority");
    const encoded = encodeStoredReceipt(receipt);
    this.transaction(() => {
      const old = this.pending(commandId).receipt;
      requireThat(old === undefined || encodeStoredReceipt(old) === encoded, "CONFLICT", "accepted receipt changed");
      this.db.prepare("UPDATE wallet_pending SET receipt=? WHERE id=?").run(encoded, commandId);
    });
    return decodeStoredReceipt(encoded);
  }
  received(requestId: string): NoteOpening | undefined {
    const row = this.db.prepare("SELECT opening FROM wallet_fulfilled WHERE id=?").get(id(requestId));
    return row === undefined ? undefined : readNote(row["opening"] as string);
  }
  /** Read the original local fulfillment after a lost reply. This is historical
   * evidence, never another authorization to deliver goods or credit an invoice. */
  fulfillment(requestId: string): WalletFulfillment | undefined {
    const row = this.db.prepare("SELECT opening, receipt, checkpoint FROM wallet_fulfilled WHERE id=?").get(id(requestId));
    return row === undefined ? undefined : { opening: readNote(row["opening"] as string),
      receipt: decodeStoredReceipt(row["receipt"] as string), checkpoint: decodeCommitment(hexToBytes(row["checkpoint"] as string)) };
  }
  /** Inventory only of durably fulfilled notes. Replay once for the whole
   * inventory; never query a server for a held leaf. Reservations are local
   * facts, separate from spentness at this exact historical checkpoint. */
  async inspectNotes(args: Parameters<typeof readPoolCheckpoint>[0]): Promise<WalletHoldingsResult> {
    const holdings = this.db.prepare(`SELECT f.id, f.opening, r.backing, r.value, r.owner, r.secret
      FROM wallet_fulfilled f JOIN wallet_requests r ON r.id=f.id ORDER BY f.id`).all().map(row => {
      const opening = readNote(row["opening"] as string), secret = BigInt(row["secret"] as string);
      requireThat(row["backing"] === bytesToHex(opening.backing) && row["value"] === opening.value.toString() &&
        row["owner"] === opening.owner.toString() && opening.value > 0n && ownerOf(secret) === opening.owner,
        "INVALID", "saved holding differs from request");
      const cm = commitmentOf(this.authority.domain, opening);
      return { id: row["id"] as string, opening, cm, nullifier: nullifierOf(this.authority.domain, cm, secret) };
    });
    let checkpoint: Commitment;
    try { checkpoint = decodeCommitment(encodeCommitment(args.checkpoint)); }
    catch { return { kind: "invalid", reason: "malformed inventory checkpoint" }; }
    const verified = await readPoolCheckpoint({ ...args, checkpoint });
    if (verified.kind !== "final") return verified;
    if (!same(segmentIdentity(verified.prefix.header), this.authority.segment)) return { kind: "invalid", reason: "inventory checkpoint authority differs" };
    const outputs = new Set(verified.prefix.events.flatMap(e => [...e.outputs]));
    const spent = new Set(verified.prefix.events.flatMap(e => [...e.nullifiers]));
    const notes = holdings.map(({ cm, ...holding }): WalletHolding => {
      const reservation = this.db.prepare("SELECT pending FROM wallet_reservations WHERE nullifier=?").get(holding.nullifier.toString())?.["pending"] as string | undefined;
      return { ...holding, state: !outputs.has(cm) ? "absent" : spent.has(holding.nullifier) ? "spent" : "unspent",
        ...(reservation === undefined ? {} : { reservation }) };
    });
    return { kind: "final", checkpoint, verified, notes };
  }
  /** pool-v2 §§3, 10: check a receiver-owned note against verified history before
   * fulfillment or proof preparation. No receipt validation or state mutation.
   * An older checkpoint can still report unspent after a later spend. */
  async checkNote(requestId: string, opening: NoteOpening, args: Parameters<typeof readPoolCheckpoint>[0]): Promise<WalletNoteResult> {
    const row = this.db.prepare("SELECT * FROM wallet_requests WHERE id=?").get(id(requestId));
    requireThat(row !== undefined, "UNKNOWN", "unknown request");
    if (!isNoteOpening(opening)) return { kind: "invalid", reason: "malformed note opening" };
    const note = copyNoteOpening(opening), secret = BigInt(row["secret"] as string);
    if (row["backing"] !== bytesToHex(note.backing) || row["value"] !== note.value.toString() ||
        row["owner"] !== note.owner.toString() || note.value === 0n || ownerOf(secret) !== note.owner) {
      return { kind: "invalid", reason: "note does not match receiver request" };
    }
    const cm = commitmentOf(this.authority.domain, note), nf = nullifierOf(this.authority.domain, cm, secret);
    // The checkpoint reader owns its arguments before proof callbacks. Capture
    // the same exact target for the returned result before any await as well.
    let checkpoint: Commitment;
    try { checkpoint = decodeCommitment(encodeCommitment(args.checkpoint)); }
    catch { return { kind: "invalid", reason: "malformed note checkpoint" }; }
    const result = await readPoolCheckpoint({ ...args, checkpoint });
    if (result.kind !== "final") return result;
    if (!same(segmentIdentity(result.prefix.header), this.authority.segment)) return { kind: "invalid", reason: "note checkpoint authority differs" };
    if (!result.prefix.events.some(event => event.outputs.includes(cm))) return { kind: "invalid", reason: "note is absent from verified checkpoint" };
    return { kind: result.prefix.events.some(event => event.nullifiers.includes(nf)) ? "spent" : "unspent",
      checkpoint, verified: result };
  }
  private payment(requestId: string, delivery: WalletDelivery): WalletDelivery & { cm: bigint } {
    id(requestId);
    const statement = decodeStatement(encodeStatement(this.authority.domain, delivery.statement)).statement;
    const opening = copyNoteOpening(delivery.opening), receipt = decodeStoredReceipt(encodeStoredReceipt(delivery.receipt));
    const row = this.db.prepare("SELECT * FROM wallet_requests WHERE id=?").get(requestId);
    requireThat(row !== undefined, "UNKNOWN", "unknown request");
    requireThat(row["backing"] === bytesToHex(opening.backing) && row["value"] === opening.value.toString() &&
      row["owner"] === opening.owner.toString() && opening.value > 0n, "INVALID", "payment does not match receiver request");
    const cm = commitmentOf(this.authority.domain, opening);
    requireThat(poolReceiptCovers(this.authority, statement, receipt) && parsePublicInputs(statement.kind, statement.publicInputs).outputs.includes(cm), "INVALID", "invalid payment receipt or output");
    return { statement, opening, receipt, cm };
  }
  /** Verify caller-owned checkpoint/venue evidence before recording one local
   * fulfillment. Missing history returns unavailable and changes no state. */
  async fulfill(requestId: string, delivery: WalletDelivery, args: Parameters<typeof readPoolCheckpoint>[0]): Promise<PoolCheckpointResult> {
    this.active();
    const { opening, receipt, cm } = this.payment(requestId, delivery);
    const checkpoint = encodeCommitment(args.checkpoint);
    const result = await readPoolCheckpoint(args);
    if (result.kind !== "final") return result;
    const accepted = result.accepted.find(a => a.position === receipt.position);
    requireThat(same(segmentIdentity(result.prefix.header), this.authority.segment) && accepted !== undefined &&
      same(accepted.statementHash, receipt.statementHash) && same(accepted.historyHash, receipt.historyHash), "INVALID", "payment is not in the verified checkpoint");
    this.transaction(() => {
      requireThat(this.db.prepare("SELECT 1 FROM wallet_fulfilled WHERE id=? OR commitment=?").get(requestId, cm.toString()) === undefined, "CONFLICT", "invoice or payment already fulfilled");
      this.db.prepare("INSERT INTO wallet_fulfilled VALUES (?, ?, ?, ?, ?)").run(requestId, cm.toString(), noteText(opening), encodeStoredReceipt(receipt), bytesToHex(checkpoint));
    });
    return result;
  }
}
