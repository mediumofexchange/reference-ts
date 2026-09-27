// Local, replayable Ergo evidence. Node 24 only; never imported by the core barrel.
// The checkpoint is local recovery state, not a transferable venue certificate.
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { copyUnshared } from "./bytes.js";
import type { ErgoTransactionView } from "./ergo-profile.js";
import { VenueError } from "./venue-error.js";

export interface ErgoCheckpoint {
  readonly headers: readonly Uint8Array[];
  readonly sections: readonly { readonly header: Uint8Array; readonly views: readonly ErgoTransactionView[] }[];
  readonly witnessed: bigint | undefined;
  readonly pin: Uint8Array | undefined;
  readonly protectedHeaders: readonly Uint8Array[];
  readonly failure: string | undefined;
}

function requireStored(ok: boolean): asserts ok {
  if (!ok) throw new VenueError("invalid stored Ergo checkpoint");
}
function bytes(value: unknown, width?: number): Uint8Array {
  requireStored(typeof value === "string" && /^(?:[0-9a-f]{2})*$/.test(value) && (width === undefined || value.length === width * 2));
  return Uint8Array.from(Buffer.from(value, "hex"));
}
function list(value: unknown): unknown[] { requireStored(Array.isArray(value)); return value; }
function object(value: unknown): Record<string, unknown> {
  requireStored(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function encode(state: ErgoCheckpoint): string {
  return JSON.stringify({ headers: state.headers.map(bytesToHex),
    sections: state.sections.map(s => ({ header: bytesToHex(s.header), views: s.views.map(t => ({
      unsigned: bytesToHex(t.unsigned), witnessId: bytesToHex(t.witnessId),
    })) })), witnessed: state.witnessed?.toString() ?? null, pin: state.pin === undefined ? null : bytesToHex(state.pin),
    protectedHeaders: state.protectedHeaders.map(bytesToHex), failure: state.failure ?? null });
}
function decode(text: string): ErgoCheckpoint {
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(text)); } catch { throw new VenueError("invalid stored Ergo checkpoint"); }
  requireStored(value.witnessed === null || (typeof value.witnessed === "string" && /^(0|[1-9][0-9]*)$/.test(value.witnessed)));
  const witnessed = value.witnessed === null ? undefined : BigInt(value.witnessed as string);
  requireStored(witnessed === undefined || witnessed <= 0x7fff_ffffn);
  requireStored(value.failure === null || value.failure === "venue failure: the best chain left a block witnessed under the depth");
  const state: ErgoCheckpoint = {
    headers: list(value.headers).map(h => bytes(h)),
    sections: list(value.sections).map(s => { const row = object(s); return {
      header: bytes(row.header, 32), views: list(row.views).map(t => { const tx = object(t); return {
        unsigned: bytes(tx.unsigned), witnessId: bytes(tx.witnessId, 31),
      }; }),
    }; }),
    witnessed, pin: value.pin === null ? undefined : bytes(value.pin, 32),
    protectedHeaders: list(value.protectedHeaders).map(h => bytes(h, 32)), failure: value.failure === null ? undefined : value.failure as string,
  };
  requireStored(encode(state) === text);
  return state;
}

/** One fenced owner, WAL/FULL, one atomic checkpoint before any new view is
 * exposed. Reopening rechecks all PoW and transaction roots in ErgoVenue.
 * Rewrites the complete checkpoint: bounded reference persistence, not a
 * streaming archive. Disk loss, copied journals and malicious rollback are
 * outside this local transaction guarantee. No funding secrets are stored. */
export class ErgoVenueJournal {
  private readonly db: DatabaseSync;
  private readonly owner: bigint;
  private readonly identity: string;
  private loaded = false;
  private closed = false;

  constructor(path: string, venueId: Uint8Array) {
    if (typeof path !== "string" || path.trim() === "" || path === ":memory:" || path.startsWith("file:")) {
      throw new VenueError("a persistent filesystem path is required");
    }
    const id = copyUnshared(venueId);
    if (id.length !== 32) throw new VenueError("invalid Ergo journal identity");
    this.identity = bytesToHex(id);
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      requireStored(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode === "wal" &&
        this.db.prepare("PRAGMA synchronous").get()?.synchronous === 2);
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`CREATE TABLE IF NOT EXISTS ergo_checkpoint (
        id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL, venue TEXT NOT NULL,
        owner INTEGER NOT NULL, payload TEXT, digest TEXT) STRICT;`);
      this.db.prepare("INSERT OR IGNORE INTO ergo_checkpoint VALUES(1,'moe/ergo-checkpoint/1',?,0,NULL,NULL)").run(this.identity);
      const row = this.row();
      requireStored(row?.format === "moe/ergo-checkpoint/1" && row.venue === this.identity &&
        typeof row.owner === "bigint" && row.owner >= 0n && row.owner < 0x7fff_ffff_ffff_ffffn);
      this.owner = row.owner + 1n;
      this.db.prepare("UPDATE ergo_checkpoint SET owner=? WHERE id=1").run(this.owner);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve cause */ }
      this.db.close(); throw error;
    }
  }
  private row() {
    const q = this.db.prepare("SELECT * FROM ergo_checkpoint WHERE id=1"); q.setReadBigInts(true); return q.get();
  }
  assertOwner(): void {
    if (this.closed) throw new VenueError("Ergo journal is closed");
    const row = this.row();
    if (row?.owner !== this.owner || row.venue !== this.identity || row.format !== "moe/ergo-checkpoint/1") {
      throw new VenueError("another owner fenced this Ergo journal");
    }
  }
  /** A journal handle attaches to exactly one view. */
  load(venueId: Uint8Array): ErgoCheckpoint | undefined {
    this.assertOwner();
    if (this.loaded || bytesToHex(copyUnshared(venueId)) !== this.identity) throw new VenueError("Ergo journal is already attached or names another venue");
    this.loaded = true;
    const row = this.row()!;
    if (row.payload === null) { requireStored(row.digest === null); return undefined; }
    requireStored(typeof row.payload === "string" && typeof row.digest === "string" &&
      bytesToHex(sha256(new TextEncoder().encode(row.payload))) === row.digest);
    return decode(row.payload);
  }
  commit(state: ErgoCheckpoint): void {
    const payload = encode(state), digest = bytesToHex(sha256(new TextEncoder().encode(payload)));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertOwner();
      this.db.prepare("UPDATE ergo_checkpoint SET payload=?,digest=? WHERE id=1").run(payload, digest);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* caller poisons the view on uncertainty */ }
      throw error;
    }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
