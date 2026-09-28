// C4.1–5 receiving on guarded reference venues. Node 24, plaintext local
// custody: database/WAL/backups require protected storage and one active copy.
// A saved fulfillment is historical local accounting, never a second credit or
// permission to spend. Request authentication and independent public-evidence
// retention are caller obligations; this module supplies neither transport nor
// physical storage/rollback protection.
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { copyRequest, type RangeRequest, type RangeLimits } from "../../record-range.js";
import type { RecordVenue } from "../../record-venue.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../../venue-records.js";
import { isValue } from "../field.js";
import { prepareExactOutput, type PreparedOutput } from "./capsules.js";
import { configurationBytes, configurationHash, decodeConfiguration } from "./configuration.js";
import { requireReferenceVenue } from "./guard.js";
import { readSingleBackingFrontier, type PackageReader } from "./package-reader.js";
import type { SignedTerms } from "./reader.js";
import { locked, tagOf } from "./recovery.js";
import { applyForceEffects, openForceState } from "./state.js";
import { rootTermsName } from "./terms.js";
import { copyPaymentRequest, type PaymentRequest } from "./wallet-request.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const PROFILE = "moe/wallet/v3/receiver/1", MAX_OWNER = (1n << 63n) - 1n;
export class V3WalletError extends Error {
  constructor(readonly code: "INVALID" | "UNKNOWN" | "CONFLICT" | "FENCED" | "STORAGE" |
    "ABSENT" | "SPENT" | "LOCKED" | "CHANGED_VIEW", message: string) { super(message); this.name = "V3WalletError"; }
}
function requireThat(ok: boolean, code: V3WalletError["code"], message: string): asserts ok {
  if (!ok) throw new V3WalletError(code, message);
}
function alias(value: string): string {
  requireThat(typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value), "INVALID", "invalid invoice alias");
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

export class V3ReceiverWallet {
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
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS receiver_identity (id INTEGER PRIMARY KEY CHECK(id=1),
          profile TEXT NOT NULL, domain TEXT NOT NULL, venue TEXT NOT NULL, seed BLOB NOT NULL, owner INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS receiver_requests (alias TEXT PRIMARY KEY, request_id BLOB NOT NULL UNIQUE,
          backing BLOB NOT NULL, value TEXT NOT NULL, cm TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE IF NOT EXISTS receiver_fulfilled (alias TEXT PRIMARY KEY, cm TEXT NOT NULL UNIQUE,
          checkpoint BLOB NOT NULL, judging_index TEXT NOT NULL, package BLOB NOT NULL, terms BLOB NOT NULL, signature BLOB NOT NULL) STRICT;`);
      let meta = this.metadata();
      if (meta === undefined) {
        requireThat(this.db.prepare("SELECT COUNT(*) AS n FROM receiver_requests").get()?.n === 0 &&
          this.db.prepare("SELECT COUNT(*) AS n FROM receiver_fulfilled").get()?.n === 0, "STORAGE", "wallet identity is missing");
        this.db.prepare("INSERT INTO receiver_identity VALUES(1,?,?,?,?,0)").run(PROFILE, hex(this.domain), hex(this.venueId), randomBytes(32));
        meta = this.metadata()!;
      }
      requireThat(meta.profile === PROFILE && meta.domain === hex(this.domain) && meta.venue === hex(this.venueId),
        "CONFLICT", "wallet configuration or venue changed");
      requireThat(typeof meta.owner === "bigint" && meta.owner >= 0n && meta.owner < MAX_OWNER,
        "STORAGE", "wallet owner counter exhausted");
      this.seed = identifier(meta.seed as Uint8Array); this.owner = meta.owner + 1n;
      this.db.prepare("UPDATE receiver_identity SET owner=? WHERE id=1").run(this.owner);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve error */ }
      this.db.close(); throw error;
    }
  }

  private metadata() {
    const query = this.db.prepare("SELECT * FROM receiver_identity WHERE id=1"); query.setReadBigInts(true); return query.get();
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
        const requestId = randomBytes(32);
        if (this.db.prepare("SELECT 1 FROM receiver_requests WHERE request_id=?").get(requestId) !== undefined) continue;
        let out: PreparedOutput;
        try { out = prepareExactOutput(this.seed, this.domain, requestId, ownBacking, value); }
        catch (error) {
          // C4.2 draws again for the astronomically unlikely zero hash output.
          if (error instanceof EncodingError && /^(owner|commitment|nullifier) must be nonzero$/.test(error.message)) continue;
          throw error;
        }
        if (this.db.prepare("SELECT 1 FROM receiver_requests WHERE cm=?").get(out.cm.toString()) !== undefined) continue;
        this.db.prepare("INSERT INTO receiver_requests VALUES(?,?,?,?,?)").run(name, requestId, ownBacking, value.toString(), out.cm.toString());
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
    const bytes = copyUnshared(packageBytes), terms = { terms: copyUnshared(signed.terms), signature: copyUnshared(signed.signature) };
    const note = this.prepared(name);
    requireThat(this.fulfillment(name) === undefined, "CONFLICT", "request already fulfilled");
    requireThat(same(rootTermsName(terms.terms), note.opening.backing), "INVALID", "terms do not name requested backing");
    const at = this.options.venue.witnessedIndex();
    requireThat(isValue(at), "INVALID", "invalid witnessed index");
    const observed = observedView(this.options.venue, this.venueId, at);
    const result = await readSingleBackingFrontier(bytes, terms, at, { ...this.options, venue: observed.venue });
    const canonical = result.canonical;
    requireThat(canonical !== undefined, "ABSENT", "no canonical payment");
    const state = canonical.state;
    requireThat(state.scanOutputs.some(out => out.cm === note.cm && out.capsule !== undefined && same(out.capsule, note.capsule)),
      "ABSENT", "exact requested output and capsule are absent");
    const force = openForceState(state);
    for (const publication of result.force) if (publication.index > state.adoptionIndex) applyForceEffects(force, publication.record);
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

  close(): void { if (!this.closed) { this.closed = true; this.seed.fill(0); this.db.close(); } }
}
