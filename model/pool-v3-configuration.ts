// Candidate configuration framing, pool-v3 §11.1 at 916bffb.
// No approved domain, declaration capability, artifact loader or runtime API.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter, compareBytes, EncodingError } from "../src/bytes.js";

export const RELATIONS = Object.freeze(["issue", "spend", "burn", "demand", "settle", "request"] as const);
export type Relation = typeof RELATIONS[number];
export interface CandidateConfiguration {
  readonly circuits: Readonly<Record<Relation, { readonly bytecode: Uint8Array; readonly vk: Uint8Array }>>;
  readonly helper: Uint8Array;
}
const CONTEXT = new TextEncoder().encode("moe/pool/v3/config");
const BOUNDS = Uint8Array.of(32, 16, 2, 4, 1);
const HELPER = Uint8Array.from("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8".match(/../g)!, x => parseInt(x, 16));
export const CONFIGURATION_BYTES = 439;

function bytes(value: unknown, length: number): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length || value.buffer instanceof SharedArrayBuffer) {
    throw new EncodingError("invalid candidate configuration bytes");
  }
}

export function configurationBytes(value: CandidateConfiguration): Uint8Array {
  if (value === null || typeof value !== "object" || value.circuits === null || typeof value.circuits !== "object" ||
    Object.keys(value.circuits).sort().join(",") !== [...RELATIONS].sort().join(",")) {
    throw new EncodingError("configuration must name all six relations exactly");
  }
  bytes(value.helper, 32);
  if (compareBytes(value.helper, HELPER) !== 0) throw new EncodingError("unsupported helper");
  const w = new ByteWriter(); w.context(CONTEXT);
  for (const name of RELATIONS) {
    const identity = value.circuits[name];
    if (identity === null || typeof identity !== "object") throw new EncodingError("missing circuit identity");
    bytes(identity.bytecode, 32); bytes(identity.vk, 32);
    w.fixed(identity.bytecode, 32, "bytecode"); w.fixed(identity.vk, 32, "key");
  }
  w.fixed(value.helper, 32, "helper"); w.fixed(BOUNDS, 5, "fixed bounds and delivery profile");
  return w.finish();
}

export function decodeConfiguration(input: Uint8Array): CandidateConfiguration {
  bytes(input, CONFIGURATION_BYTES);
  const r = new ByteReader(new Uint8Array(input));
  if (compareBytes(r.raw(CONTEXT.length), CONTEXT) !== 0) throw new EncodingError("wrong configuration context");
  const circuits = Object.fromEntries(RELATIONS.map(name => [name, { bytecode: r.raw(32), vk: r.raw(32) }])) as
    Record<Relation, { bytecode: Uint8Array; vk: Uint8Array }>;
  const helper = r.raw(32);
  if (compareBytes(helper, HELPER) !== 0 || compareBytes(r.raw(5), BOUNDS) !== 0) {
    throw new EncodingError("unsupported configuration constants");
  }
  r.expectEnd();
  return { circuits, helper };
}

export function configurationHash(value: CandidateConfiguration): Uint8Array {
  return sha256(configurationBytes(value));
}

/** Expected identities are independently held, never decoded from a package.
 * This checks framing/identity only; it cannot approve a configuration. */
export function verifyConfiguration(input: Uint8Array, expected: CandidateConfiguration): boolean {
  try {
    const decoded = decodeConfiguration(input);
    return compareBytes(configurationBytes(decoded), configurationBytes(expected)) === 0;
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}
