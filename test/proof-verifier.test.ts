import type { Barretenberg } from "@aztec/bb.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { BN254_PARAMETERS, ParameterError, proofVerifier, startBackend, type CircuitTable, type ProvingParameters } from "../src/pool/proof-verifier.js";

// The table is checked before any key is derived, so no backend is needed:
// an instance that is touched at all would throw a TypeError instead.
const untouched = {} as Barretenberg;
const entry = (kind: number, name: string, publicInputs = 3) => ({ kind, name, publicInputs });

describe("a construction's circuit table (proof-verifier.ts)", () => {
  it("refuses a table that could route a kind to two keys or admit an unbounded proof", async () => {
    const tables: unknown[] = [
      null, {}, { circuits: [], maxProofBytes: 32 },
      { circuits: [entry(1, "issue"), entry(1, "spend")], maxProofBytes: 32 },
      { circuits: [entry(1, "issue"), entry(2, "issue")], maxProofBytes: 32 },
      { circuits: [entry(1, "")], maxProofBytes: 32 },
      { circuits: [entry(-1, "issue")], maxProofBytes: 32 },
      { circuits: [entry(1.5, "issue")], maxProofBytes: 32 },
      { circuits: [entry(1, "issue", -1)], maxProofBytes: 32 },
      { circuits: [entry(1, "issue")], maxProofBytes: 0 },
      { circuits: [entry(1, "issue")], maxProofBytes: 33 },
      { circuits: [entry(1, "issue")], maxProofBytes: 2 ** 60 },
      { circuits: [null], maxProofBytes: 32 },
    ];
    for (const table of tables) {
      await expect(proofVerifier(untouched, table as CircuitTable, {}, {})).rejects.toThrow(new EncodingError("invalid circuit table"));
    }
  });

  it("refuses a circuit whose artifact is missing or not canonical base64 before deriving a key", async () => {
    const table: CircuitTable = { circuits: [entry(1, "issue"), entry(2, "spend")], maxProofBytes: 32 };
    const issue = { noir_version: "x", bytecode: "AA==" };
    for (const spend of [undefined, { noir_version: "x", bytecode: "AA" }, { noir_version: "x", bytecode: 7 }]) {
      await expect(proofVerifier(untouched, table, { issue, spend } as never, {})).rejects.toThrow(new EncodingError("spend bytecode is not canonical base64"));
    }
  });

  it("refuses a backend instance startBackend did not start, before deriving a key", async () => {
    const table: CircuitTable = { circuits: [entry(1, "issue")], maxProofBytes: 32 };
    const refusal = proofVerifier(untouched, table, { issue: { noir_version: "x", bytecode: "AA==" } });
    await expect(refusal).rejects.toThrow(new ParameterError("UNCHECKED", "the backend instance was not started from checked parameters"));
    await expect(refusal).rejects.toMatchObject({ code: "UNCHECKED" });
  });
});

// Wrong bytes are refused before a backend starts, so these need no parameter
// files: G2 is checked first, and its 128 bytes are Ignition's public [x]_2.
describe("proving parameters before loading (proof-verifier.ts, pool-v3 §4)", () => {
  const X2 = "0118c4d5b837bcc2bc89b5b398b5974e9f5944073b32078b7e231fec938883b0260e01b251f6f1c7e7ff4e580791dee8ea51d87a358e038b4efe30fac09383c1" +
    "22febda3c0c0632a56475b4214e5615e11e6dd3f96e6cea2854a87d4dacc5e5504fc6369f7110fe3d25156c1bb9a72859cf2a04641f99ba4ee413c80da6a5fe4";
  const g1 = new Uint8Array(BN254_PARAMETERS.points * 64), g2 = Uint8Array.from(Buffer.from(X2, "hex"));
  const refused = async (parameters: unknown, code: "G1" | "G2", reason: string) => {
    const start = startBackend(parameters as ProvingParameters);
    await expect(start).rejects.toThrow(new ParameterError(code, `the BN254 ${code} parameters ${reason}`));
    await expect(start).rejects.toMatchObject({ code });
  };

  it("pins Ignition's leading 2^15 G1 points and [x]_2", () => {
    expect(BN254_PARAMETERS).toEqual({ points: 32768,
      g1: "50d2f4e9567be2b8e382cedfd078b96a3428a94597b7e88c4116e105d578ce77",
      g2: "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f" });
  });

  it("refuses G1 or G2 bytes of another length or hash, or that are not bytes", async () => {
    expect(bytesToHex(sha256(g2))).toBe(BN254_PARAMETERS.g2);
    await expect(startBackend(null as never)).rejects.toThrow(new ParameterError("G2", "no BN254 parameters"));
    const flipped = g2.slice(); flipped[127]! ^= 1;
    await refused({ g1, g2: flipped }, "G2", "are not the manifest's");
    await refused({ g1, g2: g2.subarray(0, 64) }, "G2", "are not the manifest's");
    await refused({ g1, g2: Uint8Array.from([...g2, 0]) }, "G2", "are not the manifest's");
    await refused({ g1 }, "G2", "are not bytes");
    await refused({ g1, g2: X2 }, "G2", "are not bytes");
    await refused({ g1, g2 }, "G1", "are not the manifest's");
    await refused({ g1: g1.subarray(64), g2 }, "G1", "are not the manifest's");
    await refused({ g1: "00".repeat(g1.length), g2 }, "G1", "are not bytes");
    await refused({ g1: new Uint8Array(new SharedArrayBuffer(g1.length)), g2 }, "G1", "are not bytes");
  });
});
