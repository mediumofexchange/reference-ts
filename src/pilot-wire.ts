// Transport and verification for the deliberately narrow transparent pilot.
// JSON is an envelope only. Protocol signatures still cover canonical bytes.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decodeBacking, makeBacking, verifyBackingSignature, type Backing } from "./backing.js";
import { compareBytes, EncodingError } from "./bytes.js";
import { decodeCommitment, encodeCommitment, type ServedState } from "./commitment.js";
import { decodePublishedOp, encodePublishedOp, opMessageOfEntry } from "./oplog.js";
import { receiptCovers, receiptStatus, type Receipt } from "./receipt.js";
import { replayServedState } from "./recovery.js";
import { verifySignatureStrict } from "./keys.js";
import { LocalVenue, VenueError, type Venue } from "./venue.js";

export const PILOT_PROFILE = "transparent-pilot/v0-directory-v1";
export const PILOT_MAX_COMMANDS = 10_000;
export const PILOT_MAX_BACKINGS = 256;

export type PilotCommand =
  | { id: string; kind: "register"; backing: string; signature: string }
  | { id: string; kind: "submit"; operation: string }
  | { id: string; kind: "witness" };

export interface WireReceipt {
  backingName: string; opHash: string; position: string; after: string;
  operator: string; signature: string;
}
export type PilotReply =
  | { kind: "registered"; backing: string }
  | { kind: "accepted"; receipt: WireReceipt }
  | { kind: "witnessed"; commitment: string; index: string };

export interface WireState {
  commitment: string;
  snapshots: { name: string; operations: string[] }[];
  directory?: { name: string; digest: string }[];
}
export interface PilotView {
  profile: string; operator: string; venue: string; index: string;
  backings: { terms: string; signature: string }[];
  commitments: { bytes: string; at: string }[];
  state?: WireState;
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EncodingError("expected an object");
  }
  return value as Record<string, unknown>;
}
export function hex(value: unknown, maxBytes: number, exactBytes?: number): Uint8Array {
  if (typeof value !== "string" || value.length > maxBytes * 2 ||
      value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value) ||
      (exactBytes !== undefined && value.length !== exactBytes * 2)) {
    throw new EncodingError("expected bounded canonical lowercase hex");
  }
  return hexToBytes(value);
}
export function index(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new EncodingError("expected a canonical index");
  }
  const n = BigInt(value);
  if (n > 0xffffffffffffffffn) throw new EncodingError("index exceeds u64");
  return n;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new EncodingError("invalid list size");
  return value;
}

/** Reject unknown fields rather than silently dropping an intended command option. */
export function parsePilotCommand(value: unknown): PilotCommand {
  const r = object(value);
  if (typeof r.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(r.id)) {
    throw new EncodingError("invalid command identifier");
  }
  let command: PilotCommand;
  switch (r.kind) {
    case "register":
      command = { id: r.id, kind: r.kind, backing: bytesToHex(hex(r.backing, 4096)),
        signature: bytesToHex(hex(r.signature, 64, 64)) };
      // Decode before journalling, including canonical framing checks.
      decodeBacking(hex(command.backing, 4096));
      break;
    case "submit":
      command = { id: r.id, kind: r.kind, operation: bytesToHex(hex(r.operation, 8192)) };
      decodePublishedOp(hex(command.operation, 8192));
      break;
    case "witness": command = { id: r.id, kind: r.kind }; break;
    default: throw new EncodingError("unsupported pilot command");
  }
  if (Object.keys(r).some(key => !Object.hasOwn(command, key))) throw new EncodingError("unknown command field");
  return command;
}

export function requirePilotBacking(backing: Backing, operator: Uint8Array, venue: Uint8Array): void {
  const e = backing.evidence;
  if (backing.reliance.length !== 0 || !("thing" in backing.payout) ||
      e.witnessing === undefined || compareBytes(e.witnessing.venue, venue) !== 0 ||
      e.witnessing.interval !== 1n || compareBytes(e.operator, operator) !== 0 ||
      e.silence !== undefined || e.replacementRule !== undefined || e.nonService !== undefined) {
    throw new EncodingError("backing is outside the transparent pilot profile");
  }
}

export function receiptToWire(r: Receipt): WireReceipt {
  return { backingName: bytesToHex(r.backingName), opHash: bytesToHex(r.opHash),
    position: r.position.toString(), after: r.after.toString(),
    operator: bytesToHex(r.operator), signature: bytesToHex(r.signature) };
}
export function receiptFromWire(value: unknown): Receipt {
  const r = object(value);
  return { backingName: hex(r.backingName, 32, 32), opHash: hex(r.opHash, 32, 32),
    position: index(r.position), after: index(r.after), operator: hex(r.operator, 32, 32),
    signature: hex(r.signature, 64, 64) };
}
export function stateToWire(state: ServedState): WireState {
  return { commitment: bytesToHex(encodeCommitment(state.commitment)),
    snapshots: state.snapshots.map(s => ({ name: bytesToHex(s.name),
      operations: s.opLog.map(op => bytesToHex(encodePublishedOp(s.name, op))) })),
    ...(state.directory === undefined ? {} : { directory: state.directory.map(e =>
      ({ name: bytesToHex(e.name), digest: bytesToHex(e.digest) })) }) };
}
export function stateFromWire(value: unknown): ServedState {
  const r = object(value);
  let total = 0;
  const snapshots = list(r.snapshots, PILOT_MAX_BACKINGS).map(raw => {
    const s = object(raw), name = hex(s.name, 32, 32);
    const operations = list(s.operations, PILOT_MAX_COMMANDS);
    total += operations.length;
    if (total > PILOT_MAX_COMMANDS) throw new EncodingError("proof exceeds pilot limit");
    return { name, opLog: operations.map((bytes, position) => {
      const decoded = decodePublishedOp(hex(bytes, 8192));
      if (decoded.backingName === undefined || compareBytes(decoded.backingName, name) !== 0) throw new EncodingError("wrong log backing");
      return { ...decoded.op, position };
    }) };
  });
  return { commitment: decodeCommitment(hex(r.commitment, 136, 136)), snapshots,
    ...(r.directory === undefined ? {} : { directory: list(r.directory, PILOT_MAX_BACKINGS).map(raw => {
      const entry = object(raw);
      return { name: hex(entry.name, 32, 32), digest: hex(entry.digest, 32, 32) };
    }) }) };
}

/** Construct a fixed read view from the CONFIGURED LOCAL WITNESS response.
 * The caller trusts that endpoint for completeness/order. Signatures alone do
 * not authenticate this envelope's clock or establish independent witnessing. */
export function localViewFromWire(value: unknown, expectedOperator: Uint8Array, expectedVenue: Uint8Array): Venue {
  const v = object(value);
  if (v.profile !== PILOT_PROFILE || compareBytes(hex(v.operator, 32, 32), expectedOperator) !== 0 ||
      compareBytes(hex(v.venue, 32, 32), expectedVenue) !== 0) throw new EncodingError("wrong pilot view");
  const venue = new LocalVenue(expectedVenue), at = index(v.index);
  for (const raw of list(v.commitments, PILOT_MAX_COMMANDS)) {
    const r = object(raw), height = index(r.at);
    if (height > at || height <= venue.witnessedIndex()) throw new EncodingError("unordered witness record");
    venue.advance(height - venue.witnessedIndex());
    const commitment = decodeCommitment(hex(r.bytes, 136, 136));
    if (compareBytes(commitment.operator, expectedOperator) !== 0) throw new EncodingError("wrong witness operator");
    venue.publish(commitment);
  }
  if (at > venue.witnessedIndex()) venue.advance(at - venue.witnessedIndex());
  const refuse = (): never => { throw new VenueError("a captured pilot view is read-only"); };
  return Object.freeze({
    get id() { return venue.id; }, witnessedIndex: () => venue.witnessedIndex(), lag: () => venue.lag(),
    publish: refuse, publishOp: refuse, publishReplacement: refuse,
    publishRevocation: refuse, publishCommit: refuse,
    publishedOpsFor: venue.publishedOpsFor.bind(venue), replacementsFor: venue.replacementsFor.bind(venue),
    revocationsFor: venue.revocationsFor.bind(venue), commitsFor: venue.commitsFor.bind(venue),
    latestFor: venue.latestFor.bind(venue), witnessedAtFor: venue.witnessedAtFor.bind(venue),
    witnessedAtSequence: venue.witnessedAtSequence.bind(venue),
    firstCommitmentFor: venue.firstCommitmentFor.bind(venue), nextSequenceFor: venue.nextSequenceFor.bind(venue),
  });
}

export type PaymentCheck = { status: "final" | "pending" | "invalid" | "unavailable"; reason: string };

/** Check a saved signed transfer, not an operator's assertion about who got paid.
 * Terms, recipient and quantity are the caller's pinned acceptance policy, not
 * values chosen by an untrusted payment envelope. A final receipt proves
 * acceptance, never the recipient's current balance. */
export function verifyPilotPayment(args: {
  terms: Uint8Array; termsSignature: Uint8Array; operation: Uint8Array;
  receipt: Receipt; state?: ServedState; venue: Venue;
  operator: Uint8Array; recipient: Uint8Array; quantity: bigint;
}): PaymentCheck {
  try {
    const backing = makeBacking(decodeBacking(args.terms));
    requirePilotBacking(backing, args.operator, args.venue.id);
    if (!verifyBackingSignature(backing, args.termsSignature)) throw new EncodingError("unsigned terms");
    const { backingName, op } = decodePublishedOp(args.operation);
    if (backingName === undefined || compareBytes(backing.name, backingName) !== 0 || op.kind !== "transfer" ||
        compareBytes(op.to, args.recipient) !== 0 || op.quantity !== args.quantity ||
        !verifySignatureStrict(op.signature, opMessageOfEntry(backing.name, op), op.from) ||
        compareBytes(args.receipt.operator, args.operator) !== 0 ||
        !receiptCovers(backing.name, op, args.receipt)) throw new EncodingError("payment context or signature mismatch");
    if (args.state === undefined) return { status: "pending", reason: "No witnessed inclusion proof" };
    const c = args.state.commitment;
    const at = args.venue.witnessedAtSequence(c.operator, c.sequence);
    const observed = at === undefined ? undefined : args.venue.latestFor(c.operator, at);
    if (observed === undefined || compareBytes(encodeCommitment(observed), encodeCommitment(c)) !== 0 ||
        compareBytes(c.operator, args.operator) !== 0 || replayServedState(backing, args.venue, args.state) === undefined) {
      throw new EncodingError("unwitnessed or unlawful state");
    }
    const status = receiptStatus(backing, args.venue, args.receipt, args.state);
    if (status === "witnessed") return { status: "final", reason: "Included in lawful local witnessed history" };
    if (status === "pending") return { status: "pending", reason: "Waiting for inclusion" };
    return { status: "invalid", reason: `Receipt is ${status}` };
  } catch (error) {
    if (error instanceof VenueError) return { status: "unavailable", reason: "Witness view could not answer" };
    return { status: "invalid", reason: "Malformed, unrelated or unverifiable payment evidence" };
  }
}
