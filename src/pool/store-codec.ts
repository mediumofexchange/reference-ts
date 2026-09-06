// Strict JSON codecs for the local pool store. These records are persistence
// envelopes only: the signed protocol frames remain the canonical bytes of
// the constituents below, and receipt signatures are deliberately not
// verified here.

import { bytesToHex } from "@noble/hashes/utils.js";
import {
  compareBytes,
  EncodingError,
} from "../bytes.js";
import { decodeBacking, encodeBacking, type Backing } from "../backing.js";
import { directoryRoot, decodeCommitment, encodeCommitment, type Commitment } from "../commitment.js";
import {
  configurationHash,
  copyConfiguration,
  decodeSegmentHeader,
  decodeStatement,
  parsePublicInputs,
  segmentBytes,
  segmentIdentity,
  snapshotDigest,
  encodeStatement,
  type PoolConfiguration,
  type Statement,
} from "./statement.js";
import {
  copyPoolReceipt,
  poolReceiptBytes,
  type PoolReceipt,
} from "./receipt.js";
import type { Checkpoint, ImportEvidence, SegmentTrail, SignedBacking } from "./segment.js";
import type { PoolCheckpointEvidence } from "./checkpoint.js";
import type { PoolSnapshotEvidence } from "./descent.js";

const VERSION = 1;
const VALIDATION_VERSION = 2;
const OPENING_KIND = "opening";
const RECEIPT_KIND = "receipt";

type JsonObject = Record<string, unknown>;

interface StoredBacking {
  backing: string;
  signature: string;
}

interface StoredTrail {
  configuration: string;
  header: string;
  backings: StoredBacking[];
  statements: string[];
}

interface StoredDirectoryEntry {
  name: string;
  digest: string;
}

interface StoredCheckpoint {
  commitment: string;
  directory: StoredDirectoryEntry[];
}

interface StoredEvidence {
  checkpoint: StoredCheckpoint;
  trail: StoredTrail;
  length: string;
}

interface StoredOpening {
  version: number;
  kind: typeof OPENING_KIND;
  trail: StoredTrail;
  evidence: StoredEvidence[];
  validation?: StoredValidation[];
}

interface StoredSnapshot {
  backing: string;
  header: string;
  historyHash: string;
  issued: string;
  burned: string;
  backings: StoredBacking[];
}

interface StoredValidation extends StoredCheckpoint {
  snapshots?: StoredSnapshot[];
  history?: { trail: StoredTrail; length: string };
}

interface StoredReceipt {
  version: number;
  kind: typeof RECEIPT_KIND;
  domain: string;
  segment: string;
  scopeRoot: string;
  position: string;
  statementHash: string;
  historyHash: string;
  proofHash: string;
  signatureHash: string;
  after: string;
  operator: string;
  signature: string;
}

function fail(message: string): never {
  throw new EncodingError(message);
}

function object(value: unknown, keys: readonly string[], what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`malformed ${what}`);
  const actual = Object.keys(value as JsonObject);
  if (actual.length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail(`malformed ${what}`);
  }
  return value as JsonObject;
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`malformed ${what}`);
  return value;
}

function optionalObject(value: unknown, required: readonly string[], optional: readonly string[], what: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`malformed ${what}`);
  return object(value, [...required, ...optional.filter(key => Object.prototype.hasOwnProperty.call(value, key))], what);
}

function string(value: unknown, what: string): string {
  if (typeof value !== "string") fail(`malformed ${what}`);
  return value;
}

function decimal(value: bigint, what: string): string {
  if (typeof value !== "bigint" || value < 0n) fail(`${what} must be a nonnegative bigint`);
  return value.toString(10);
}

function parseDecimal(value: unknown, what: string): bigint {
  const text = string(value, what);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) fail(`${what} is not canonical decimal`);
  try {
    return BigInt(text);
  } catch {
    fail(`${what} is not a bigint`);
  }
}

function hex(value: Uint8Array, what: string, length?: number): string {
  if (!(value instanceof Uint8Array)) fail(`${what} is not bytes`);
  if (length !== undefined && value.length !== length) fail(`${what} must be ${length} bytes`);
  return bytesToHex(value);
}

function parseHex(value: unknown, what: string, length?: number): Uint8Array {
  const text = string(value, what);
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) fail(`${what} is not lowercase hex`);
  if (length !== undefined && text.length !== length * 2) fail(`${what} must be ${length} bytes`);
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return compareBytes(a, b) === 0;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") fail("stored record must be text");
  try {
    return JSON.parse(text);
  } catch {
    fail("malformed stored JSON");
  }
}

function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) fail("stored record is not JSON");
  return text;
}

function assertCanonical(text: string, value: unknown): void {
  if (canonicalJson(value) !== text) fail("noncanonical stored JSON");
}

function statementShape(value: unknown): asserts value is Statement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("malformed statement");
  const statement = value as Statement;
  const keys = statement.kind === 1
    ? ["kind", "publicInputs", "proof", "obligorSignature"]
    : ["kind", "publicInputs", "proof"];
  object(statement, keys, "statement");
}

function storedTrail(trail: SegmentTrail, expectedConfiguration?: Uint8Array): StoredTrail {
  object(trail, ["configuration", "header", "backings", "statements"], "trail");
  const domain = configurationHash(trail.configuration);
  if (expectedConfiguration !== undefined && !same(domain, expectedConfiguration)) {
    fail("trail configuration does not match the opening configuration");
  }
  const header = segmentBytes(trail.header);
  if (!same(trail.header.domain, domain)) fail("trail header has the wrong configuration");
  const backings = array(trail.backings, "trail backings").map((value) => {
    const item = object(value, ["backing", "signature"], "signed backing");
    const backing = item["backing"] as Backing;
    return {
      backing: hex(encodeBacking(backing), "backing"),
      signature: hex(item["signature"] as Uint8Array, "backing signature", 64),
    };
  });
  const statements = array(trail.statements, "trail statements").map((value) => {
    const statement = value as Statement;
    statementShape(statement);
    if (!same(parsePublicInputs(statement.kind, statement.publicInputs).domain, domain)) {
      fail("statement has the wrong configuration");
    }
    return hex(encodeStatement(domain, statement), "statement");
  });
  return {
    configuration: hex(domain, "configuration", 32),
    header: hex(header, "segment header"),
    backings,
    statements,
  };
}

function readTrail(value: unknown, configuration: PoolConfiguration, expectedConfiguration: Uint8Array): SegmentTrail {
  const wire = object(value, ["configuration", "header", "backings", "statements"], "trail");
  const domain = parseHex(wire["configuration"], "trail configuration", 32);
  if (!same(domain, expectedConfiguration)) fail("trail configuration does not match the opening configuration");
  const header = decodeSegmentHeader(parseHex(wire["header"], "segment header"));
  if (!same(header.domain, domain)) fail("trail header has the wrong configuration");
  const backings: SignedBacking[] = array(wire["backings"], "trail backings").map((value) => {
    const item = object(value, ["backing", "signature"], "signed backing");
    return {
      backing: decodeBacking(parseHex(item["backing"], "backing")),
      signature: parseHex(item["signature"], "backing signature", 64),
    };
  });
  const statements: Statement[] = array(wire["statements"], "trail statements").map((value) => {
    const decoded = decodeStatement(parseHex(value, "statement"));
    if (!same(decoded.domain, domain) || !same(parsePublicInputs(decoded.statement.kind, decoded.statement.publicInputs).domain, domain)) {
      fail("statement has the wrong configuration");
    }
    return decoded.statement;
  });
  return {
    configuration: copyConfiguration(configuration),
    header,
    backings,
    statements,
  };
}

function storedCheckpoint(checkpoint: Checkpoint): StoredCheckpoint {
  object(checkpoint, ["commitment", "directory"], "checkpoint");
  const commitmentBytes = encodeCommitment(checkpoint.commitment);
  const root = directoryRoot(checkpoint.directory);
  if (!same(root, checkpoint.commitment.root)) fail("checkpoint directory does not match its commitment");
  const directory = array(checkpoint.directory, "checkpoint directory").map((value) => {
    const entry = object(value, ["name", "digest"], "directory entry");
    return {
      name: hex(entry["name"] as Uint8Array, "directory name", 32),
      digest: hex(entry["digest"] as Uint8Array, "directory digest", 32),
    };
  });
  return { commitment: hex(commitmentBytes, "checkpoint commitment"), directory };
}

function readCheckpoint(value: unknown): Checkpoint {
  const wire = object(value, ["commitment", "directory"], "checkpoint");
  const commitment = decodeCommitment(parseHex(wire["commitment"], "checkpoint commitment", 136));
  const directory = array(wire["directory"], "checkpoint directory").map((value) => {
    const entry = object(value, ["name", "digest"], "directory entry");
    return {
      name: parseHex(entry["name"], "directory name", 32),
      digest: parseHex(entry["digest"], "directory digest", 32),
    };
  });
  if (!same(directoryRoot(directory), commitment.root)) fail("checkpoint directory does not match its commitment");
  return { commitment, directory };
}

function storedEvidence(item: ImportEvidence, configuration: Uint8Array): StoredEvidence {
  object(item, ["checkpoint", "trail", "length"], "import evidence");
  const trail = storedTrail(item.trail, configuration);
  if (typeof item.length !== "bigint" || item.length < 0n || item.length > BigInt(trail.statements.length)) {
    fail("import length exceeds its trail");
  }
  return {
    checkpoint: storedCheckpoint(item.checkpoint),
    trail,
    length: decimal(item.length, "import length"),
  };
}

function readEvidence(value: unknown, configuration: PoolConfiguration, expectedConfiguration: Uint8Array): ImportEvidence {
  const wire = object(value, ["checkpoint", "trail", "length"], "import evidence");
  const trail = readTrail(wire["trail"], configuration, expectedConfiguration);
  const length = parseDecimal(wire["length"], "import length");
  if (length > BigInt(trail.statements.length)) fail("import length exceeds its trail");
  return { checkpoint: readCheckpoint(wire["checkpoint"]), trail, length };
}

function storedSnapshot(snapshot: PoolSnapshotEvidence, domain: Uint8Array): StoredSnapshot {
  object(snapshot, ["backing", "header", "historyHash", "issued", "burned", "backings"], "snapshot");
  if (!same(snapshot.header.domain, domain)) fail("snapshot header has the wrong configuration");
  // Validate the exact protocol framing, including u64 totals. Authentication
  // against the directory and signed scope belongs to the checkpoint reader.
  snapshotDigest(snapshot.backing, segmentIdentity(snapshot.header), snapshot.historyHash, snapshot.issued, snapshot.burned);
  return {
    backing: hex(snapshot.backing, "snapshot backing", 32),
    header: hex(segmentBytes(snapshot.header), "snapshot header"),
    historyHash: hex(snapshot.historyHash, "snapshot history hash", 32),
    issued: decimal(snapshot.issued, "snapshot issued"),
    burned: decimal(snapshot.burned, "snapshot burned"),
    backings: array(snapshot.backings, "snapshot backings").map(value => {
      const item = object(value, ["backing", "signature"], "signed backing");
      return { backing: hex(encodeBacking(item["backing"] as Backing), "backing"),
        signature: hex(item["signature"] as Uint8Array, "backing signature", 64) };
    }),
  };
}

function readSnapshot(value: unknown, domain: Uint8Array): PoolSnapshotEvidence {
  const wire = object(value, ["backing", "header", "historyHash", "issued", "burned", "backings"], "snapshot");
  const snapshot = {
    backing: parseHex(wire["backing"], "snapshot backing", 32),
    header: decodeSegmentHeader(parseHex(wire["header"], "snapshot header")),
    historyHash: parseHex(wire["historyHash"], "snapshot history hash", 32),
    issued: parseDecimal(wire["issued"], "snapshot issued"),
    burned: parseDecimal(wire["burned"], "snapshot burned"),
    backings: array(wire["backings"], "snapshot backings").map(value => {
      const item = object(value, ["backing", "signature"], "signed backing");
      return { backing: decodeBacking(parseHex(item["backing"], "backing")),
        signature: parseHex(item["signature"], "backing signature", 64) };
    }),
  };
  storedSnapshot(snapshot, domain);
  return snapshot;
}

function storedValidation(item: PoolCheckpointEvidence, domain: Uint8Array): StoredValidation {
  const checked = optionalObject(item, ["commitment", "directory"], ["snapshots", "history"], "validation evidence");
  const result: StoredValidation = storedCheckpoint({ commitment: item.commitment, directory: item.directory });
  if (Object.prototype.hasOwnProperty.call(checked, "snapshots")) {
    result.snapshots = array(item.snapshots, "validation snapshots").map(value => storedSnapshot(value as PoolSnapshotEvidence, domain));
  }
  if (Object.prototype.hasOwnProperty.call(checked, "history")) {
    const history = object(item.history, ["trail", "length"], "validation history");
    const trail = storedTrail(history["trail"] as SegmentTrail, domain);
    const length = history["length"] as bigint;
    if (typeof length !== "bigint" || length < 0n || length > BigInt(trail.statements.length)) fail("validation length exceeds its trail");
    result.history = { trail, length: decimal(length, "validation length") };
  }
  return result;
}

function readValidation(value: unknown, configuration: PoolConfiguration, domain: Uint8Array): PoolCheckpointEvidence {
  const wire = optionalObject(value, ["commitment", "directory"], ["snapshots", "history"], "validation evidence");
  const checkpoint = readCheckpoint({ commitment: wire["commitment"], directory: wire["directory"] });
  const snapshots = Object.prototype.hasOwnProperty.call(wire, "snapshots")
    ? array(wire["snapshots"], "validation snapshots").map(value => readSnapshot(value, domain)) : undefined;
  let history: PoolCheckpointEvidence["history"];
  if (Object.prototype.hasOwnProperty.call(wire, "history")) {
    const encoded = object(wire["history"], ["trail", "length"], "validation history");
    const trail = readTrail(encoded["trail"], configuration, domain);
    const length = parseDecimal(encoded["length"], "validation length");
    if (length > BigInt(trail.statements.length)) fail("validation length exceeds its trail");
    history = { trail, length };
  }
  return { ...checkpoint, ...(snapshots === undefined ? {} : { snapshots }), ...(history === undefined ? {} : { history }) };
}

/** Own canonical validation bytes without asserting checkpoint finality. */
export function copyPoolCheckpointEvidence(evidence: PoolCheckpointEvidence, configuration: PoolConfiguration): PoolCheckpointEvidence {
  const domain = configurationHash(configuration);
  return readValidation(storedValidation(evidence, domain), configuration, domain);
}

function storedOpening(trail: SegmentTrail, evidence: readonly ImportEvidence[], validation?: readonly PoolCheckpointEvidence[]): StoredOpening {
  const domain = configurationHash(trail.configuration);
  const encodedTrail = storedTrail(trail, domain);
  if (!Array.isArray(evidence)) fail("malformed import evidence");
  return {
    version: validation === undefined ? VERSION : VALIDATION_VERSION,
    kind: OPENING_KIND,
    trail: encodedTrail,
    evidence: evidence.map((item) => storedEvidence(item, domain)),
    ...(validation === undefined ? {} : { validation: array(validation, "validation evidence").map(item => storedValidation(item as PoolCheckpointEvidence, domain)) }),
  };
}

/** Encode one local SQLite opening record as canonical compact JSON. */
export function encodeStoredOpening(trail: SegmentTrail, evidence: readonly ImportEvidence[], validation?: readonly PoolCheckpointEvidence[]): string {
  return canonicalJson(storedOpening(trail, evidence, validation));
}

/** Decode and strictly canonicalize one local SQLite opening record. */
export function decodeStoredOpening(text: string, configuration: PoolConfiguration): { trail: SegmentTrail; evidence: ImportEvidence[]; validation?: PoolCheckpointEvidence[] } {
  const parsed = optionalObject(parseJson(text), ["version", "kind", "trail", "evidence"], ["validation"], "opening record");
  const version = parsed["version"];
  if ((version !== VERSION && version !== VALIDATION_VERSION) || parsed["kind"] !== OPENING_KIND) fail("wrong opening record kind or version");
  object(parsed, ["version", "kind", "trail", "evidence", ...(version === VALIDATION_VERSION ? ["validation"] : [])], "opening record");
  const expected = configurationHash(configuration);
  const trail = readTrail(parsed["trail"], configuration, expected);
  const evidence = array(parsed["evidence"], "import evidence").map((value) => readEvidence(value, configuration, expected));
  const validation = version === VALIDATION_VERSION
    ? array(parsed["validation"], "validation evidence").map(value => readValidation(value, configuration, expected)) : undefined;
  const result = { trail, evidence, ...(validation === undefined ? {} : { validation }) };
  assertCanonical(text, storedOpening(trail, evidence, validation));
  return result;
}

function storedReceipt(receipt: PoolReceipt): StoredReceipt {
  object(receipt, ["domain", "segment", "scopeRoot", "position", "statementHash", "historyHash", "proofHash", "signatureHash", "after", "operator", "signature"], "receipt");
  // This is the framing validation boundary for the signed fields. Signature
  // verification belongs to the caller that has the expected authority.
  poolReceiptBytes(receipt);
  return {
    version: VERSION,
    kind: RECEIPT_KIND,
    domain: hex(receipt.domain, "receipt domain", 32),
    segment: hex(receipt.segment, "receipt segment", 32),
    scopeRoot: decimal(receipt.scopeRoot, "receipt scope root"),
    position: decimal(receipt.position, "receipt position"),
    statementHash: hex(receipt.statementHash, "receipt statement hash", 32),
    historyHash: hex(receipt.historyHash, "receipt history hash", 32),
    proofHash: hex(receipt.proofHash, "receipt proof hash", 32),
    signatureHash: hex(receipt.signatureHash, "receipt signature hash", 32),
    after: decimal(receipt.after, "receipt after"),
    operator: hex(receipt.operator, "receipt operator", 32),
    signature: hex(receipt.signature, "receipt signature", 64),
  };
}

/** Encode one local SQLite receipt record as canonical compact JSON. */
export function encodeStoredReceipt(receipt: PoolReceipt): string {
  return canonicalJson(storedReceipt(receipt));
}

/** Decode and strictly canonicalize one local SQLite receipt record. */
export function decodeStoredReceipt(text: string): PoolReceipt {
  const parsed = object(parseJson(text), ["version", "kind", "domain", "segment", "scopeRoot", "position", "statementHash", "historyHash", "proofHash", "signatureHash", "after", "operator", "signature"], "receipt record");
  if (parsed["version"] !== VERSION || parsed["kind"] !== RECEIPT_KIND) fail("wrong receipt record kind or version");
  const receipt: PoolReceipt = {
    domain: parseHex(parsed["domain"], "receipt domain", 32),
    segment: parseHex(parsed["segment"], "receipt segment", 32),
    scopeRoot: parseDecimal(parsed["scopeRoot"], "receipt scope root"),
    position: parseDecimal(parsed["position"], "receipt position"),
    statementHash: parseHex(parsed["statementHash"], "receipt statement hash", 32),
    historyHash: parseHex(parsed["historyHash"], "receipt history hash", 32),
    proofHash: parseHex(parsed["proofHash"], "receipt proof hash", 32),
    signatureHash: parseHex(parsed["signatureHash"], "receipt signature hash", 32),
    after: parseDecimal(parsed["after"], "receipt after"),
    operator: parseHex(parsed["operator"], "receipt operator", 32),
    signature: parseHex(parsed["signature"], "receipt signature", 64),
  };
  poolReceiptBytes(receipt);
  assertCanonical(text, storedReceipt(receipt));
  return copyPoolReceipt(receipt);
}
