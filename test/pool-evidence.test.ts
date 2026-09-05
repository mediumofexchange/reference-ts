import { describe, expect, it } from "vitest";
import { decodeBacking, encodeBacking, makeBacking, POOL_CONSTRUCTION, signBacking } from "../src/backing.js";
import { EncodingError } from "../src/bytes.js";
import { utf8Encoder } from "../src/contexts.js";
import { LedgerError, TransparentLedger } from "../src/ledger.js";
import { Sequencer, SequencerError } from "../src/sequencer.js";
import { LocalVenue } from "../src/venue.js";
import { CONFIG_HASH, makePoolBacking } from "./pool-support.js";
import { KEYS, makeTransparentBacking, pub, SECRETS } from "./support.js";

// Construction §C1.3 and pool-v1 §2: E names the construction and a
// configuration hash, inside the backing's name. In canonical encoding v1
// that is evidence clause 0x05; without it the backing is served under the
// transparent profile.

describe("E names the construction and its configuration (C1.3)", () => {
  it("encodes the construction clause after the other clauses and decodes to the same backing", () => {
    const backing = makePoolBacking(SECRETS.backer);
    expect(backing.evidence.setting).toBe("pool");
    const bytes = encodeBacking(backing);
    const clause = Buffer.concat([
      new Uint8Array([0x05]), new Uint8Array([0, 0, 0, 11]), utf8Encoder.encode(POOL_CONSTRUCTION), CONFIG_HASH,
    ]);
    // Evidence tag 0x05 (clauses), the operator, one clause, then the construction clause.
    const tail = Buffer.concat([new Uint8Array([0x05]), KEYS.operator, new Uint8Array([0, 0, 0, 1]), clause]);
    expect(bytes.subarray(bytes.length - tail.length)).toEqual(new Uint8Array(tail));
    const decoded = decodeBacking(bytes);
    expect(decoded.name).toEqual(backing.name);
    expect(decoded.evidence).toEqual(backing.evidence);
    expect(encodeBacking(decoded)).toEqual(bytes);
  });

  it("sorts the construction clause among the others and round-trips with them", () => {
    const backing = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: {
        setting: "pool",
        operator: KEYS.operator,
        construction: "moe/pool/v1",
        configuration: CONFIG_HASH,
        silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
        witnessing: { venue: new Uint8Array(32).fill(7), interval: 2n },
        replacementRule: KEYS.backer,
        nonService: { duration: 3n, count: 4n, window: 9n },
      },
    });
    const decoded = decodeBacking(encodeBacking(backing));
    expect(decoded.evidence).toEqual(backing.evidence);
    expect(decoded.name).toEqual(backing.name);
  });

  it("gives a pool backing a different name from the transparent backing with the same other terms", () => {
    const pool = makePoolBacking(SECRETS.backer);
    const transparent = makeTransparentBacking(SECRETS.backer);
    expect(pool.name).not.toEqual(transparent.name);
    // And a different configuration is a different backing (§C1.3: a successor).
    expect(makePoolBacking(SECRETS.backer, "EUR", new Uint8Array(32).fill(1)).name).not.toEqual(pool.name);
  });

  it("refuses a construction it cannot check, in the object and in the bytes", () => {
    const fields = {
      obligor: KEYS.backer,
      payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
      reliance: [],
    };
    expect(() => makeBacking({ ...fields, evidence: { setting: "pool", operator: KEYS.operator, construction: "moe/pool/v2" as "moe/pool/v1", configuration: CONFIG_HASH } })).toThrow(EncodingError);
    expect(() => makeBacking({ ...fields, evidence: { setting: "pool", operator: KEYS.operator, construction: "moe/pool/v1", configuration: new Uint8Array(31) } })).toThrow(EncodingError);
    expect(() => makeBacking({ ...fields, evidence: { setting: "shielded" as "pool", operator: KEYS.operator, construction: "moe/pool/v1", configuration: CONFIG_HASH } })).toThrow(EncodingError);
    const bytes = encodeBacking(makePoolBacking(SECRETS.backer));
    const text = Buffer.from(bytes).toString("latin1");
    const at = text.lastIndexOf(POOL_CONSTRUCTION);
    const v2 = new Uint8Array(bytes);
    v2.set(utf8Encoder.encode("moe/pool/v2"), at);
    expect(() => decodeBacking(v2)).toThrow(EncodingError);
    const invalidUtf8 = new Uint8Array(bytes);
    invalidUtf8[at] = 0xff;
    expect(() => decodeBacking(invalidUtf8)).toThrow(EncodingError);
    const truncated = bytes.subarray(0, bytes.length - 1);
    expect(() => decodeBacking(truncated)).toThrow(EncodingError);
  });

  it("is refused by the transparent profile's ledger and sequencer", () => {
    const backing = makePoolBacking(SECRETS.backer);
    const signature = signBacking(SECRETS.backer, backing);
    expect(() => new TransparentLedger().register(backing, signature)).toThrow(LedgerError);
    const sequencer = new Sequencer(SECRETS.operator, new LocalVenue());
    expect(() => sequencer.register(backing, signature)).toThrow(LedgerError);
    expect(SequencerError).toBeDefined();
    // The transparent backing with the same obligor still registers, so the guard is the construction's.
    const transparent = makeTransparentBacking(SECRETS.backer);
    expect(() => new TransparentLedger().register(transparent, signBacking(SECRETS.backer, transparent))).not.toThrow();
    expect(pub(SECRETS.backer)).toEqual(backing.obligor);
  });
});
