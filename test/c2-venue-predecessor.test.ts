import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { makeBacking } from "../src/backing.js";
import { encodeCommitment, signCommitment, type Commitment } from "../src/commitment.js";
import { commitmentRegisters, ErgoVenue, type ErgoAddressing, type ErgoNode } from "../src/ergo.js";
import { localViewFromWire, PILOT_PROFILE } from "../src/pilot-wire.js";
import { answering, LocalVenue, VenueError, type Venue } from "../src/venue.js";
import { LaggingView } from "./lagging-view.js";
import { KEYS, SECRETS } from "./support.js";

const MAX = (1n << 64n) - 1n;
const SPARSE = (1n << 53n) + 7n;
const records = [
  { at: 0n, commitment: signCommitment(SECRETS.operator, 0n, new Uint8Array(32).fill(1)) },
  { at: 3n, commitment: signCommitment(SECRETS.operator, 5n, new Uint8Array(32).fill(2)) },
  { at: 3n, commitment: signCommitment(SECRETS.operator, SPARSE, new Uint8Array(32).fill(3)) },
  { at: 8n, commitment: signCommitment(SECRETS.operator, MAX, new Uint8Array(32).fill(4)) },
];
const other = signCommitment(SECRETS.alice, 2n, new Uint8Array(32).fill(5));
const addressing: ErgoAddressing = {
  commitments: operator => `commit:${bytesToHex(operator)}`,
  publications: name => `publish:${bytesToHex(name)}`,
  revocations: key => `revoke:${bytesToHex(key)}`,
};
function terms(venue: Venue, operator = KEYS.operator) {
  return makeBacking({ obligor: KEYS.backer, payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
    reliance: [], evidence: { setting: "transparent", operator, witnessing: { venue: venue.id, interval: 5n } } });
}
function nodeFor(entries: readonly { at: bigint; commitment: Commitment }[], height = 12n): ErgoNode {
  return {
    indexedHeight: async () => height,
    boxesByAddress: async address => entries.filter(r => addressing.commitments(r.commitment.operator) === address)
      .map(r => ({ inclusionHeight: r.at, registers: commitmentRegisters(r.commitment) })),
  };
}
function ergo() { return new ErgoVenue("ergo-testnet", 3n, "predecessor-test", addressing); }
async function fixture(kind: "local" | "ergo" | "lagging"): Promise<Venue> {
  const entries = [...records, { at: 3n, commitment: other }].sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  if (kind === "ergo") {
    const venue = ergo();
    await venue.sync(nodeFor(entries), [terms(venue), terms(venue, KEYS.alice), terms(venue, KEYS.backer)]);
    return venue;
  }
  const chain = new LocalVenue();
  for (const r of entries) {
    if (r.at > chain.witnessedIndex()) chain.advance(r.at - chain.witnessedIndex());
    chain.publish(r.commitment);
  }
  chain.advance((kind === "lagging" ? 12n : 9n) - chain.witnessedIndex());
  return kind === "lagging" ? new LaggingView(chain, 3n) : chain;
}

describe.each(["local", "ergo", "lagging"] as const)("C2.7.2 bounded held-record descent: %s", kind => {
  it("matches record selection across inclusive indices and exclusive sparse sequence bounds", async () => {
    const venue = await fixture(kind);
    for (const asOf of [undefined, -1n, 0n, 2n, 3n, 7n, 8n, 9n, 100n]) {
      for (const bound of [0n, 1n, 5n, 6n, SPARSE, SPARSE + 1n, MAX, MAX + 1n]) {
        const expected = records.filter(r => r.at <= (asOf ?? 9n) && r.commitment.sequence < bound).at(-1);
        expect(venue.previousFor(KEYS.operator, bound, asOf)).toEqual(expected?.commitment);
      }
    }
  });

  it("visits every held predecessor, including the same index, without probing sequence holes", async () => {
    const venue = await fixture(kind), seen: bigint[] = [];
    let current = venue.latestFor(KEYS.operator);
    while (current !== undefined) {
      seen.push(current.sequence);
      current = venue.previousFor(KEYS.operator, current.sequence);
      expect(seen.length).toBeLessThanOrEqual(records.length);
    }
    expect(seen).toEqual([MAX, SPARSE, 5n, 0n]);
    // Decrementing the witnessed index instead would skip the held sequence 5.
    expect(venue.previousFor(KEYS.operator, SPARSE, 3n)?.sequence).toBe(5n);
    expect(venue.latestFor(KEYS.operator, 2n)?.sequence).toBe(0n);
  });

  it("keeps operator histories separate, including a known empty history", async () => {
    const venue = await fixture(kind);
    expect(venue.previousFor(KEYS.alice, MAX)).toEqual(other);
    expect(venue.previousFor(KEYS.backer, MAX)).toBeUndefined();
  });

  it("returns independent commitment bytes and preserves the exact-sequence answer", async () => {
    const venue = await fixture(kind);
    const read = venue.previousFor(KEYS.operator, SPARSE)!;
    read.root.fill(0); read.operator.fill(0); read.signature.fill(0);
    expect(venue.previousFor(KEYS.operator, SPARSE)).toEqual(records[1]!.commitment);
    for (const record of records) expect(venue.witnessedAtSequence(KEYS.operator, record.commitment.sequence)).toBe(record.at);
    for (const hole of [-1n, 1n, 6n, SPARSE - 1n, MAX - 1n, MAX + 1n]) {
      expect(venue.witnessedAtSequence(KEYS.operator, hole)).toBeUndefined();
    }
  });
});

it("Ergo predecessor selection uses only held, verified, finalized records", async () => {
  const venue = ergo();
  const signed = (sequence: bigint) => signCommitment(SECRETS.operator, sequence, new Uint8Array(32).fill(6));
  const invalid = signed(4n); invalid.signature.fill(0);
  await venue.sync(nodeFor([
    { at: 3n, commitment: signed(5n) },
    { at: 5n, commitment: signed(2n) }, // authentic, but not an extension
    { at: 1n, commitment: signed(0n) }, // node replies need not be sorted
    { at: 2n, commitment: invalid },
    { at: 10n, commitment: signed(6n) }, // above finalized height 9
  ]), [terms(venue)]);
  expect(venue.previousFor(KEYS.operator, 7n, 100n)?.sequence).toBe(5n);
  expect(venue.previousFor(KEYS.operator, 5n)?.sequence).toBe(0n);
  expect(venue.witnessedAtSequence(KEYS.operator, 2n)).toBeUndefined();
  expect(venue.witnessedAtSequence(KEYS.operator, 4n)).toBeUndefined();
  expect(venue.witnessedAtSequence(KEYS.operator, 6n)).toBeUndefined();
});

it("a lagging predecessor read cannot expose an unwitnessed record even with a future index bound", () => {
  const chain = new LocalVenue();
  chain.advance(3n); chain.publish(records[0]!.commitment);
  chain.advance(1n); chain.publish(records[1]!.commitment);
  chain.advance(2n);
  const view = new LaggingView(chain, 3n);
  expect(view.previousFor(KEYS.operator, SPARSE, 100n)).toEqual(records[0]!.commitment);
});

it("unavailable Ergo reads remain VenueError even for an empty sequence range", async () => {
  const venue = ergo();
  const read = () => answering(() => venue.previousFor(KEYS.operator, 0n), undefined);
  expect(read).toThrow(VenueError);
  await venue.sync(nodeFor([]), [terms(venue)]);
  expect(read()).toBeUndefined();
  expect(() => venue.previousFor(KEYS.alice, MAX)).toThrow(VenueError);
  await expect(venue.sync({ indexedHeight: async () => { throw new Error("offline"); },
    boxesByAddress: async () => [] }, [terms(venue)])).rejects.toThrow();
  // Failure before replacing the snapshot preserves its coherent old answer.
  expect(read()).toBeUndefined();
  await expect(venue.sync({ indexedHeight: async () => 12n,
    boxesByAddress: async () => { throw new Error("offline"); } }, [terms(venue)])).rejects.toThrow();
  expect(read).toThrow(VenueError);
});

it("the captured pilot view exposes the bounded read and independent outputs", () => {
  const id = new LocalVenue().id;
  const view = localViewFromWire({ profile: PILOT_PROFILE, operator: bytesToHex(KEYS.operator),
    venue: bytesToHex(id), index: "4", commitments: [
      { at: "1", bytes: bytesToHex(encodeCommitment(records[0]!.commitment)) },
      { at: "4", bytes: bytesToHex(encodeCommitment(records[1]!.commitment)) },
    ] }, KEYS.operator, id);
  expect(view.previousFor(KEYS.operator, 5n)).toEqual(records[0]!.commitment);
  view.previousFor(KEYS.operator, 5n)!.root.fill(0);
  expect(view.previousFor(KEYS.operator, 5n, 0n)).toBeUndefined();
  expect(view.previousFor(KEYS.operator, 5n)).toEqual(records[0]!.commitment);
});

it("Ergo refuses predecessor reads from a partially fetched multi-operator refresh", async () => {
  const venue = ergo(), backings = [terms(venue), terms(venue, KEYS.alice)];
  const base = nodeFor(records);
  await venue.sync(base, backings);
  let entered!: () => void, rejectFetch!: (error: Error) => void;
  const fetchingAlice = new Promise<void>(resolve => { entered = resolve; });
  const unavailable = new Promise<never>((_, reject) => { rejectFetch = reject; });
  const refresh = venue.sync({ ...base, boxesByAddress: async address => {
    if (address === addressing.commitments(KEYS.alice)) { entered(); return unavailable; }
    return base.boxesByAddress(address);
  } }, backings);
  // Attach the rejection handler before releasing the failed fetch.
  const failed = expect(refresh).rejects.toThrow("offline");
  await fetchingAlice;
  for (const bound of [0n, MAX]) expect(() => venue.previousFor(KEYS.operator, bound)).toThrow(VenueError);
  rejectFetch(new Error("offline"));
  await failed;
  for (const bound of [0n, MAX]) expect(() => venue.previousFor(KEYS.operator, bound)).toThrow(VenueError);
  await venue.sync(base, backings);
  expect(venue.previousFor(KEYS.operator, MAX)).toEqual(records[2]!.commitment);
});
