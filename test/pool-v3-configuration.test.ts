import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configurationBytes, configurationHash, decodeConfiguration, requireConfigurationVerifier, verifyConfiguration, RELATION_KINDS, RELATIONS,
  type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { EncodingError } from "../src/bytes.js";
import { flipping, lookAlikes } from "./hostile-bytes.js";

const manifest = JSON.parse(readFileSync(new URL("../scripts/pool/v3/candidate-manifest.json", import.meta.url), "utf8"));
const h = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "hex"));
function fixture(): CandidateConfiguration {
  return { circuits: Object.fromEntries(RELATIONS.map(name => [name, { bytecode: h(manifest.circuits[name].bytecode),
    vk: h(manifest.circuits[name].vk) }])) as CandidateConfiguration["circuits"], helper: h(manifest.sources["poseidon2.nr"]) };
}
const raw = (): Buffer => Buffer.concat([Buffer.from("moe/pool/v3/config", "ascii"),
  ...["issue", "spend", "burn", "demand", "settle", "request"].flatMap(name =>
    [Buffer.from(manifest.circuits[name].bytecode, "hex"), Buffer.from(manifest.circuits[name].vk, "hex")]),
  Buffer.from(manifest.sources["poseidon2.nr"], "hex"), Buffer.from([32, 16, 2, 4, 1])]);

describe("candidate configuration, pool-v3 §11.1; no adoption", () => {
  it("agrees with independent ordered framing and SHA256", () => {
    const bytes = configurationBytes(fixture());
    expect(bytes.length).toBe(439);
    expect(Buffer.from(bytes)).toEqual(raw());
    expect(Buffer.from(configurationHash(fixture()))).toEqual(createHash("sha256").update(raw()).digest());
    expect(configurationBytes(decodeConfiguration(raw()))).toEqual(bytes);
    expect(verifyConfiguration(raw(), fixture())).toBe(true);
  });
  it("binds every identity, including unused recovery relations and equal-count spend/burn", () => {
    for (let i = 18; i < 18 + 384; i++) {
      const changed = raw(); changed[i] = changed[i]! ^ 1;
      expect(verifyConfiguration(changed, fixture())).toBe(false);
    }
    const changed = raw();
    raw().copy(changed, 18 + 64, 18 + 128, 18 + 192);
    raw().copy(changed, 18 + 128, 18 + 64, 18 + 128);
    expect(verifyConfiguration(changed, fixture())).toBe(false);
  });
  it("refuses every truncation, trailing data, helper/profile/bounds/context substitution", () => {
    const bytes = raw();
    for (let i = 0; i < bytes.length; i++) expect(verifyConfiguration(bytes.subarray(0, i), fixture())).toBe(false);
    expect(verifyConfiguration(Buffer.concat([bytes, Buffer.from([0])]), fixture())).toBe(false);
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
      expect(verifyConfiguration(value, config)).toBe(false);
    }
    const input = raw(), decoded = decodeConfiguration(input), encoded = configurationBytes(decoded);
    input.fill(0); decoded.circuits.issue.vk.fill(0);
    expect(encoded).toEqual(configurationBytes(config));
    expect(decodeConfiguration(encoded).circuits.issue.vk).toEqual(config.circuits.issue.vk);
    const shared = new Uint8Array(new SharedArrayBuffer(439)); shared.set(raw());
    expect(verifyConfiguration(shared, config)).toBe(false);
    const sharedKey = new Uint8Array(new SharedArrayBuffer(32)); sharedKey.set(config.circuits.issue.vk);
    const sharedConfig = { ...config, circuits: { ...config.circuits, issue: { ...config.circuits.issue, vk: sharedKey } } };
    expect(() => configurationBytes(sharedConfig)).toThrow(EncodingError);
    // Look-alikes answer false, not a TypeError; a helper judged once is the helper written.
    for (const fake of lookAlikes(439)) expect(verifyConfiguration(fake, config)).toBe(false);
    expect(configurationBytes(flipping(config, "helper", config.helper, new Uint8Array(32)))).toEqual(configurationBytes(config));
  });
  it("binds a verifier that names its circuits to exactly the configuration's six identities", () => {
    const config = fixture(), own = config.circuits, refusal = new TypeError("the verifier's circuit identities are not the configuration's");
    expect(() => requireConfigurationVerifier(config, own)).not.toThrow();
    expect(() => requireConfigurationVerifier(config, structuredClone(own))).not.toThrow();
    // A verifier naming none is a test double: nothing to compare.
    expect(() => requireConfigurationVerifier(config, undefined)).not.toThrow();
    const { request: _request, ...fewer } = own;
    for (const name of RELATIONS) for (const field of ["bytecode", "vk"] as const) {
      const changed = Uint8Array.from(own[name][field]); changed[31] = changed[31]! ^ 1;
      expect(() => requireConfigurationVerifier(config, { ...own, [name]: { ...own[name], [field]: changed } })).toThrow(refusal);
    }
    for (const identities of [{}, fewer, { ...own, withdrawal: own.issue }, { ...own, spend: own.burn, burn: own.spend }]) {
      expect(() => requireConfigurationVerifier(config, identities)).toThrow(refusal);
    }
    // Malformed identities are the same setup error, not an encoding verdict.
    for (const identities of [null, "identities", { ...own, spend: null }, { ...own, spend: { bytecode: "x", vk: own.spend.vk } },
      { ...own, spend: { vk: own.spend.vk } }, { ...own, spend: { ...own.spend, vk: Array.from(own.spend.vk) } }]) {
      expect(() => requireConfigurationVerifier(config, identities as unknown as typeof own)).toThrow(refusal);
    }
  });
  it("refuses a verifier whose identities match by name but route a relation's proofs to another kind's key", () => {
    const config = fixture(), refusal = new TypeError("the verifier's circuit identities are not the configuration's");
    const routed = Object.fromEntries(RELATIONS.map(name => [name, { ...config.circuits[name], kind: RELATION_KINDS[name] }]));
    expect(() => requireConfigurationVerifier(config, routed)).not.toThrow();
    // A table swapping spend's and burn's names (both take 15 public inputs) derives the same identities by name.
    const swapped = { ...routed, spend: { ...routed.spend!, kind: RELATION_KINDS.burn }, burn: { ...routed.burn!, kind: RELATION_KINDS.spend } };
    expect(() => requireConfigurationVerifier(config, swapped)).toThrow(refusal);
    // The caller keeps the copy returned: a later change to the declared object changes nothing checked.
    const declared = structuredClone(routed), owned = requireConfigurationVerifier(config, declared)!;
    delete declared.issue; declared.spend!.vk[0]! ^= 1;
    expect(Object.keys(owned).sort()).toEqual([...RELATIONS].sort());
    expect(owned.spend!.vk).toEqual(config.circuits.spend.vk);
  });
});

describe("the specification pin", () => {
  it("is one revision in the reader's rules, the report provenance, the candidate manifest and the README", () => {
    const text = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const pinned = /export const V3_SPECIFICATION = "([0-9a-f]{7})";/.exec(text("../scripts/pool/v3/provenance.mjs"))?.[1];
    expect(pinned).toBeDefined();
    expect(/const SPECIFICATION = "pool-v3 ([0-9a-f]{7})";/.exec(text("../src/pool/v3/reader.ts"))?.[1]).toBe(pinned);
    expect(manifest.specification).toBe(pinned);
    expect(text("../README.md")).toMatch(new RegExp(`money-from-first-principles/tree/${pinned}[0-9a-f]{33}[)]`));
  });
});
