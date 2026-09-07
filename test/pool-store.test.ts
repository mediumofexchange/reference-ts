import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { makeBacking, signBacking } from "../src/backing.js";
import { directoryRoot, signCommitment, type Commitment } from "../src/commitment.js";
import { poolReceiptAttestsEvidence, poolReceiptInHistory } from "../src/pool/receipt.js";
import type { PoolCheckpointEvidence } from "../src/pool/checkpoint.js";
import { readPoolReceiptCheckpoint, readPoolReceiptRecord } from "../src/pool/receipt-record.js";
import { readPoolReceiptRepair } from "../src/pool/receipt-repair.js";
import { readPoolReceiptStatus } from "../src/pool/receipt-status.js";
import { Segment } from "../src/pool/segment.js";
import { segmentAuthority } from "../src/pool/statement.js";
import { decodeStoredOpening, encodeStoredOpening, encodeStoredReceipt } from "../src/pool/store-codec.js";
import type { PoolStore as Store, PoolStoreCheckpoint } from "../src/pool/store.js";
import { LocalVenue } from "../src/venue.js";
import { signRevocation } from "../src/revocation.js";
import { CONFIG, issueStatement, Oracle, spendStatement, VENUE, walletNote } from "./pool-support.js";
import { evidence, open as openSegment, replace, terms } from "./pool-record-support.js";
import { KEYS, SECRETS } from "./support.js";

const supported = Number(process.versions.node.split(".")[0]) >= 24;
class Delayed extends LocalVenue {
  readonly pending: Commitment[] = [];
  constructor(readonly delay = 2n) { super(VENUE); }
  override lag() { return this.delay; }
  override publish(c: Commitment) { this.pending.push(c); }
  include() { const c = this.pending.shift(); if (c) super.publish(c); }
}

describe.skipIf(!supported)("durable pool sequencing (Node 24)", () => {
  let PoolStore: typeof import("../src/pool/store.js").PoolStore;
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  const stores: Store[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ PoolStore } = await import("../src/pool/store.js"));
    ({ DatabaseSync } = await import("node:sqlite"));
  });
  function path() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pool-store-")); directories.push(directory);
    return join(directory, "state.db");
  }
  function store(file: string, venue: LocalVenue, oracle: Oracle, hook?: (phase: PoolStoreCheckpoint) => void, secret = SECRETS.operator) {
    const value = new PoolStore(file, CONFIG, secret, venue, oracle, hook); stores.push(value); return value;
  }
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });
  async function fixture(venue = new LocalVenue(VENUE), hook?: (phase: PoolStoreCheckpoint) => void) {
    const file = path(), oracle = new Oracle(), x = terms("EUR"), y = terms("USD"), s = store(file, venue, oracle, hook);
    const opening = await s.activate("opening", [x, y]);
    const trail = (await s.view()).trail!;
    const issue = (output = 101n) => oracle.accept(issueStatement(segmentAuthority(trail.header), x.backing.name, 10n, output, SECRETS.backer));
    return { file, venue, oracle, x, y, s, opening, trail, issue };
  }

  async function importedRevocation() {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
    const ancestor = openSegment(venue, [x, y], oracle);
    await ancestor.admit(oracle.accept(issueStatement(ancestor.authority(), x.backing.name, 10n, 101n, SECRETS.backer)));
    const base = evidence(ancestor); venue.publish(base.commitment);
    venue.advance(); venue.publishRevocation(signRevocation(SECRETS.backer));
    const later = evidence(ancestor, 2n); venue.publish(later.commitment);
    replace(venue, x, SECRETS.carol, 2n); venue.advance();
    const file = path(), s = store(file, venue, oracle, undefined, SECRETS.carol);
    await s.activate("inherit", [x], [base, later]); await s.publish();
    return { file, venue, oracle, x, ancestor, base, later, s };
  }

  async function importedDescent(kind: "absence" | "lapse") {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
    const ancestor = openSegment(venue, [x, y], oracle);
    await ancestor.admit(oracle.accept(issueStatement(ancestor.authority(), y.backing.name, 10n, 101n, SECRETS.backer)));
    const base = evidence(ancestor); venue.publish(base.commitment);
    let skipped: PoolCheckpointEvidence;
    if (kind === "absence") {
      skipped = { commitment: signCommitment(SECRETS.operator, 2n, directoryRoot([])), directory: [] };
    } else {
      replace(venue, x, SECRETS.alice, 1n); venue.advance();
      const { history: _history, ...withoutHistory } = evidence(ancestor, 2n);
      skipped = withoutHistory;
    }
    venue.publish(skipped.commitment);
    replace(venue, y, SECRETS.carol, 2n); venue.advance(2n - venue.witnessedIndex());
    const file = path(), s = store(file, venue, oracle, undefined, SECRETS.carol);
    await s.activate("inherit", [y], [base, skipped]); await s.publish();
    return { file, venue, oracle, y, ancestor, skipped, s };
  }

  function alterValidation(file: string, change: (evidence: readonly PoolCheckpointEvidence[]) => readonly PoolCheckpointEvidence[]) {
    const db = new DatabaseSync(file);
    try {
      const row = db.prepare("SELECT seq,command FROM events WHERE id='command:inherit'").get()!;
      const command = JSON.parse(row.command as string) as { opening: string };
      const saved = decodeStoredOpening(command.opening, CONFIG);
      expect(saved.validation).toBeDefined();
      command.opening = encodeStoredOpening(saved.trail, saved.evidence, change(saved.validation!));
      db.prepare("UPDATE events SET command=? WHERE seq=?").run(JSON.stringify(command), row.seq!);
    } finally { db.close(); }
  }

  it("journals the opening before publication and returns the original receipt through restart and reproof", async () => {
    const f = await fixture();
    expect(f.venue.latestFor(KEYS.operator)).toBeUndefined();
    await expect(f.s.submit(f.issue())).rejects.toMatchObject({ code: "STALE" });
    await f.s.publish();
    const statement = f.issue(), receipt = await f.s.submit(statement);
    expect(receipt.after).toBe(1n);
    expect(poolReceiptAttestsEvidence(segmentAuthority(f.trail.header), statement, receipt)).toBe(true);
    const proofCalls = f.oracle.calls;
    expect(await f.s.submit({ ...statement, proof: new Uint8Array(32).fill(99) })).toEqual(receipt);
    expect(f.oracle.calls).toBe(proofCalls);
    f.s.close();
    const resumed = store(f.file, f.venue, f.oracle);
    expect(await resumed.submit(statement)).toEqual(receipt);
    const view = await resumed.view();
    expect(view.trail!.statements).toHaveLength(1);
    expect(poolReceiptInHistory(await Segment.replay(view.trail!, f.oracle), receipt)).toBe(true);
    const commitment = await resumed.commit("checkpoint");
    expect(commitment.sequence).toBe(2n);
    await resumed.publish();
    expect(await resumed.commit("checkpoint")).toEqual(commitment);
    expect((await resumed.view()).highestSignedSequence).toBe(2n);
  });

  it("keeps one operator-wide commitment in flight and refuses an expired unpublished state until repair", async () => {
    const venue = new Delayed(), f = await fixture(venue);
    await f.s.publish();
    const receipt = await f.s.submit(f.issue());
    expect(receipt.after).toBe(1n);
    await expect(f.s.commit("early")).rejects.toMatchObject({ code: "SCHEDULE" });
    await expect(f.s.activate("early-scope", [f.x])).rejects.toMatchObject({ code: "SCHEDULE" });
    venue.advance(2n); // publication was declined; the signed sequence remains consumed
    await expect(f.s.submit(f.issue(102n))).rejects.toMatchObject({ code: "STALE" });
    const repaired = await f.s.activate("repair", [f.x]);
    expect(repaired.sequence).toBe(2n);
    expect((await f.s.view()).trail!.statements).toHaveLength(0);
    expect(await f.s.submit(f.issue())).toEqual(receipt); // retained historical evidence
    f.s.close();
    const resumed = store(f.file, venue, f.oracle);
    expect((await resumed.view()).highestSignedSequence).toBe(2n);
    expect(await resumed.submit(f.issue())).toEqual(receipt);
  });

  it("failed checkpoint repair can leave a live-scope receipt's after sequence held", async () => {
    const venue = new Delayed(), f = await fixture(venue);
    await f.s.publish(); venue.advance(2n); venue.include();
    const statement = f.issue(), receipt = await f.s.submit(statement);
    expect(receipt.after).toBe(1n);
    const failed = await f.s.commit("unpublished-tail");
    expect(failed.sequence).toBe(2n);
    // No publication of sequence 2. C2.4.3 permits stale-state repair after
    // the lag, even though the earlier receipt names HELD sequence 1.
    venue.advance(2n);
    const repaired = await f.s.activate("repair-after-failed-checkpoint", [f.x, f.y]);
    expect(repaired.sequence).toBe(3n);
    await f.s.publish(); venue.advance(2n); venue.include();
    const view = await f.s.view();
    expect(view.trail!.statements).toHaveLength(0);
    expect(view.trail!.header.entries.every(e => e.opening?.sequence === 1n)).toBe(true);
    expect(venue.witnessedAtSequence(KEYS.operator, 2n)).toBeUndefined();
    expect(venue.latestFor(KEYS.operator)).toEqual(repaired);
    expect(readPoolReceiptRecord({ configuration: CONFIG, venue, header: f.trail.header,
      receipt, backings: [f.x, f.y] })).toMatchObject({ kind: "record", scope: "live",
      sequence: { kind: "held", commitment: f.opening } });
    expect(await readPoolReceiptCheckpoint({ configuration: CONFIG, venue, header: f.trail.header,
      receipt, checkpoint: f.opening, evidence: view.checkpoints, verifier: f.oracle }))
      .toMatchObject({ kind: "not-included" });
    expect(await readPoolReceiptRepair({ configuration: CONFIG, venue, header: f.trail.header,
      receipt, backings: [f.x, f.y], repair: repaired, evidence: view.checkpoints, verifier: f.oracle }))
      .toMatchObject({ kind: "repair", lapsed: true, includedAt: [], contradictedAt: [] });
    expect(await readPoolReceiptStatus({ configuration: CONFIG, venue, header: f.trail.header,
      receipt, backings: [f.x, f.y], evidence: view.checkpoints, verifier: f.oracle }))
      .toMatchObject({ status: "lapsed", lapse: { kind: "repair", boundary: { commitment: repaired } } });
    f.s.close();
    const resumed = store(f.file, venue, f.oracle);
    expect(await resumed.submit(statement)).toEqual(receipt);
  });

  it("restart preserves a signed checkpoint and its co-signed tail, fences the old writer, and waits the lag", async () => {
    const venue = new Delayed(), f = await fixture(venue);
    await f.s.publish(); venue.advance(2n); venue.include();
    const receipt = await f.s.submit(f.issue());
    const second = await f.s.commit("second"); await f.s.publish();
    const tail = await f.s.submit(f.issue(102n));
    const resumed = store(f.file, venue, f.oracle);
    await expect(f.s.view()).rejects.toMatchObject({ code: "FENCED" });
    expect(await resumed.submit(f.issue())).toEqual(receipt);
    expect(await resumed.submit(f.issue(102n))).toEqual(tail);
    await expect(resumed.commit("too-soon")).rejects.toMatchObject({ code: "SCHEDULE" });
    await expect(resumed.submit(f.issue(103n))).rejects.toMatchObject({ code: "SCHEDULE" });
    venue.advance(2n); venue.include();
    const next = await resumed.commit("resumed");
    expect(next.sequence).toBe(second.sequence + 1n);
    expect((await resumed.view()).trail!.statements).toHaveLength(2);
  });

  it("elective scope changes wait for all live receipts and the latest signed checkpoint", async () => {
    const f = await fixture(); await f.s.publish();
    const receipt = await f.s.submit(f.issue());
    await expect(f.s.activate("drop", [f.x])).rejects.toMatchObject({ code: "STALE" });
    await f.s.commit("tail");
    // At lag zero an unpublished checkpoint expires immediately. Publish it
    // before asking for the elective change, which must retain finalized state.
    await f.s.publish();
    const newOpening = await f.s.activate("drop", [f.x]);
    expect(newOpening.sequence).toBe(3n);
    const view = await f.s.view();
    expect(view.trail!.header.entries).toHaveLength(1);
    expect(view.trail!.header.entries[0]!.opening?.sequence).toBe(2n);
    expect(view.trail!.statements).toHaveLength(0);
    await f.s.publish();
    // The witnessed tail made the receipt final; the carrying scope change is an ordinary one.
    expect(await readPoolReceiptStatus({ configuration: CONFIG, venue: f.venue, header: f.trail.header, receipt,
      backings: [f.x, f.y], evidence: (await f.s.view()).checkpoints, verifier: f.oracle })).toMatchObject({ status: "final" });
    const rejoined = await f.s.activate("rejoin", [f.x, f.y]);
    expect(rejoined.sequence).toBe(4n);
  });

  it("the actual scope boundary allows reopening remaining backings and retains old receipts", async () => {
    const f = await fixture(); await f.s.publish();
    const receipt = await f.s.submit(f.issue());
    replace(f.venue, f.y, SECRETS.carol, 2n);
    await expect(f.s.activate("remaining", [f.x])).rejects.toMatchObject({ code: "STALE" });
    f.venue.advance(2n);
    await expect(f.s.submit(f.issue(102n))).rejects.toMatchObject({ code: "STALE" });
    const next = await f.s.activate("remaining", [f.x]);
    expect(next.sequence).toBe(2n);
    expect((await f.s.view()).trail!.statements).toHaveLength(0);
    expect(await f.s.submit(f.issue())).toEqual(receipt);
    await f.s.publish();
    expect(await readPoolReceiptStatus({ configuration: CONFIG, venue: f.venue, header: f.trail.header, receipt,
      backings: [f.x, f.y], evidence: (await f.s.view()).checkpoints, verifier: f.oracle }))
      .toMatchObject({ status: "lapsed", scope: "ended", lapse: { kind: "scope-boundary", at: 2n } });
  });

  it.each(["applied", "stored", "committed"] as const)("recovers receipt issuance after a failure at %s", async phase => {
    let armed = false;
    const failure = new Error(phase);
    const f = await fixture(new LocalVenue(VENUE), at => { if (armed && at === phase) { armed = false; throw failure; } });
    await f.s.publish(); armed = true;
    const statement = f.issue();
    await expect(f.s.submit(statement)).rejects.toBe(failure);
    f.s.close(); const resumed = store(f.file, f.venue, f.oracle);
    expect((await resumed.view()).trail!.statements).toHaveLength(phase === "committed" ? 1 : 0);
    const receipt = await resumed.submit(statement);
    expect(receipt.position).toBe(1n); expect(receipt.after).toBe(1n);
    expect(await resumed.submit(statement)).toEqual(receipt);
    expect((await resumed.view()).trail!.statements).toHaveLength(1);
  });

  it.each(["applied", "stored", "committed"] as const)("recovers opening signing after a failure at %s", async phase => {
    const file = path(), venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR");
    let armed = true;
    const s = store(file, venue, oracle, at => { if (armed && at === phase) { armed = false; throw new Error("crash"); } });
    await expect(s.activate("open", [x])).rejects.toThrow("crash");
    expect(venue.latestFor(KEYS.operator)).toBeUndefined();
    s.close(); const resumed = store(file, venue, oracle);
    expect((await resumed.view()).highestSignedSequence).toBe(phase === "committed" ? 1n : 0n);
    expect((await resumed.activate("open", [x])).sequence).toBe(1n);
  });

  it("rejects conflicting command IDs, wrong identities, in-memory paths and corrupt replay", async () => {
    const f = await fixture();
    await expect(f.s.activate("opening", [f.x])).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.s.commit("opening")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(() => store(f.file, f.venue, f.oracle, undefined, SECRETS.carol)).toThrow("identity");
    for (const file of [":memory:", "file:test", ""]) expect(() => store(file, f.venue, f.oracle)).toThrow("persistent");
    await f.s.publish(); await f.s.submit(f.issue()); f.s.close();
    const db = new DatabaseSync(f.file);
    db.exec("UPDATE events SET response='{}' WHERE id LIKE 'statement:%'"); db.close();
    const resumed = store(f.file, f.venue, f.oracle);
    await expect(resumed.view()).rejects.toThrow();
  });

  it("a proof callback cannot sign after another writer resumes or the record clock changes", async () => {
    for (const change of ["owner", "clock"] as const) {
      const f = await fixture(); await f.s.publish();
      const verify = f.oracle.verify.bind(f.oracle); let once = true;
      f.oracle.verify = async (...args) => {
        const result = await verify(...args);
        if (once) { once = false; if (change === "owner") store(f.file, f.venue, f.oracle); else f.venue.advance(); }
        return result;
      };
      await expect(f.s.submit(f.issue())).rejects.toThrow(change === "owner" ? "owns" : "venue changed");
      const resumed = store(f.file, f.venue, f.oracle);
      expect((await resumed.view()).trail!.statements).toHaveLength(0);
    }
  });

  it("same-index record movement during proof verification refuses signing", async () => {
    const f = await fixture(); await f.s.publish();
    const verify = f.oracle.verify.bind(f.oracle);
    f.oracle.verify = async (...args) => {
      const result = await verify(...args);
      f.venue.publish(signCommitment(SECRETS.operator, 10n, directoryRoot([]))); return result;
    };
    await expect(f.s.submit(f.issue())).rejects.toThrow("venue changed");
    expect((await f.s.view()).trail!.statements).toHaveLength(0);
    await expect(f.s.commit("stale")).rejects.toMatchObject({ code: "STALE" });
  });

  it("rejects revoked issuance and unsupported silence recovery without changing state", async () => {
    const f = await fixture(); await f.s.publish(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    await expect(f.s.submit(f.issue())).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect((await f.s.view()).trail!.statements).toHaveLength(0);
    const backing = makeBacking({ ...f.x.backing, evidence: { ...f.x.backing.evidence,
      silence: { noCommitmentDuration: 10n, challengeWindow: 1n } } });
    await expect(f.s.activate("silence", [{ backing, signature: signBacking(SECRETS.backer, backing) }])).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("late witnessing cannot finalize issuance after revocation, even after restart", async () => {
    const f = await fixture(); await f.s.publish();
    const statement = f.issue(), receipt = await f.s.submit(statement);
    await f.s.commit("late");
    f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    f.venue.advance(); await f.s.publish();
    await expect(f.s.commit("cannot-recommit")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    const resumed = store(f.file, f.venue, f.oracle);
    await expect(f.s.view()).rejects.toMatchObject({ code: "FENCED" });
    expect(await resumed.submit(statement)).toEqual(receipt);
    await expect(resumed.commit("cannot-recommit")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(resumed.submit(f.issue(102n))).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect((await resumed.view()).highestSignedSequence).toBe(2n);
  });

  it("retains original replies and publication after same-index revocation invalidates an imported opening", async () => {
    const f = await fixture(); await f.s.publish();
    const statement = f.issue(), receipt = await f.s.submit(statement), receiptBytes = encodeStoredReceipt(receipt);
    const issued = await f.s.commit("issued"); await f.s.publish();
    const inherited = await f.s.activate("inherit", [f.x]); await f.s.publish();
    const nextAuthority = segmentAuthority((await f.s.view()).trail!.header);
    const next = f.oracle.accept(issueStatement(nextAuthority, f.x.backing.name, 10n, 102n, SECRETS.backer));
    f.venue.publishRevocation(signRevocation(SECRETS.backer));

    for (const restarted of [false, true]) {
      if (restarted) f.s.close();
      const s = restarted ? store(f.file, f.venue, f.oracle) : f.s;
      const retried = await s.submit({ ...statement, proof: new Uint8Array(32).fill(99) });
      expect(retried).toEqual(receipt); expect(encodeStoredReceipt(retried)).toBe(receiptBytes);
      retried.signature.fill(0);
      expect(encodeStoredReceipt(await s.submit(statement))).toBe(receiptBytes);
      expect(await s.activate("opening", [f.x, f.y])).toEqual(f.opening);
      expect(await s.commit("issued")).toEqual(issued);
      expect(await s.activate("inherit", [f.x])).toEqual(inherited);
      expect(await s.publish()).toEqual(inherited);
      expect(await s.view()).toMatchObject({ highestSignedSequence: 3n, latest: inherited });

      await expect(s.commit("new-commit")).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect(s.submit(next)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await expect(s.activate("new-opening", [f.x])).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(encodeStoredReceipt(await s.submit(statement))).toBe(receiptBytes);
      expect((await s.view()).highestSignedSequence).toBe(3n);
    }
  });

  it("revocation preserves movement of issuance witnessed before revocation", async () => {
    const f = await fixture(); await f.s.publish();
    const note = walletNote(f.x.backing.name, 10n, 1n);
    await f.s.submit(f.issue(note.cm)); await f.s.commit("issued"); await f.s.publish();
    f.venue.advance(); f.venue.publishRevocation(signRevocation(SECRETS.backer));
    const segment = await Segment.replay((await f.s.view()).trail!, f.oracle);
    const padding = walletNote(f.x.backing.name, 0n, 2n), output = walletNote(f.x.backing.name, 10n, 3n), zero = walletNote(f.x.backing.name, 0n, 4n);
    const spend = f.oracle.accept(spendStatement(segment.authority(), [segment.noteRoot(), segment.noteRoot()],
      [note.nf, padding.nf], [output.cm, zero.cm]));
    expect((await f.s.submit(spend)).position).toBe(2n);
    expect((await f.s.commit("moved")).sequence).toBe(3n);
    await f.s.publish();
    expect((await f.s.commit("still-valid")).sequence).toBe(4n);
  });

  it.each(["applied", "stored"] as const)("revocation appended at the same index during %s rolls back signing", async phase => {
    for (const action of ["submit", "commit"] as const) {
      let armed = false;
      const venue = new LocalVenue(VENUE);
      const f = await fixture(venue, at => {
        if (armed && at === phase) { armed = false; venue.publishRevocation(signRevocation(SECRETS.backer)); }
      });
      await f.s.publish();
      if (action === "commit") await f.s.submit(f.issue());
      armed = true;
      await expect(action === "submit" ? f.s.submit(f.issue()) : f.s.commit("revoked"))
        .rejects.toMatchObject({ code: "UNSUPPORTED" });
      const view = await f.s.view();
      expect(view.highestSignedSequence).toBe(1n);
      expect(view.trail!.statements).toHaveLength(action === "commit" ? 1 : 0);
    }
  });

  it("rejects imported late issuance even when its backing lies outside the new scope", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
    const ancestor = openSegment(venue, [x, y], oracle);
    await ancestor.admit(oracle.accept(issueStatement(ancestor.authority(), y.backing.name, 10n, 101n, SECRETS.backer)));
    const base = evidence(ancestor);
    replace(venue, x, SECRETS.carol, 3n);
    venue.advance(); venue.publishRevocation(signRevocation(SECRETS.backer));
    venue.advance(); venue.publish(base.commitment); venue.advance();
    const s = store(path(), venue, oracle, undefined, SECRETS.carol);
    await expect(s.activate("inherit", [x], [base])).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await s.view()).highestSignedSequence).toBe(0n);
  });

  it("retains required imported ancestry through restart and serves it to the next reader", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
    const ancestor = openSegment(venue, [x, y], oracle);
    await ancestor.admit(oracle.accept(issueStatement(ancestor.authority(), x.backing.name, 10n, 101n, SECRETS.backer)));
    const base = evidence(ancestor); venue.publish(base.commitment);
    replace(venue, x, SECRETS.carol, 2n); venue.advance(2n);
    const file = path(), s = store(file, venue, oracle, undefined, SECRETS.carol);
    await s.activate("inherit", [x], [base]); await s.publish(); s.close();
    const resumed = store(file, venue, oracle, undefined, SECRETS.carol);
    expect((await resumed.activate("next", [x])).sequence).toBe(2n);
    const view = await resumed.view();
    expect(view.checkpoints.some(e => Buffer.from(e.commitment.operator).equals(KEYS.operator))).toBe(true);
    const imports = view.checkpoints.map(e => ({ checkpoint: e, trail: e.history!.trail, length: e.history!.length }));
    const replayed = await Segment.replay(view.trail!, oracle, imports);
    expect(replayed.isAnchor(ancestor.noteRoot())).toBe(true);
  });

  it("retains same-segment pre-revocation finality through replacement, restart and movement", async () => {
    const f = await importedRevocation(); f.s.close();
    const resumed = store(f.file, f.venue, f.oracle, undefined, SECRETS.carol);
    const view = await resumed.view();
    for (const checkpoint of [f.base, f.later]) {
      expect(view.checkpoints.some(e => Buffer.from(e.commitment.signature).equals(checkpoint.commitment.signature))).toBe(true);
    }
    const authority = segmentAuthority(view.trail!.header), root = f.ancestor.noteRoot();
    const spend = f.oracle.accept(spendStatement(authority, [root, root], [201n, 202n], [301n, 302n]));
    expect((await resumed.submit(spend)).position).toBe(1n);
    await resumed.commit("moved"); await resumed.publish();
    expect((await resumed.activate("next", [f.x])).sequence).toBe(3n);
    await resumed.publish(); resumed.close();
    const again = store(f.file, f.venue, f.oracle, undefined, SECRETS.carol);
    expect((await again.activate("again", [f.x])).sequence).toBe(4n);
    expect(await again.submit(spend)).toMatchObject({ position: 1n });
  });

  it.each(["absence", "lapse"] as const)("retains history-free %s evidence through restart and another opening", async kind => {
    const f = await importedDescent(kind); f.s.close();
    const resumed = store(f.file, f.venue, f.oracle, undefined, SECRETS.carol);
    const retained = (await resumed.view()).checkpoints.find(e => Buffer.from(e.commitment.signature).equals(f.skipped.commitment.signature));
    expect(retained).toBeDefined(); expect(retained!.history).toBeUndefined();
    if (kind === "lapse") expect(retained!.snapshots?.some(s => Buffer.from(s.backing).equals(f.y.backing.name))).toBe(true);
    expect((await resumed.activate("next", [f.y])).sequence).toBe(2n);
    await resumed.publish(); resumed.close();
    const again = store(f.file, f.venue, f.oracle, undefined, SECRETS.carol);
    expect((await again.activate("again", [f.y])).sequence).toBe(3n);
  });

  it("enriches retained absence evidence with supplied history when its scope expands", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD");
    const ancestor = openSegment(venue, [y], oracle);
    await ancestor.admit(oracle.accept(issueStatement(ancestor.authority(), y.backing.name, 10n, 101n, SECRETS.backer)));
    const base = evidence(ancestor); venue.publish(base.commitment);
    replace(venue, x, SECRETS.carol, 1n); venue.advance();
    const file = path(), s = store(file, venue, oracle, undefined, SECRETS.carol);
    await s.activate("x", [x], [{ commitment: base.commitment, directory: base.directory }]); await s.publish();
    const heldBase = (checkpoints: readonly PoolCheckpointEvidence[]) => checkpoints.find(e =>
      Buffer.from(e.commitment.signature).equals(base.commitment.signature));
    const absent = heldBase((await s.view()).checkpoints);
    expect(absent).toBeDefined(); expect(absent!.history).toBeUndefined();
    replace(venue, y, SECRETS.carol, 2n); venue.advance();
    expect((await s.activate("expand", [x, y], [base])).sequence).toBe(2n);
    await s.publish(); s.close();
    const resumed = store(file, venue, oracle, undefined, SECRETS.carol);
    const enriched = heldBase((await resumed.view()).checkpoints);
    expect(enriched!.history?.length).toBe(1n);
    expect(enriched!.snapshots?.some(snapshot => Buffer.from(snapshot.backing).equals(y.backing.name))).toBe(true);
    expect((await resumed.activate("next", [x, y])).sequence).toBe(3n);
  });

  it.each(["predecessor", "absence", "lapse"] as const)("retains a readable journal but refuses new signing when %s validation evidence is removed", async kind => {
    const f = kind === "predecessor" ? await importedRevocation() : await importedDescent(kind);
    f.s.close();
    alterValidation(f.file, validation => kind === "lapse"
      ? validation.map(e => e.commitment.sequence === 2n ? { ...e, snapshots: [] } : e)
      : validation.filter(e => e.commitment.sequence !== (kind === "predecessor" ? 1n : 2n)));
    const resumed = store(f.file, f.venue, f.oracle, undefined, SECRETS.carol);
    expect((await resumed.view()).highestSignedSequence).toBe(1n);
    await expect(resumed.commit("new-commit")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await resumed.view()).highestSignedSequence).toBe(1n);
  });

  it.each(["applied", "stored"] as const)("same-index imported revocation during %s rolls back opening signing", async phase => {
    const venue = new LocalVenue(VENUE); let armed = false;
    const f = await fixture(venue, at => {
      if (armed && at === phase) {
        armed = false;
        venue.publishRevocation(signRevocation(SECRETS.backer));
      }
    });
    await f.s.publish(); await f.s.submit(f.issue()); await f.s.commit("issued"); await f.s.publish();
    armed = true;
    await expect(f.s.activate("inherit", [f.x])).rejects.toThrow("revocation record changed during journal operation");
    expect(armed).toBe(false);
    expect((await f.s.view()).highestSignedSequence).toBe(2n);
    expect(venue.latestFor(KEYS.operator)?.sequence).toBe(2n);
  });

  it("refuses silence recovery in a required shared ancestor even outside the new scope", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), plain = terms("USD");
    const backing = makeBacking({ ...plain.backing, evidence: { ...plain.backing.evidence,
      silence: { noCommitmentDuration: 10n, challengeWindow: 1n } } });
    const y = { backing, signature: signBacking(SECRETS.backer, backing) };
    const ancestor = openSegment(venue, [x, y], oracle), base = evidence(ancestor);
    venue.publish(base.commitment); replace(venue, x, SECRETS.carol, 2n); venue.advance(2n);
    const s = store(path(), venue, oracle, undefined, SECRETS.carol);
    await expect(s.activate("inherit", [x], [base])).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect((await s.view()).highestSignedSequence).toBe(0n);
  });

  it("does not retain unrelated unverified history supplied with a valid opening", async () => {
    const f = await fixture(); await f.s.publish();
    const z = terms("unrelated"), unrelated = openSegment(f.venue, [z], f.oracle, 10n);
    await unrelated.admit(f.oracle.accept(issueStatement(unrelated.authority(), z.backing.name, 10n, 999n, SECRETS.backer)));
    const poison = evidence(unrelated); poison.history!.trail.statements[0]!.proof.fill(99);
    await f.s.activate("drop", [f.x], [poison]); await f.s.publish(); f.s.close();
    const resumed = store(f.file, f.venue, f.oracle);
    expect((await resumed.activate("rejoin", [f.x, f.y])).sequence).toBe(3n);
    expect((await resumed.view()).checkpoints.every(e => e.commitment.sequence !== 10n)).toBe(true);
  });

  it("publication failure retries the same durable outbox without consuming another sequence", async () => {
    const f = await fixture();
    const publish = f.venue.publish.bind(f.venue);
    f.venue.publish = c => { publish(c); throw new Error("response lost"); };
    await expect(f.s.publish()).rejects.toThrow("response lost");
    expect(f.venue.latestFor(KEYS.operator)).toEqual(f.opening);
    f.venue.publish = publish; f.s.close();
    const resumed = store(f.file, f.venue, f.oracle);
    expect(await resumed.publish()).toEqual(f.opening);
    expect((await resumed.view()).highestSignedSequence).toBe(1n);
  });

  it("a resumed writer during the publication read fences the old publisher", async () => {
    const f = await fixture(), previous = f.venue.previousFor.bind(f.venue);
    let once = true, publications = 0;
    f.venue.previousFor = (...args) => {
      if (once) { once = false; store(f.file, f.venue, f.oracle); }
      return previous(...args);
    };
    f.venue.publish = () => { publications++; };
    await expect(f.s.publish()).rejects.toMatchObject({ code: "FENCED" });
    expect(publications).toBe(0);
  });

  it("reserves the last signing index of the earliest scope term and stops admission after it", async () => {
    const venue = new Delayed(), f = await fixture(venue);
    await f.s.publish(); venue.advance(2n); venue.include();
    replace(venue, f.y, SECRETS.carol, 7n); // earliest safe last signing index is 4
    replace(venue, f.x, SECRETS.alice, 10n);
    venue.advance();
    await f.s.submit(f.issue()); // can still join the final checkpoint at 4
    await expect(f.s.commit("reserve")).rejects.toMatchObject({ code: "SCHEDULE" });
    venue.advance();
    expect((await f.s.commit("final")).sequence).toBe(2n); await f.s.publish();
    await expect(f.s.submit(f.issue(102n))).rejects.toMatchObject({ code: "SCHEDULE" });
    venue.advance(2n); venue.include();
    await expect(f.s.submit(f.issue(102n))).rejects.toMatchObject({ code: "SCHEDULE" });
    expect((await f.s.view()).trail!.statements).toHaveLength(1);
  });

  it("refuses noncanonical admitted statement hex on replay", async () => {
    const f = await fixture(); await f.s.publish(); await f.s.submit(f.issue()); f.s.close();
    const db = new DatabaseSync(f.file), row = db.prepare("SELECT seq,command FROM events WHERE id LIKE 'statement:%'").get()!;
    const command = JSON.parse(row.command as string); command.statement = command.statement.toUpperCase();
    db.prepare("UPDATE events SET command=? WHERE seq=?").run(JSON.stringify(command), row.seq!); db.close();
    await expect(store(f.file, f.venue, f.oracle).view()).rejects.toThrow("noncanonical stored statement");
  });

  it("serializes concurrent callers and owns input and output bytes", async () => {
    const f = await fixture(); await f.s.publish();
    const statement = f.issue(), original = structuredClone(statement), pending = f.s.submit(statement);
    statement.proof.fill(0); (statement.publicInputs as bigint[])[0] = 0n;
    await expect(f.s.commit("busy")).rejects.toMatchObject({ code: "BUSY" });
    const receipt = await pending, saved = structuredClone(receipt); receipt.signature.fill(0);
    expect(await f.s.submit(original)).toEqual(saved);
    const view = await f.s.view(); view.latest!.root.fill(0); view.trail!.statements[0]!.proof.fill(0);
    expect((await f.s.view()).latest).toEqual(f.opening);
    f.s.close();
    expect(await store(f.file, f.venue, f.oracle).submit(original)).toEqual(saved);
  });

  it.each(["DELETE FROM events WHERE seq=1", "UPDATE identity SET tip=0", "UPDATE events SET request='other' WHERE seq=1"])("refuses journal corruption: %s", async sql => {
    const f = await fixture(); await f.s.publish(); f.s.close();
    const db = new DatabaseSync(f.file); db.exec(sql); db.close();
    await expect((async () => { const resumed = store(f.file, f.venue, f.oracle); await resumed.view(); })()).rejects.toThrow();
  });
});
