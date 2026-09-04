// Node 24 optional entry point. A durable development operator and local witness.
// No network effect may occur inside execution/replay: publication is LocalVenue
// state, made durable by the same transaction as the command and its response.
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeBacking, type Backing } from "./backing.js";
import { compactState, encodeCommitment, type ServedState } from "./commitment.js";
import { decodePublishedOp } from "./oplog.js";
import { Sequencer } from "./sequencer.js";
import { LocalVenue } from "./venue.js";
import {
  PILOT_PROFILE, PILOT_MAX_COMMANDS, PILOT_MAX_BACKINGS, hex,
  parsePilotCommand, receiptToWire, requirePilotBacking, stateToWire,
  type PilotCommand, type PilotReply, type PilotView,
} from "./pilot-wire.js";

export class PilotError extends Error {
  constructor(readonly code: "INVALID" | "CONFLICT" | "LIMIT" | "STORAGE", message: string) {
    super(message); this.name = "PilotError";
  }
}

class Engine {
  readonly venue: LocalVenue;
  readonly sequencer: Sequencer;
  readonly backings = new Map<string, { backing: Backing; terms: string; signature: string }>();
  readonly commitments: { bytes: string; at: string }[] = [];
  state: ServedState | undefined;
  constructor(secret: Uint8Array, venue: Uint8Array) {
    this.venue = new LocalVenue(venue);
    this.sequencer = new Sequencer(secret, this.venue);
  }
  apply(command: PilotCommand): PilotReply {
    if (command.kind === "register") {
      const backing = decodeBacking(hex(command.backing, 4096));
      requirePilotBacking(backing, this.sequencer.operator, this.venue.id);
      if (!this.backings.has(backing.nameHex) && this.backings.size !== 0) {
        throw new PilotError("LIMIT", "this pilot operator serves one root");
      }
      this.sequencer.register(backing, hex(command.signature, 64, 64));
      this.backings.set(backing.nameHex, { backing, terms: command.backing, signature: command.signature });
      return { kind: "registered", backing: backing.nameHex };
    }
    if (command.kind === "witness") {
      // An empty first commitment would leave a later root requiring an
      // explicit opening, which this one-root profile deliberately omits.
      if (this.backings.size === 0) throw new PilotError("INVALID", "register the root before witnessing");
      this.venue.advance();
      this.state = this.sequencer.commit();
      const commitment = bytesToHex(encodeCommitment(this.state.commitment));
      const at = this.venue.witnessedIndex().toString();
      this.commitments.push({ bytes: commitment, at });
      return { kind: "witnessed", commitment, index: at };
    }
    const { backingName, op } = decodePublishedOp(hex(command.operation, 8192));
    const held = backingName === undefined ? undefined : this.backings.get(bytesToHex(backingName));
    if (held === undefined) throw new PilotError("INVALID", "backing is not registered");
    const backing = held.backing;
    // Reuse the reference's mutation doors, rather than implementing a second ledger.
    const receipt = (() => {
      switch (op.kind) {
        case "issue": return this.sequencer.submitIssue({ ...op, backing }, op.signature);
        case "transfer": return this.sequencer.submitTransfer({ ...op, backing }, op.signature);
        case "burn": return this.sequencer.submitBurn({ ...op, backing }, op.signature);
        case "demand": return this.sequencer.submitDemand({ ...op, backing }, op.signature);
        case "acceptance": return this.sequencer.submitAcceptance({ ...op, backing }, op.signature);
        case "release": return this.sequencer.submitRelease({ ...op, backing }, op.signature);
        case "withdrawal": return this.sequencer.submitWithdrawal({ ...op, backing }, op.signature);
        default: throw new PilotError("INVALID", "operation is outside the root pilot profile");
      }
    })();
    return { kind: "accepted", receipt: receiptToWire(receipt) };
  }
  view(names?: readonly Uint8Array[]): PilotView {
    return { profile: PILOT_PROFILE, operator: bytesToHex(this.sequencer.operator),
      venue: bytesToHex(this.venue.id), index: this.venue.witnessedIndex().toString(),
      backings: [...this.backings.values()].map(({ terms, signature }) => ({ terms, signature })),
      commitments: this.commitments.map(c => ({ ...c })),
      ...(this.state === undefined ? {} : {
        state: stateToWire(names === undefined ? this.state : compactState(this.state, names)),
      }) };
  }
}

/** Fault-injection observer for tests. No uncommitted data is passed to it. */
export type PilotCheckpoint = "applied" | "stored" | "committed";

export class PilotStore {
  private readonly db: DatabaseSync;
  private readonly secret: Uint8Array;
  private readonly venueId: Uint8Array;
  private engine: Engine | undefined;
  private applied = 0n;
  private closed = false;

  constructor(path: string, operatorSecret: Uint8Array, venue: Uint8Array,
    private readonly checkpoint?: (phase: PilotCheckpoint) => void) {
    if (path.trim() === "" || path === ":memory:") throw new PilotError("STORAGE", "a persistent database path is required");
    this.secret = Uint8Array.from(operatorSecret);
    this.venueId = Uint8Array.from(hex(bytesToHex(venue), 32, 32));
    const operator = bytesToHex(ed25519.getPublicKey(this.secret));
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (this.db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal" ||
          this.db.prepare("PRAGMA synchronous").get()?.synchronous !== 2) {
        throw new PilotError("STORAGE", "persistent WAL with FULL synchronization is required");
      }
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1),
          profile TEXT NOT NULL, operator TEXT NOT NULL, venue TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS commands (seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE, command TEXT NOT NULL, response TEXT NOT NULL) STRICT;
      `);
      const meta = this.db.prepare("SELECT profile,operator,venue FROM identity WHERE id=1").get();
      if (meta === undefined) {
        const count = this.db.prepare("SELECT count(*) AS n FROM commands").get();
        if (count?.n !== 0) throw new PilotError("STORAGE", "journal identity is missing");
        this.db.prepare("INSERT INTO identity VALUES(1,?,?,?)").run(PILOT_PROFILE, operator, bytesToHex(this.venueId));
      } else if (meta.profile !== PILOT_PROFILE || meta.operator !== operator || meta.venue !== bytesToHex(this.venueId)) {
        throw new PilotError("STORAGE", "journal profile, signing key or venue does not match");
      }
      this.load();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      this.db.close(); this.secret.fill(0);
      throw error;
    }
  }

  /** Called only under the SQLite transaction, including on reads. */
  private load(): void {
    const tipQuery = this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq, COUNT(*) AS n FROM commands");
    tipQuery.setReadBigInts(true);
    const tip = tipQuery.get();
    if (tip === undefined || typeof tip.seq !== "bigint" || tip.seq !== tip.n ||
        tip.seq > BigInt(PILOT_MAX_COMMANDS) || tip.seq < this.applied) {
      throw new PilotError("STORAGE", "journal is truncated, non-contiguous or exceeds the pilot limit");
    }
    this.engine ??= new Engine(this.secret, this.venueId);
    const query = this.db.prepare("SELECT seq,id,command,response FROM commands WHERE seq > ? ORDER BY seq");
    query.setReadBigInts(true);
    for (const row of query.all(this.applied)) {
      if (row.seq !== this.applied + 1n || typeof row.command !== "string" || typeof row.response !== "string") {
        throw new PilotError("STORAGE", "invalid journal row");
      }
      const command = parsePilotCommand(JSON.parse(row.command));
      if (command.id !== row.id || JSON.stringify(command) !== row.command ||
          JSON.stringify(this.engine.apply(command)) !== row.response) {
        throw new PilotError("STORAGE", "journal replay differs from its durable response");
      }
      this.applied++;
    }
  }

  private transaction<T>(body: (engine: Engine) => T): T {
    if (this.closed) throw new PilotError("STORAGE", "store is closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.load();
      const result = body(this.engine as Engine);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      // Even an uncertain COMMIT must discard speculation. The next transaction
      // reads SQLite's actual outcome and reconstructs every returned signature.
      this.engine = undefined; this.applied = 0n;
      try { this.db.exec("ROLLBACK"); } catch { /* it may already have committed */ }
      throw error;
    }
  }

  execute(value: unknown): PilotReply {
    const command = parsePilotCommand(value), encoded = JSON.stringify(command);
    const result = this.transaction(engine => {
      const prior = this.db.prepare("SELECT command,response FROM commands WHERE id=?").get(command.id);
      if (prior !== undefined) {
        if (prior.command !== encoded) throw new PilotError("CONFLICT", "command identifier already names different content");
        return JSON.parse(prior.response as string) as PilotReply;
      }
      if (this.applied >= BigInt(PILOT_MAX_COMMANDS)) throw new PilotError("LIMIT", "pilot journal is full");
      const response = engine.apply(command);
      this.checkpoint?.("applied");
      this.db.prepare("INSERT INTO commands(seq,id,command,response) VALUES(?,?,?,?)")
        .run(this.applied + 1n, command.id, encoded, JSON.stringify(response));
      this.checkpoint?.("stored");
      this.applied++;
      return response;
    });
    // A failure here models a lost response: the retry must return stored bytes.
    this.checkpoint?.("committed");
    return result;
  }
  view(names?: readonly Uint8Array[]): PilotView {
    return this.transaction(engine => engine.view(names));
  }
  nextNonce(backingName: Uint8Array, signer: Uint8Array): bigint {
    return this.transaction(engine => {
      const held = engine.backings.get(bytesToHex(backingName));
      if (held === undefined) throw new PilotError("INVALID", "unknown backing");
      return engine.sequencer.nextNonce(signer, held.backing);
    });
  }
  close(): void {
    if (!this.closed) { this.db.close(); this.secret.fill(0); this.engine = undefined; this.closed = true; }
  }
}
