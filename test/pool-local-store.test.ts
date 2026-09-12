import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { copySegmentHeader, type SegmentHeader } from "../src/pool/statement.js";
import type { PoolStore as Store } from "../src/pool/store.js";
import { LocalVenue } from "../src/venue.js";
import { CONFIG, DOMAIN, Oracle, VENUE, headerOf } from "./pool-support.js";
import { terms } from "./pool-record-support.js";
import { KEYS, SECRETS } from "./support.js";

const supported = Number(process.versions.node.split(".")[0]) >= 24;

describe.skipIf(!supported)("locally constrained pool store (Node 24)", () => {
  let PoolStore: typeof import("../src/pool/store.js").PoolStore;
  const stores: Store[] = [], directories: string[] = [], scratch = resolve("scratch");

  beforeAll(async () => {
    ({ PoolStore } = await import("../src/pool/store.js"));
  });

  function path() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pool-local-store-"));
    directories.push(directory);
    return join(directory, "state.db");
  }

  function store(file: string, venue: LocalVenue, oracle: Oracle, required?: SegmentHeader) {
    const value = new PoolStore(file, CONFIG, SECRETS.operator, venue, oracle, undefined, required);
    stores.push(value);
    return value;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens a fresh journal when its configured header matches", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR");
    const expected = headerOf([{ backing: x.backing.name }]);
    expect(expected.domain).toEqual(DOMAIN);
    const constrained = store(path(), venue, oracle, expected);
    const opening = await constrained.activate("opening", [x]);
    expect((await constrained.view()).trail!.header).toEqual(expected);
    expect((await constrained.view()).latest).toEqual(opening);
  });

  it("restarts against the exact saved opening header", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), file = path();
    const first = store(file, venue, oracle);
    await first.activate("opening", [x]);
    const header = (await first.view()).trail!.header;
    first.close();
    const resumed = store(file, venue, oracle, header);
    expect((await resumed.view()).highestSignedSequence).toBe(1n);
  });

  it("rejects a different backing without fencing the existing handle", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), y = terms("USD"), file = path();
    const first = store(file, venue, oracle);
    await first.activate("opening", [x]);
    const actual = (await first.view()).trail!.header;
    const mismatched = copySegmentHeader({ ...actual,
      entries: [{ backing: y.backing.name, link: y.backing.name }] });
    let error: unknown;
    try { store(file, venue, oracle, mismatched); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "UNSUPPORTED" });
    expect((await first.view()).latest).toBeDefined();
  });

  it("checks every retained opening before fencing when a later segment differs", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), file = path();
    const first = store(file, venue, oracle);
    await first.activate("opening", [x]);
    const initial = (await first.view()).trail!.header;
    await first.publish();
    await first.activate("next", [x]);
    expect((await first.view()).trail!.header.sequence).toBe(2n);
    let error: unknown;
    try { store(file, venue, oracle, initial); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "UNSUPPORTED" });
    expect((await first.view()).highestSignedSequence).toBe(2n);
  });

  it("adds no event or signature when activation produces a mismatched header", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), file = path();
    const expected = {
      domain: new Uint8Array(32).fill(0x99), venue: VENUE, operator: KEYS.operator,
      sequence: 1n, entries: [{ backing: x.backing.name, link: x.backing.name }],
    } satisfies SegmentHeader;
    const constrained = store(file, venue, oracle, expected);
    await expect(constrained.activate("opening", [x])).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect((await constrained.view()).highestSignedSequence).toBe(0n);
    expect(venue.latestFor(KEYS.operator)).toBeUndefined();
  });

  it("copies the mutable configured header before later activation", async () => {
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), x = terms("EUR"), file = path();
    const unconstrained = store(file, venue, oracle);
    await unconstrained.activate("opening", [x]);
    const header = (await unconstrained.view()).trail!.header;
    unconstrained.close();
    const configured = copySegmentHeader(header);
    const constrained = store(file, venue, oracle, configured);
    configured.entries[0]!.backing.fill(0x42);
    expect((await constrained.view()).highestSignedSequence).toBe(1n);
  });
});
