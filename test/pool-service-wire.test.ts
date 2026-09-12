import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EncodingError } from "../src/bytes.js";
import { parsePoolServiceCommand, decodePoolServiceReply, decodePoolServiceView, POOL_SERVICE_PROFILE } from "../src/pool/service-wire.js";

// Transport parsing is Node-version independent; the SQLite-backed process
// acceptance lives in the separate Node 24 service harness.
describe("pool service wire", () => {
  it("rejects unknown fields, noncanonical values and wrong profiles", () => {
    expect(() => parsePoolServiceCommand({ version: 1, profile: POOL_SERVICE_PROFILE, kind: "publish", extra: true })).toThrow(EncodingError);
    expect(() => parsePoolServiceCommand({ version: 1, profile: POOL_SERVICE_PROFILE, kind: "commit", id: "bad id" })).toThrow(EncodingError);
    expect(() => parsePoolServiceCommand({ version: 1, profile: "other", kind: "publish" })).toThrow(EncodingError);
    expect(() => decodePoolServiceReply({ version: 1, profile: POOL_SERVICE_PROFILE, kind: "published", commitment: "00" })).toThrow(EncodingError);
  });
  it("requires explicit omitted evidence and validates summary framing", () => {
    expect(decodePoolServiceView({ version: 1, profile: POOL_SERVICE_PROFILE, highestSignedSequence: "0", evidence: "omitted" })).toMatchObject({ evidence: "omitted" });
    expect(() => decodePoolServiceView({ version: 1, profile: POOL_SERVICE_PROFILE, highestSignedSequence: "0", evidence: [] })).toThrow(EncodingError);
  });
  it("does not permit an empty statement envelope", () => {
    expect(() => parsePoolServiceCommand({ version: 1, profile: POOL_SERVICE_PROFILE, kind: "submit", statement: bytesToHex(new Uint8Array()) })).toThrow(EncodingError);
  });
});
