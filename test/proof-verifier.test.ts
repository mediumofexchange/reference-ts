import type { Barretenberg } from "@aztec/bb.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { proofVerifier, type CircuitTable } from "../src/pool/proof-verifier.js";

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
    const table: CircuitTable = { circuits: [entry(1, "issue")], maxProofBytes: 32 };
    for (const programs of [{}, { issue: { noir_version: "x", bytecode: "AA" } }, { issue: { noir_version: "x", bytecode: 7 } }]) {
      await expect(proofVerifier(untouched, table, programs as never, {})).rejects.toThrow(new EncodingError("issue bytecode is not canonical base64"));
    }
  });
});
