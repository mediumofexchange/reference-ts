import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { limbsOf } from "../src/pool/field.js";
import { EMPTY_NOTE_ROOT } from "../src/pool/note-tree.js";
import { deliveryHash, encodeRecord, statementBytes, type Record } from "../src/pool/v3/records.js";
import { readRecordView, RANGE_LIMITS, type ReaderSelection } from "../src/pool/v3/reader.js";
import { EvidenceRefusal, ReplayRefusal } from "../src/pool/v3/refusals.js";
import { applyRecord, modeAt, openSegmentState, type ProofCheck, type SegmentReplay, type SegmentState } from "../src/pool/v3/state.js";
import type { RootTerms } from "../src/pool/v3/terms.js";
import { RangeLimitError } from "../src/record-range.js";
import { FixtureVenue, type RecordVenue } from "../src/record-venue.js";
import { VenueError } from "../src/venue-error.js";

// The v3 state machine (src/pool/v3/state.ts) over synthetic §5 records: the
// codec's shapes with real issuer signatures, and a proof verifier the test
// chooses. Real proofs, trails, snapshots and the checkpoint classification
// run in the replay harness (npm run check:pool:ergo-replay), which reads
// through this module.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const DOMAIN = b(1), SEGMENT = b(2), BACKING = b(3), OTHER = b(4), SCOPE = 77n;
const issuerSecret = b(15), issuer = ed25519.getPublicKey(issuerSecret);
const terms = { obligor: issuer, operator: b(16) } as unknown as RootTerms;
const capsule = (n: number): Uint8Array => Uint8Array.of(1, ...new Uint8Array(88).fill(n));
const prefix = (domain = DOMAIN, segment = SEGMENT, scope = SCOPE): bigint[] => [...limbsOf(domain), ...limbsOf(segment), scope];

function record(kind: 1 | 2 | 3, inputs: bigint[], outputs: bigint[], options: { domain?: Uint8Array; segment?: Uint8Array; scope?: bigint; signer?: Uint8Array } = {}): Uint8Array {
  const domain = options.domain ?? DOMAIN, capsules = outputs.map((_, i) => capsule(i + 1));
  const publicInputs = [...prefix(domain, options.segment, options.scope), ...inputs, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))];
  const statement: Record = { domain, kind, publicInputs, proof: new Uint8Array(32).fill(kind), authorization: new Uint8Array(kind === 1 ? 64 : 0), capsules };
  const authorization = kind === 1 ? ed25519.sign(statementBytes(statement), options.signer ?? issuerSecret) : statement.authorization;
  return encodeRecord({ ...statement, authorization });
}
const issue = (quantity: bigint, cm: bigint, options?: Parameters<typeof record>[3], backing = BACKING): Uint8Array =>
  record(1, [...limbsOf(backing), quantity], [cm], options);
const spend = (anchors: [bigint, bigint], nullifiers: [bigint, bigint], outputs: bigint[], options?: Parameters<typeof record>[3]): Uint8Array =>
  record(2, [...anchors, ...nullifiers], outputs, options);
const burn = (quantity: bigint, anchors: [bigint, bigint], nullifiers: [bigint, bigint], change: bigint): Uint8Array =>
  record(3, [...limbsOf(BACKING), quantity, ...anchors, ...nullifiers], [change]);

const accepting: ProofCheck = { verify: () => true };
const fresh = (): SegmentState => openSegmentState(SEGMENT, undefined, undefined, undefined, () => {});
const replay = (overrides: Partial<SegmentReplay> = {}): SegmentReplay =>
  ({ domain: DOMAIN, backing: BACKING, segment: SEGMENT, scope: SCOPE, terms, verifier: accepting, index: 5n, block: [], ...overrides });
async function refusal(state: SegmentState, bytes: Uint8Array, context: SegmentReplay): Promise<string> {
  const before = { position: state.position, size: state.tree.size, history: Buffer.from(state.history).toString("hex") };
  const error = await applyRecord(state, bytes, context).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ReplayRefusal);
  // A refused record leaves the pre-state as every guard read it.
  expect({ position: state.position, size: state.tree.size, history: Buffer.from(state.history).toString("hex") }).toEqual(before);
  return (error as ReplayRefusal).check;
}

describe("the v3 state machine in replay mode", () => {
  it("issues, pays with change and burns, moving the forest, spent set, totals and both hash chains", async () => {
    const state = fresh(), context = replay();
    await applyRecord(state, issue(10n, 101n), context);
    const afterIssue = state.tree.root();
    expect([state.position, state.tree.size, state.totals.get(Buffer.from(BACKING).toString("hex"))]).toEqual([1n, 1n, { issued: 10n, burned: 0n }]);
    const history = state.history, evidence = state.evidence;
    await applyRecord(state, spend([afterIssue, EMPTY_NOTE_ROOT], [201n, 202n], [102n, 103n, 104n, 105n]), context);
    await applyRecord(state, burn(7n, [state.tree.root(), afterIssue], [203n, 204n], 106n), context);
    expect(state.position).toBe(3n);
    expect(state.tree.size).toBe(6n);
    expect(state.totals.get(Buffer.from(BACKING).toString("hex"))).toEqual({ issued: 10n, burned: 7n });
    expect([...state.nullifiers]).toEqual([201n, 202n, 203n, 204n]);
    expect(state.spent.size).toBe(4n);
    expect(state.history).not.toEqual(history);
    expect(state.evidence).not.toEqual(evidence);
    expect([...state.events.keys()]).toEqual([1n, 2n, 3n].map(p => `${Buffer.from(SEGMENT).toString("hex")}:${p}`));
    expect(state.eventIndices).toEqual([5n, 5n, 5n]);
    expect(state.scanOutputs.map(o => o.cm)).toEqual([101n, 102n, 103n, 104n, 105n, 106n]);
  });

  it("names each refusal: context, scope, backing, repeat, proof, signature, supply, anchor, spent, output, revocation", async () => {
    const state = fresh(), context = replay();
    await applyRecord(state, issue(10n, 101n), context);
    const root = state.tree.root();
    expect(await refusal(state, issue(1n, 110n, { domain: b(9) }), context)).toBe("CONTEXT");
    expect(await refusal(state, issue(1n, 110n, { segment: b(9) }), context)).toBe("CONTEXT");
    expect(await refusal(state, issue(1n, 110n, { scope: 78n }), context)).toBe("SCOPE");
    expect(await refusal(state, issue(1n, 110n, {}, OTHER), context)).toBe("BACKING");
    expect(await refusal(state, issue(10n, 101n), context)).toBe("REPEATED_STATEMENT");
    expect(await refusal(state, issue(1n, 110n), replay({ verifier: { verify: () => false } }))).toBe("PROOF");
    expect(await refusal(state, issue(1n, 110n, { signer: b(8) }), context)).toBe("SIGNATURE");
    expect(await refusal(state, issue((1n << 64n) - 10n, 110n), context)).toBe("SUPPLY");
    expect(await refusal(state, burn(11n, [root, root], [201n, 202n], 110n), context)).toBe("SUPPLY");
    expect(await refusal(state, spend([root, 999n], [201n, 202n], [110n, 111n, 112n, 113n]), context)).toBe("ANCHOR");
    expect(await refusal(state, spend([root, root], [201n, 201n], [110n, 111n, 112n, 113n]), context)).toBe("SPENT");
    expect(await refusal(state, spend([root, root], [201n, 202n], [101n, 111n, 112n, 113n]), context)).toBe("OUTPUT");
    expect(await refusal(state, spend([root, root], [201n, 202n], [110n, 110n, 112n, 113n]), context)).toBe("OUTPUT");
    // Issuance witnessed at or after K's revocation is void (C2b.1); before it, it stands.
    expect(await refusal(state, issue(1n, 110n), replay({ revokedAt: 5n }))).toBe("REVOKED");
    await applyRecord(state, spend([root, root], [201n, 202n], [110n, 111n, 112n, 113n]), context);
    expect(await refusal(state, spend([root, root], [201n, 203n], [120n, 121n, 122n, 123n]), context)).toBe("SPENT");
    await applyRecord(state, issue(1n, 130n), replay({ revokedAt: 6n }));
    expect(state.position).toBe(3n);
  });

  it("reaches the last valid checkpoint and reproduces its hashes there (C2.10.12)", async () => {
    const valid = fresh(), context = replay();
    await applyRecord(valid, issue(10n, 101n), context);
    const lastValid = { position: 1n, historyHash: valid.history, evidenceHash: valid.evidence };
    await applyRecord(fresh(), issue(10n, 101n), replay({ lastValid }));
    expect(await refusal(fresh(), issue(9n, 101n), replay({ lastValid }))).toBe("CONTINUITY");
    // Issuance the last valid checkpoint finalized was witnessed at its index, not the revoked later one.
    await applyRecord(fresh(), issue(10n, 101n), replay({ lastValid, revokedAt: 5n }));
  });
});

describe("the v3 state machine in adoption mode", () => {
  it("takes an adopted publication's exact admitted bytes without re-verifying proof, context or anchor", async () => {
    const adopted = spend([999n, 998n], [201n, 202n], [110n, 111n, 112n, 113n], { scope: 78n });
    const context = replay({ verifier: { verify: () => false }, block: [{ bytes: adopted, index: 3n }] });
    expect(modeAt(context, 0n)).toBe("adoption");
    expect(modeAt(context, 1n)).toBe("replay");
    const state = fresh();
    expect(await refusal(state, spend([999n, 998n], [201n, 202n], [110n, 111n, 112n, 114n], { scope: 78n }), context)).toBe("ADOPTION");
    await applyRecord(state, adopted, context);
    expect(state.eventIndices).toEqual([3n]);
    // After the block, replay mode judges again.
    expect(await refusal(state, issue(1n, 120n), context)).toBe("PROOF");
  });

  it("still refuses what the forest and spent set refuse", async () => {
    const state = fresh();
    await applyRecord(state, spend([EMPTY_NOTE_ROOT, EMPTY_NOTE_ROOT], [201n, 202n], [110n, 111n, 112n, 113n]), replay());
    const repeat = spend([1n, 2n], [201n, 203n], [120n, 121n, 122n, 123n]), reuse = spend([1n, 2n], [204n, 205n], [110n, 121n, 122n, 123n]);
    expect(await refusal(state, repeat, replay({ block: [{ bytes: new Uint8Array(0), index: 0n }, { bytes: repeat, index: 1n }] }))).toBe("SPENT");
    expect(await refusal(state, reuse, replay({ block: [{ bytes: new Uint8Array(0), index: 0n }, { bytes: reuse, index: 1n }] }))).toBe("OUTPUT");
  });
});

describe("the reader's venue", () => {
  const selection: ReaderSelection = { mode: "current-fixture", domain: DOMAIN, venue: b(12), backing: BACKING, operator: terms.operator,
    root: b(17), sequence: 1n, judgingIndex: 4n };
  const view = (venue: RecordVenue, chosen = selection) => readRecordView(chosen, terms, new Map(), venue);
  const status = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => "read", (e: unknown) => e instanceof EvidenceRefusal ? e.status : e);

  it("reads the chain and revocation from a fixture venue's answers at the witnessed index", async () => {
    const venue = new FixtureVenue(b(12), 4n, 2n);
    const read = await view(venue);
    expect([read.t, read.lag, read.revokedAt, read.chain.map(link => link.from)]).toEqual([4n, 2n, undefined, [0n]]);
    expect(await read.heldBy(terms.operator)).toEqual([]);
  });

  it("is unresolved past the clock, off the current index, on another venue and on a venue with no answer", async () => {
    const venue = new FixtureVenue(b(12), 4n, 2n);
    expect(await status(view(venue, { ...selection, judgingIndex: 5n }))).toBe("unresolved-evidence");
    expect(await status(view(venue, { ...selection, judgingIndex: 3n }))).toBe("unresolved-evidence");
    expect(await status(view(venue, { ...selection, judgingIndex: 3n, mode: "historical-fixture" }))).toBe("read");
    expect(await status(view(new FixtureVenue(b(13), 4n, 2n)))).toBe("unresolved-evidence");
    const failed: RecordVenue = { id: b(12), lag: () => 2n, witnessedIndex: () => { throw new VenueError("this view has no settled snapshot"); }, range: () => undefined };
    expect(await status(view(failed))).toBe("unresolved-evidence");
    // Past the reader's budget is a resource refusal the caller names; any other failure is the venue's and propagates.
    const flooded = new FixtureVenue(b(12), 4n, 2n);
    for (let i = 0n; i <= RANGE_LIMITS.maxEntries; i++) flooded.witness(2, BACKING, 1n, new Uint8Array(233));
    expect(await status(view(flooded))).toBeInstanceOf(RangeLimitError);
    const broken = new Error("supplier bug");
    expect(await status(view({ ...failed, witnessedIndex: () => 4n, range: () => { throw broken; } }))).toBe(broken);
  });

  it("answers only its own witnessed ranges, ordered as §13.1 orders them, and rebuilds identically", () => {
    const venue = new FixtureVenue(b(12), 2n, 2n), wide = { maxBytes: 1n << 20n, maxEntries: 100n };
    venue.witness(4, BACKING, 1n, Uint8Array.of(9));
    venue.witness(1, OTHER, 1n, new Uint8Array(136).fill(2));
    venue.witness(1, OTHER, 1n, new Uint8Array(136).fill(1));
    venue.witness(4, BACKING, 1n, Uint8Array.of(8));
    const request = { venue: b(12), kind: 4 as const, subject: BACKING, fromIndex: 0n, toIndex: 2n };
    const again = FixtureVenue.from(venue.export());
    expect(again.range(request, wide)).toEqual(venue.range(request, wide));
    expect(venue.range({ ...request, toIndex: 3n }, wide)).toBeUndefined();
    expect(venue.range({ ...request, venue: b(13) }, wide)).toBeUndefined();
    expect(venue.range({ ...request, fromIndex: 3n, toIndex: 2n }, wide)).toBeUndefined();
    expect(() => venue.range(request, { maxBytes: 1n << 20n, maxEntries: 1n })).toThrow(RangeLimitError);
    expect(() => venue.witness(1, OTHER, 3n, new Uint8Array(136))).toThrow(/record/);
    expect(() => venue.advance(1n)).toThrow(/forward/);
  });
});
