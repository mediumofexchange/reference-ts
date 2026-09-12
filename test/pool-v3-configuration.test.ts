import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configurationBytes, configurationHash, decodeConfiguration, verifyConfiguration, RELATIONS,
  type CandidateConfiguration } from "../model/pool-v3-configuration.js";
import { EncodingError } from "../src/bytes.js";

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
  });
});
