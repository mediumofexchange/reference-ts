import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adoptedConfiguration, adoptedConfigurationBytes, adoptedDomain, configurationBytes, configurationHash, decodeConfiguration, POOL_V3_MANIFEST,
  requireConfigurationVerifier, verifyConfiguration, RELATION_KINDS, RELATIONS, type Configuration } from "../src/pool/v3/configuration.js";
import { EncodingError } from "../src/bytes.js";
import { flipping, lookAlikes } from "./hostile-bytes.js";

const manifest = POOL_V3_MANIFEST;
const h = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"));
function fixture(): Configuration {
  return { circuits: Object.fromEntries(RELATIONS.map(name => [name, { bytecode: h(manifest.circuits[name].bytecode),
    vk: h(manifest.circuits[name].vk) }])) as Configuration["circuits"], helper: h(manifest.sources["poseidon2.nr"]) };
}
const raw = (): Buffer => Buffer.concat([Buffer.from("moe/pool/v3/config", "ascii"),
  ...(["issue", "spend", "burn", "demand", "settle", "request"] as const).flatMap(name =>
    [Buffer.from(manifest.circuits[name].bytecode, "hex"), Buffer.from(manifest.circuits[name].vk, "hex")]),
  Buffer.from(manifest.sources["poseidon2.nr"], "hex"), Buffer.from([32, 16, 2, 4, 1])]);

describe("the configuration frame, pool-v3 §11.1, and §11.4's adopted configuration", () => {
  it("is §11.4's configuration: its hash, the domain of every v3 statement, and fresh copies", () => {
    expect(Buffer.from(adoptedDomain()).toString("hex")).toBe("7ddbb7e86dbfaf5e7bbc28541be28fdef04da02b30214109420d840fe664a618");
    expect(Buffer.from(adoptedConfigurationBytes())).toEqual(raw());
    expect(adoptedConfiguration()).toEqual(fixture());
    expect(configurationHash(adoptedConfiguration())).toEqual(adoptedDomain());
    const domain = adoptedDomain(), bytes = adoptedConfigurationBytes(), configuration = adoptedConfiguration();
    domain.fill(0); bytes.fill(0); configuration.circuits.spend.vk.fill(0); configuration.helper.fill(0);
    expect(Buffer.from(adoptedDomain()).toString("hex")).toBe("7ddbb7e86dbfaf5e7bbc28541be28fdef04da02b30214109420d840fe664a618");
    expect(adoptedConfiguration()).toEqual(fixture());
    expect(Object.isFrozen(manifest) && Object.isFrozen(manifest.circuits.spend) && Object.isFrozen(manifest.parameters)).toBe(true);
  });
  it("agrees with independent ordered framing and SHA256", () => {
    const bytes = configurationBytes(fixture());
    expect(bytes.length).toBe(439);
    expect(Buffer.from(bytes)).toEqual(raw());
    expect(Buffer.from(configurationHash(fixture()))).toEqual(createHash("sha256").update(raw()).digest());
    expect(configurationBytes(decodeConfiguration(raw()))).toEqual(bytes);
    expect(verifyConfiguration(raw())).toBe(true);
  });
  it("binds every identity, including unused recovery relations and equal-count spend/burn", () => {
    // Any other well-framed configuration is not the adopted one.
    for (let i = 18; i < 18 + 384; i++) {
      const changed = raw(); changed[i] = changed[i]! ^ 1;
      expect(verifyConfiguration(changed)).toBe(false);
    }
    const changed = raw();
    raw().copy(changed, 18 + 64, 18 + 128, 18 + 192);
    raw().copy(changed, 18 + 128, 18 + 64, 18 + 128);
    expect(verifyConfiguration(changed)).toBe(false);
  });
  it("refuses every truncation, trailing data, helper/profile/bounds/context substitution", () => {
    const bytes = raw();
    for (let i = 0; i < bytes.length; i++) expect(verifyConfiguration(bytes.subarray(0, i))).toBe(false);
    expect(verifyConfiguration(Buffer.concat([bytes, Buffer.from([0])]))).toBe(false);
    for (const i of [...Array.from({ length: 18 }, (_, i) => i), ...Array.from({ length: 37 }, (_, i) => 402 + i)]) {
      const changed = raw(); changed[i] = changed[i]! ^ 1;
      expect(() => decodeConfiguration(changed)).toThrow(EncodingError);
    }
  });
  it("requires precisely six identities and typed, owned bytes", () => {
    const config = fixture();
    const missing = structuredClone(config); delete (missing.circuits as Record<string, unknown>).request;
    expect(() => configurationBytes(missing)).toThrow(EncodingError);
    const extra = { ...config, circuits: { ...config.circuits, withdrawal: config.circuits.issue } };
    expect(() => configurationBytes(extra)).toThrow(EncodingError);
    for (const value of [null, undefined, [], "bytes", {}, new Uint8Array(438)] as unknown as Uint8Array[]) {
      expect(verifyConfiguration(value)).toBe(false);
    }
    const input = raw(), decoded = decodeConfiguration(input), encoded = configurationBytes(decoded);
    input.fill(0); decoded.circuits.issue.vk.fill(0);
    expect(encoded).toEqual(configurationBytes(config));
    expect(decodeConfiguration(encoded).circuits.issue.vk).toEqual(config.circuits.issue.vk);
    const shared = new Uint8Array(new SharedArrayBuffer(439)); shared.set(raw());
    expect(verifyConfiguration(shared)).toBe(false);
    const sharedKey = new Uint8Array(new SharedArrayBuffer(32)); sharedKey.set(config.circuits.issue.vk);
    const sharedConfig = { ...config, circuits: { ...config.circuits, issue: { ...config.circuits.issue, vk: sharedKey } } };
    expect(() => configurationBytes(sharedConfig)).toThrow(EncodingError);
    // Look-alikes answer false, not a TypeError; a helper judged once is the helper written.
    for (const fake of lookAlikes(439)) expect(verifyConfiguration(fake)).toBe(false);
    expect(configurationBytes(flipping(config, "helper", config.helper, new Uint8Array(32)))).toEqual(configurationBytes(config));
  });
  it("binds a verifier that names its circuits to exactly the configuration's six identities", () => {
    const config = fixture(), own = config.circuits, refusal = new TypeError("the verifier's circuit identities are not the configuration's");
    expect(() => requireConfigurationVerifier(own)).not.toThrow();
    expect(() => requireConfigurationVerifier(structuredClone(own))).not.toThrow();
    // A verifier naming none is refused: there is no test double to compare nothing against.
    expect(() => requireConfigurationVerifier(undefined)).toThrow(refusal);
    const { request: _request, ...fewer } = own;
    for (const name of RELATIONS) for (const field of ["bytecode", "vk"] as const) {
      const changed = Uint8Array.from(own[name][field]); changed[31] = changed[31]! ^ 1;
      expect(() => requireConfigurationVerifier({ ...own, [name]: { ...own[name], [field]: changed } })).toThrow(refusal);
    }
    for (const identities of [{}, fewer, { ...own, withdrawal: own.issue }, { ...own, spend: own.burn, burn: own.spend }]) {
      expect(() => requireConfigurationVerifier(identities)).toThrow(refusal);
    }
    // Malformed identities are the same setup error, not an encoding verdict.
    for (const identities of [null, "identities", { ...own, spend: null }, { ...own, spend: { bytecode: "x", vk: own.spend.vk } },
      { ...own, spend: { vk: own.spend.vk } }, { ...own, spend: { ...own.spend, vk: Array.from(own.spend.vk) } }]) {
      expect(() => requireConfigurationVerifier(identities as unknown as typeof own)).toThrow(refusal);
    }
  });
  it("refuses a verifier whose identities match by name but route a relation's proofs to another kind's key", () => {
    const config = fixture(), refusal = new TypeError("the verifier's circuit identities are not the configuration's");
    const routed = Object.fromEntries(RELATIONS.map(name => [name, { ...config.circuits[name], kind: RELATION_KINDS[name] }]));
    expect(() => requireConfigurationVerifier(routed)).not.toThrow();
    // A table swapping spend's and burn's names (both take 15 public inputs) derives the same identities by name.
    const swapped = { ...routed, spend: { ...routed.spend!, kind: RELATION_KINDS.burn }, burn: { ...routed.burn!, kind: RELATION_KINDS.spend } };
    expect(() => requireConfigurationVerifier(swapped)).toThrow(refusal);
    // The caller keeps the copy returned: a later change to the declared object changes nothing checked.
    const declared = structuredClone(routed), owned = requireConfigurationVerifier(declared)!;
    delete declared.issue; declared.spend!.vk[0]! ^= 1;
    expect(Object.keys(owned).sort()).toEqual([...RELATIONS].sort());
    expect(owned.spend!.vk).toEqual(config.circuits.spend.vk);
  });
});

describe("the specification pin", () => {
  it("is one revision in the reader's rules, the report provenance and the README", () => {
    const text = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const pinned = /export const V3_SPECIFICATION = "([0-9a-f]{7})";/.exec(text("../scripts/pool/v3/provenance.mjs"))?.[1];
    expect(pinned).toBeDefined();
    expect(/const SPECIFICATION = "pool-v3 ([0-9a-f]{7})";/.exec(text("../src/pool/v3/reader.ts"))?.[1]).toBe(pinned);
    expect(text("../README.md")).toMatch(new RegExp(`money-from-first-principles/tree/${pinned}[0-9a-f]{33}[)]`));
  });
});
