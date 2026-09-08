import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ProofOracle } from "./pool-authority.js";
import type { Lit, Statement } from "./pool-authority.js";
import { copyEvidence, evidenceChain, evidenceEqual, evidenceHashes, statementDigest } from "./pool-evidence.js";

const statement: Statement = {
  id: "statement1", segment: "segment1", scope: "scope1", domain: "D", kind: "settle",
  anchors: ["root1", "root2"], nullifiers: ["nf1", "nf2"], outputs: ["cm3"],
  lit: { backing: "B", quantity: 7n, tags: ["tag1", "tag2"], presenter: "P", instant: 1n,
    deadline: 9n, demand: "demand1", owner: "K", tag: "tag1",
    acceptance: { demand: "demand1", owner: "K", deadline: 8n, signedByK: true } },
};
const evidence = copyEvidence({ proof: "0011", signature: "aabb" });
const event = { statement, evidence };
const hash = () => evidenceChain("segment1", [event]);

describe("C2.10.10 model evidence chain", () => {
  it("hashes decoded exact evidence bytes, including an absent signature", () => {
    expect(evidenceHashes({ proof: "00", signature: "" })).toEqual({
      proofHash: bytesToHex(sha256(new Uint8Array([0]))),
      signatureHash: "00".repeat(32),
    });
    expect(evidenceEqual(evidence, { ...evidence })).toBe(true);
    expect(evidenceEqual(evidence, { ...evidence, proof: "0022" })).toBe(false);
    expect(evidenceEqual(evidence, { ...evidence, signature: "aabc" })).toBe(false);
  });

  it("binds the empty segment and every nonempty chain to its context", () => {
    const empty = evidenceChain("segment1", []);
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(empty).toBe(evidenceChain("segment1", []));
    expect(empty).not.toBe(evidenceChain("segment2", []));
    expect(empty).not.toBe(hash());
    expect(hash()).not.toBe(evidenceChain("segment2", [event]));
  });

  it("binds order, length and interior evidence with the same final event", () => {
    const second = { statement: { ...statement, id: "statement2" }, evidence };
    const third = { statement: { ...statement, id: "statement3" }, evidence };
    const original = evidenceChain("segment1", [event, second, third]);
    expect(original).not.toBe(evidenceChain("segment1", [second, event, third]));
    expect(original).not.toBe(evidenceChain("segment1", [event, third]));
    expect(original).not.toBe(evidenceChain("segment1", [event, { ...second, evidence: { ...evidence, proof: "0022" } }, third]));
    expect(original).not.toBe(evidenceChain("segment1", [event, { ...second, evidence: { ...evidence, signature: "aabc" } }, third]));
    expect(original).not.toBe(evidenceChain("segment1", [event, { ...second, statement: { ...second.statement, scope: "other" } }, third]));
  });

  it("refuses absent or malformed evidence instead of inventing committed bytes", () => {
    expect(() => evidenceChain("segment1", [{ statement }])).toThrow("missing admitted evidence");
    for (const malformed of ["0", "AA", "0x00", "gg", "00 ", "\n00", "00\n"]) {
      for (const field of ["proof", "signature"] as const) {
        const bad = { ...evidence, [field]: malformed };
        expect(() => copyEvidence(bad)).toThrow("noncanonical evidence hex");
        expect(() => evidenceHashes(bad)).toThrow("noncanonical evidence hex");
        expect(() => evidenceChain("segment1", [{ statement, evidence: bad }])).toThrow("noncanonical evidence hex");
      }
    }
  });

  it("retains immutable copies even when callers replace their input strings", () => {
    const input = { proof: "0011", signature: "aabb" };
    const retained = copyEvidence(input);
    const before = evidenceChain("segment1", [{ statement, evidence: retained }]);
    input.proof = "ffee"; input.signature = "";
    expect(retained).toEqual(evidence);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Reflect.set(retained, "proof", "ffff")).toBe(false);
    expect(evidenceChain("segment1", [{ statement, evidence: retained }])).toBe(before);
  });

  it("preserves statement identity across proof and signature variants", () => {
    const oracle = new ProofOracle();
    const binding = { id: "segment1", scope: { domain: "D", operator: "O", root: "scope1", entries: [] } };
    const note = oracle.note("B", 7n);
    const first = oracle.prove(binding, "issue", [], [note], [], { backing: "B", quantity: 7n });
    const again = oracle.prove(binding, "issue", [], [note], [], { backing: "B", quantity: 7n });
    expect(first.id).toBe(again.id);
    expect(statementDigest(first)).toBe(statementDigest(again));
    const original = evidenceChain(binding.id, [{ statement: first, evidence }]);
    expect(original).not.toBe(evidenceChain(binding.id, [{ statement: again, evidence: { ...evidence, proof: "0022" } }]));
    expect(original).not.toBe(evidenceChain(binding.id, [{ statement: again, evidence: { ...evidence, signature: "aabc" } }]));
  });
});

describe("model public statement framing", () => {
  const variants: readonly [string, Partial<Statement>][] = [
    ["id", { id: "other" }], ["kind", { kind: "spend" }], ["domain", { domain: "other" }],
    ["segment", { segment: "other" }], ["scope", { scope: "other" }],
    ["anchors", { anchors: ["root2", "root1"] }], ["nullifiers", { nullifiers: ["nf2", "nf1"] }],
    ["outputs", { outputs: ["other"] }], ["lit absence", { lit: undefined } as unknown as Partial<Statement>],
  ];
  it.each(variants)("binds %s even when the ideal id is reused", (_field, patch) => {
    expect(statementDigest({ ...statement, ...patch })).not.toBe(statementDigest(statement));
  });

  const litVariants: readonly [string, Partial<Lit>][] = [
    ["backing", { backing: "other" }], ["quantity", { quantity: 8n }], ["tags", { tags: ["tag2", "tag1"] }],
    ["presenter", { presenter: "other" }], ["instant", { instant: 2n }], ["deadline", { deadline: 10n }],
    ["demand", { demand: "other" }], ["owner", { owner: "other" }], ["tag", { tag: "other" }],
    ["acceptance demand", { acceptance: { ...statement.lit!.acceptance!, demand: "other" } }],
    ["acceptance owner", { acceptance: { ...statement.lit!.acceptance!, owner: "other" } }],
    ["acceptance deadline", { acceptance: { ...statement.lit!.acceptance!, deadline: 7n } }],
    ["acceptance signer", { acceptance: { ...statement.lit!.acceptance!, signedByK: false } }],
  ];
  it.each(litVariants)("binds lit %s", (_field, patch) => {
    expect(statementDigest({ ...statement, lit: { ...statement.lit!, ...patch } })).not.toBe(statementDigest(statement));
  });

  it("distinguishes absent optional fields from present empty or zero values", () => {
    const lit = { backing: "B", quantity: 7n };
    const original = statementDigest({ ...statement, lit });
    for (const patch of [{ tags: [] }, { presenter: "" }, { instant: 0n }, { deadline: 0n },
      { demand: "" }, { owner: "" }, { tag: "" }, { acceptance: { demand: "", owner: "", deadline: 0n, signedByK: false } }]) {
      expect(statementDigest({ ...statement, lit: { ...lit, ...patch } })).not.toBe(original);
    }
  });

  it("frames adjacent strings, arrays and signed bigint public values", () => {
    expect(statementDigest({ ...statement, segment: "ab", scope: "c" }))
      .not.toBe(statementDigest({ ...statement, segment: "a", scope: "bc" }));
    expect(statementDigest({ ...statement, anchors: ["ab", "c"] }))
      .not.toBe(statementDigest({ ...statement, anchors: ["a", "bc"] }));
    expect(statementDigest({ ...statement, lit: { backing: "B", quantity: -7n } }))
      .not.toBe(statementDigest({ ...statement, lit: { backing: "B", quantity: 7n } }));
    expect(statementDigest({ ...statement, lit: { backing: "B", quantity: 1n << 100n } })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects surrogate aliases and non-bigint quantities at encoding boundaries", () => {
    expect(() => statementDigest({ ...statement, domain: "\ud800" })).toThrow("noncanonical model text");
    expect(() => evidenceChain("\ud800", [])).toThrow("noncanonical model text");
    expect(() => statementDigest({ ...statement, lit: { backing: "B", quantity: 7 as unknown as bigint } }))
      .toThrow("non-bigint model quantity");
  });
});
