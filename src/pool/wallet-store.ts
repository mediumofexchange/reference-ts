// Optional Node 24 local wallet. Plaintext custody: the database, WAL and
// backups are secrets. Assumes trusted local storage without rollback/copies.
// Fulfillment means one durable local record, not exactly-once external goods.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes } from "../bytes.js";
import { encodeCommitment } from "../commitment.js";
import { isValue } from "./field.js";
import { commitmentOf, copyNoteOpening, ownerOf, type NoteOpening } from "./notes.js";
import { readPoolCheckpoint, type PoolCheckpointResult } from "./checkpoint.js";
import { poolReceiptCovers, type PoolReceipt } from "./receipt.js";
import { copySegmentAuthority, decodeStatement, encodeStatement, parsePublicInputs, segmentIdentity, type SegmentAuthority, type Statement } from "./statement.js";
import { decodeStoredReceipt, encodeStoredReceipt } from "./store-codec.js";
import { deriveWalletField, type WalletPurpose } from "./wallet.js";

export interface WalletRequest { readonly id: string; readonly backing: Uint8Array; readonly value: bigint; readonly owner: bigint }
export interface WalletDelivery { readonly statement: Statement; readonly opening: NoteOpening; readonly receipt: PoolReceipt }
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

export class PoolWalletStore {
  private readonly db: DatabaseSync;
  private readonly authority: SegmentAuthority;
  constructor(path: string, authority: SegmentAuthority) {
    this.authority = copySegmentAuthority(authority);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS wallet_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), domain TEXT NOT NULL, root TEXT NOT NULL, counter TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wallet_requests (id TEXT PRIMARY KEY, backing TEXT NOT NULL, value TEXT NOT NULL, secret TEXT NOT NULL, owner TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS wallet_pending (id TEXT PRIMARY KEY, frame TEXT NOT NULL, opening TEXT, change_opening TEXT, receipt TEXT);
        CREATE TABLE IF NOT EXISTS wallet_reservations (nullifier TEXT PRIMARY KEY, pending TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS wallet_fulfilled (id TEXT PRIMARY KEY, commitment TEXT NOT NULL UNIQUE, opening TEXT NOT NULL, receipt TEXT NOT NULL, checkpoint TEXT NOT NULL);`);
      this.db.prepare("INSERT OR IGNORE INTO wallet_meta VALUES (1, ?, ?, '0')").run(bytesToHex(this.authority.domain), randomBytes(32).toString("hex"));
      const meta = this.db.prepare("SELECT domain FROM wallet_meta WHERE singleton=1").get()!;
      requireThat(meta["domain"] === bytesToHex(this.authority.domain), "CONFLICT", "wallet domain changed");
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  derive(purpose: WalletPurpose, inputs: readonly bigint[], slot = 0): bigint {
    const root = this.db.prepare("SELECT root FROM wallet_meta WHERE singleton=1").get()!["root"] as string;
    return deriveWalletField(hexToBytes(root), this.authority.domain, purpose, inputs, slot);
  }
  /** Secret and counter commit before this public request is returned. */
  request(requestId: string, backing: Uint8Array, value: bigint): WalletRequest {
    id(requestId);
    requireThat(backing instanceof Uint8Array && backing.length === 32 && isValue(value) && value > 0n, "INVALID", "request needs a backing and positive u64 value");
    const name = bytesToHex(backing);
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM wallet_requests WHERE id=?").get(requestId);
      if (old) {
        requireThat(old["backing"] === name && old["value"] === value.toString(), "CONFLICT", "request id reused with changed terms");
        return { id: requestId, backing: hexToBytes(name), value, owner: BigInt(old["owner"] as string) };
      }
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
  /** Persist the complete proof/signature and private delivery before submit.
   * Reservation refuses rebuilding an input under a different local command.
   * This first slice does not release inputs or support lapse/replacement. */
  prepare(commandId: string, statement: Statement, opening?: NoteOpening, change?: NoteOpening): void {
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
  /** Verify caller-owned checkpoint/venue evidence before recording one local
   * fulfillment. Missing history returns unavailable and changes no state. */
  async fulfill(requestId: string, delivery: WalletDelivery, args: Parameters<typeof readPoolCheckpoint>[0]): Promise<PoolCheckpointResult> {
    id(requestId);
    const statement = decodeStatement(encodeStatement(this.authority.domain, delivery.statement)).statement;
    const opening = copyNoteOpening(delivery.opening), receipt = decodeStoredReceipt(encodeStoredReceipt(delivery.receipt));
    const row = this.db.prepare("SELECT * FROM wallet_requests WHERE id=?").get(requestId);
    requireThat(row !== undefined, "UNKNOWN", "unknown request");
    requireThat(row["backing"] === bytesToHex(opening.backing) && row["value"] === opening.value.toString() &&
      row["owner"] === opening.owner.toString() && opening.value > 0n, "INVALID", "payment does not match receiver request");
    const cm = commitmentOf(this.authority.domain, opening);
    requireThat(poolReceiptCovers(this.authority, statement, receipt) && parsePublicInputs(statement.kind, statement.publicInputs).outputs.includes(cm), "INVALID", "invalid payment receipt or output");
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
