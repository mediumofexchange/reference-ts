// Candidate configuration framing, pool-v3 §11.1 at 916bffb.
// No approved domain, declaration capability or artifact loader.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter, compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { V3_CONFIG_CONTEXT as CONTEXT } from "../../contexts.js";

export const RELATIONS = Object.freeze(["issue", "spend", "burn", "demand", "settle", "request"] as const);
export type Relation = typeof RELATIONS[number];
/** Each relation's record kind (§3): a proof of that kind is verified under that relation's key. */
export const RELATION_KINDS: Readonly<Record<Relation, number>> = Object.freeze({ issue: 1, spend: 2, burn: 3, demand: 4, settle: 6, request: 7 });
/** A verifier's circuit identities by relation name; a proof verifier also names the kind it routes to each. */
export type VerifierIdentities = { readonly [name: string]: { readonly bytecode: Uint8Array; readonly vk: Uint8Array; readonly kind?: number } };
export interface CandidateConfiguration {
  readonly circuits: Readonly<Record<Relation, { readonly bytecode: Uint8Array; readonly vk: Uint8Array }>>;
  readonly helper: Uint8Array;
}
/** Every relation's proof length under the pinned backend and verifier target (pool-v2 §12): the backend
 * refuses a valid proof with a word added or removed, so it fixes the configuration's longest publication
 * (`publicationBound`), which venue-ergo §8 requires to fit one transaction. The conformance check asserts both. */
export const PROOF_BYTES = 14656;
const BOUNDS = Uint8Array.of(32, 16, 2, 4, 1);
const HELPER = Uint8Array.from("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8".match(/../g)!, x => parseInt(x, 16));
export const CONFIGURATION_BYTES = 439;

/** An owned copy, never over shared memory, judged by its own length. */
function bytes(value: unknown, length: number): Uint8Array {
  const own = copyUnshared(value as Uint8Array);
  if (own.length !== length) throw new EncodingError("invalid candidate configuration bytes");
  return own;
}

export function configurationBytes(value: CandidateConfiguration): Uint8Array {
  const circuits = value === null || typeof value !== "object" ? null : value.circuits;
  if (circuits === null || typeof circuits !== "object" ||
    Object.keys(circuits).sort().join(",") !== [...RELATIONS].sort().join(",")) {
    throw new EncodingError("configuration must name all six relations exactly");
  }
  const helper = bytes(value.helper, 32);
  if (compareBytes(helper, HELPER) !== 0) throw new EncodingError("unsupported helper");
  const w = new ByteWriter(); w.context(CONTEXT);
  for (const name of RELATIONS) {
    const identity = circuits[name];
    if (identity === null || typeof identity !== "object") throw new EncodingError("missing circuit identity");
    w.fixed(bytes(identity.bytecode, 32), 32, "bytecode"); w.fixed(bytes(identity.vk, 32), 32, "key");
  }
  w.fixed(helper, 32, "helper"); w.fixed(BOUNDS, 5, "fixed bounds and delivery profile");
  return w.finish();
}

export function decodeConfiguration(input: Uint8Array): CandidateConfiguration {
  const r = new ByteReader(bytes(input, CONFIGURATION_BYTES));
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

/**
 * §11.1: a verifier that names its circuits must name exactly this configuration's six relations, each by its
 * bytecode and key identity, relations a trail never uses included; otherwise every proof would be judged under
 * another key. A kind the verifier names for a relation must be that relation's, or identities that match by
 * name could route a proof to another relation's key. A caller's setup error, so a TypeError, never an evidence
 * verdict. A verifier that names none (a test double) has nothing to compare, and a kept store refuses it.
 * Returns the copy the caller keeps, each field read once.
 */
export function requireConfigurationVerifier(configuration: CandidateConfiguration,
  identities: VerifierIdentities | undefined): VerifierIdentities | undefined {
  if (identities === undefined) return undefined;
  const refuse = (): never => { throw new TypeError("the verifier's circuit identities are not the configuration's"); };
  if (identities === null || typeof identities !== "object" || Object.keys(identities).length !== RELATIONS.length) refuse();
  const owned: { [name: string]: VerifierIdentities[string] } = {};
  for (const name of RELATIONS) {
    const own: unknown = identities[name], expected = configuration.circuits[name];
    if (own === null || typeof own !== "object") refuse();
    const { bytecode, vk, kind } = own as { readonly bytecode: unknown; readonly vk: unknown; readonly kind: unknown };
    let copies: [Uint8Array, Uint8Array];
    try { copies = [copyUnshared(bytecode as Uint8Array), copyUnshared(vk as Uint8Array)]; } catch { return refuse(); }
    if (compareBytes(copies[0], expected.bytecode) !== 0 || compareBytes(copies[1], expected.vk) !== 0) refuse();
    if (kind !== undefined && kind !== RELATION_KINDS[name]) refuse();
    owned[name] = Object.freeze({ bytecode: copies[0], vk: copies[1], ...(kind === undefined ? {} : { kind: kind as number }) });
  }
  return Object.freeze(owned);
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
