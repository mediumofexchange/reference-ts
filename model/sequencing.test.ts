import { describe, expect, it } from "vitest";
import { Model, explore, type Config } from "./sequencing.js";

// The model's properties, in the words of the rules they check:
//   P1 continuity   — every witnessed in-force carrying commitment extends the one before it (C2.7.1, C2b.3).
//   P2 double spend — no nullifier twice across the pool's final histories.
//   P3 contradicted — a receipt's era ended by an ordinary commitment carried its tail (C2b.4).
//   P4 structural   — one commitment in flight, sequences strictly increase (C2.4.1, C2.4.3).
//   P5 receipt lost — in the clean setting (inclusion at exactly the lag, nothing dropped, crashed,
//                     dark or withheld) every receipt ends final: the lead floor's theorem (C2.5.3, C2.6).
//
// Each configuration below is explored over many seeds. A configuration that follows the rules
// must produce no violation; a configuration that departs from one rule must produce the
// counterexample the rule exists to close, and that counterexample is kept here as a regression
// vector. Seeds are deterministic (mulberry32), so a found seed replays exactly.

const base: Config = {
  lag: 1,
  maxDelay: 1,
  drops: false,
  crashes: false,
  darkness: false,
  replacements: true,
  withholding: false,
  steps: 140,
};

const SEEDS = 60;

function holds(config: Config): void {
  const found = explore(config, SEEDS);
  expect(found, found ? `seed ${found.seed}: ${found.violations.map((v) => `${v.property} — ${v.detail}`).join("; ")}\n${found.trace.slice(-30).join("\n")}` : "").toBeNull();
}

describe("§C2/§C2b over notes: the rules as written hold", () => {
  it("honest operators, inclusion at the lag: every receipt ends final", () => {
    holds(base);
  });

  it("slow blocks (inclusion up to three lags late): no fork, no double spend, no contradicted receipt", () => {
    holds({ ...base, maxDelay: 3 });
  });

  it("the venue drops publications: seats go stale and are repaired, never forked", () => {
    holds({ ...base, drops: true });
  });

  it("operators crash and restart from the book they held (C2.8.1)", () => {
    holds({ ...base, drops: true, crashes: true });
  });

  it("operators go dark and return by committing first (C2b.4)", () => {
    holds({ ...base, darkness: true });
  });

  it("committed states are withheld: a stranded seat serves nothing, and nothing forks (C2.7.2)", () => {
    holds({ ...base, withholding: true, crashes: true });
  });

  it("everything at once at lag 2", () => {
    holds({ ...base, lag: 2, maxDelay: 2, drops: true, crashes: true, darkness: true, withholding: true, steps: 160 });
  });

  it("lag 0: a venue that witnesses at the clock's own index", () => {
    holds({ ...base, lag: 0, maxDelay: 0, drops: true, crashes: true });
  });
});

describe("departures from a rule produce the counterexample the rule closes", () => {
  it("C2.5.3 — without the lead floor, a handover effective at its own witnessing erases receipted payments", () => {
    const found = explore({ ...base, leadFloor: 1 }, 300);
    expect(found).not.toBeNull();
    expect(found!.violations.map((v) => v.property)).toContain("P5 receipt lost");
  });

  it("C2.8.1 — resuming from the latest witnessed commitment drops the receipted tail and contradicts it", () => {
    const found = explore({ ...base, drops: true, crashes: true, restartFrom: "witnessed" }, 300);
    expect(found).not.toBeNull();
    expect(found!.violations.map((v) => v.property)).toContain("P3 contradicted receipt");
  });
});

describe("regression vectors", () => {
  // The first seeds the departures were found at. If the model changes and these move, find the
  // new seeds with `explore` and record them here with the property they exhibit.
  it("floor=1, seed 4: receipts lost to a handover", () => {
    const m = new Model({ ...base, leadFloor: 1 }, 4);
    const v = m.run();
    expect(v.map((x) => x.property)).toContain("P5 receipt lost");
  });

  it("restart from witnessed, seed 1: a contradicted receipt", () => {
    const m = new Model({ ...base, drops: true, crashes: true, restartFrom: "witnessed" }, 1);
    const v = m.run();
    expect(v.map((x) => x.property)).toContain("P3 contradicted receipt");
  });
});
