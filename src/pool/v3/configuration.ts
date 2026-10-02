// The configuration frame (pool-v3 §11.1) and the implementation's manifest of
// §11.4's adopted configuration. Every v3 entry point runs under that one
// configuration; no caller, package or terms field selects another.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter, compareBytes, copyBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { V3_CONFIG_CONTEXT as CONTEXT } from "../../contexts.js";
import { BN254_PARAMETERS } from "../parameters.js";

export const RELATIONS = Object.freeze(["issue", "spend", "burn", "demand", "settle", "request"] as const);
export type Relation = typeof RELATIONS[number];
/** Each relation's record kind (§3): a proof of that kind is verified under that relation's key. */
export const RELATION_KINDS: Readonly<Record<Relation, number>> = Object.freeze({ issue: 1, spend: 2, burn: 3, demand: 4, settle: 6, request: 7 });
/** A verifier's circuit identities by relation name; a proof verifier also names the kind it routes to each. */
export type VerifierIdentities = { readonly [name: string]: { readonly bytecode: Uint8Array; readonly vk: Uint8Array; readonly kind?: number } };
export interface Configuration {
  readonly circuits: Readonly<Record<Relation, { readonly bytecode: Uint8Array; readonly vk: Uint8Array }>>;
  readonly helper: Uint8Array;
}

/**
 * The implementation's manifest (pool-v3 §11.1) of §11.4's adopted configuration, held here and never read from
 * served evidence. Identities are SHA-256 in hex. `sources` are the eight files the six relations compile from
 * together (`poseidon2.nr` is the helper); `toolchain` the compiler that produced the bytecode identities and the
 * backend that derives the keys under `verifierTarget`. `parameters` are the proving parameters' accepted layout
 * (§4), `BN254_PARAMETERS` beside the backend's loader (`../parameters.ts`). `proofBytes` is every relation's proof
 * length under the backend: it refuses a valid proof with a word added or removed, so it fixes the longest
 * publication (`publicationBound`), which venue-ergo §8 requires to fit one transaction. The conformance check
 * (`scripts/pool/v3/check.mjs`) compiles the sources, derives the keys and asserts every entry.
 */
export const POOL_V3_MANIFEST = Object.freeze({
  toolchain: Object.freeze({ "@aztec/bb.js": "5.2.0", "@noir-lang/noir_js": "1.0.0-beta.26", "@noir-lang/noir_wasm": "1.0.0-beta.26" }),
  verifierTarget: "noir-recursive",
  sources: Object.freeze({
    "issue.nr": "0160497d77500bec7a62548b13908f46be122dfaf6f54cc0b720cf328a9c6ad6",
    "spend.nr": "920c4702d2ae0c3e2d0f251fe298c39c0d658a390220b0c4d68b4e06c31ae695",
    "burn.nr": "28548a85406ce232303c8bd7bb8e3506337a7b3999054678f8327ce2d979845d",
    "demand.nr": "b48f7f86c8ee80aa5fea7e6d2ea0b709d2a95f670b3473b2a1abc7a0afd5bf9e",
    "settle.nr": "cb865bea2f8087213f3d79d2eee5e07c5221cc1511d72ae6f5ee727bd690fadd",
    "request.nr": "2da922cbc425297aa09d231562de48eaf6f55fd392a1e060c523bd2ac981baee",
    "notes.nr": "034f123da4aafbac55ecaa75a3d37bbb016b70f06040a8c7092f598fbc1662d3",
    "poseidon2.nr": "44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8",
  }),
  circuits: Object.freeze({
    issue: Object.freeze({ bytecode: "0c6c904321ff16bc8fdce2298257f3cd54035bc20e53bc6e711d0be5356d211c", vk: "65cc0ada6618c79df403d8276cd6a201e36936fb6264e516a34c4bf225729da0" }),
    spend: Object.freeze({ bytecode: "47f3a125a0fcfc22cd15e482db2c75173ed70eb413f5df43b38ec00f5fa51087", vk: "850131fcd564ce15a238142051a0780623c8c759ccaffb4e389aad5a5056acba" }),
    burn: Object.freeze({ bytecode: "d36344f2b2424fa6569c01bb7d8450da98fab641251ee385914332f5437c4b72", vk: "ce55384238c5448505f7c34b938ae92152ea75c3c412c779b20aea57bf82f3be" }),
    demand: Object.freeze({ bytecode: "cab1f519db1b93cb5e2b6ec89052c5c69706990960fc3c0e617f996d843e5187", vk: "cf3912b74b1c72eef4114049f792b76462cb3cf38f19181a90dd279175b61aa4" }),
    settle: Object.freeze({ bytecode: "ccad2b665539a22c1be4692e05a87bae01ccd6756ce464fc327d8a41b7938b23", vk: "ea5b3e66ced10ded8cd72bae33c6cf4dd7d2704735713ce3b7f2f76126967654" }),
    request: Object.freeze({ bytecode: "4b1a0e76a48b651a33f19a25dcad2e45e708aabd70d757528153a2098a929084", vk: "1f048f189568b0b6ffdac39c71957aee34ed3485490d8594aba86d800e2aeaf4" }),
  }),
  parameters: BN254_PARAMETERS,
  proofBytes: 14656,
});
/** Every relation's proof length, the manifest's `proofBytes`. */
export const PROOF_BYTES = POOL_V3_MANIFEST.proofBytes;
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!, x => parseInt(x, 16));
const BOUNDS = Uint8Array.of(32, 16, 2, 4, 1);
const HELPER = hexBytes(POOL_V3_MANIFEST.sources["poseidon2.nr"]);
export const CONFIGURATION_BYTES = 439;

/** An owned copy, never over shared memory, judged by its own length. */
function bytes(value: unknown, length: number): Uint8Array {
  const own = copyUnshared(value as Uint8Array);
  if (own.length !== length) throw new EncodingError("invalid configuration bytes");
  return own;
}

export function configurationBytes(value: Configuration): Uint8Array {
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

export function decodeConfiguration(input: Uint8Array): Configuration {
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

export function configurationHash(value: Configuration): Uint8Array {
  return sha256(configurationBytes(value));
}

/**
 * §11.1: a reader's, journal's or wallet's verifier must name exactly this configuration's six relations, each by
 * its bytecode and key identity, relations a trail never uses included; otherwise every proof would be judged under
 * another key, and kept state (§14) could not name the verifier across processes. A kind the verifier names for a
 * relation must be that relation's, or identities that match by name could route a proof to another relation's
 * key. A verifier naming none is refused like a wrong one: a caller's setup error, so a TypeError, never an
 * evidence verdict. Returns the copy the caller keeps, each field read once.
 */
export function requireConfigurationVerifier(identities: VerifierIdentities | undefined): VerifierIdentities {
  const refuse = (): never => { throw new TypeError("the verifier's circuit identities are not the configuration's"); };
  if (identities === null || typeof identities !== "object" || Object.keys(identities).length !== RELATIONS.length) return refuse();
  const owned: { [name: string]: VerifierIdentities[string] } = {}, configuration = decodeConfiguration(ADOPTED);
  for (const name of RELATIONS) {
    // Each relation's own entry: one inherited from a prototype is not what the verifier declares.
    if (!Object.hasOwn(identities, name)) refuse();
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

/** Whether `input` is exactly the adopted configuration's 439 bytes, compared as an owned copy: a served preimage
 * is judged against the manifest, never read as a configuration of its own. */
export function verifyConfiguration(input: Uint8Array): boolean {
  try {
    return compareBytes(copyUnshared(input), ADOPTED) === 0;
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}

/** §11.4's configuration bytes, from the manifest's identities. */
const ADOPTED = configurationBytes({
  circuits: Object.fromEntries(RELATIONS.map(name => [name, {
    bytecode: hexBytes(POOL_V3_MANIFEST.circuits[name].bytecode), vk: hexBytes(POOL_V3_MANIFEST.circuits[name].vk),
  }])) as Configuration["circuits"],
  helper: HELPER,
});
const DOMAIN = sha256(ADOPTED);

/** §11.4's adopted configuration, a fresh copy. */
export function adoptedConfiguration(): Configuration {
  return decodeConfiguration(ADOPTED);
}

/** §11.4's 439 configuration bytes, the preimage a §12 package carries, a fresh copy. */
export function adoptedConfigurationBytes(): Uint8Array {
  return copyBytes(ADOPTED);
}

/** §11.4's configHash: the domain of every v3 statement and the hash in every v3 backing's construction clause. A fresh copy. */
export function adoptedDomain(): Uint8Array {
  return copyBytes(DOMAIN);
}
