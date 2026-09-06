import { describe, expect, it } from "vitest";
import { calendarSchedule } from "../model/pool-schedule.js";
import { scopeSchedule } from "../src/pool/schedule.js";

describe("C2.6.1/C2.10.9: schedule the entire scope at its earliest term boundary", () => {
  it("agrees with enumerated future signing clocks, including an operator-wide commitment in flight", () => {
    for (let lag = 0; lag <= 3; lag++) for (let end = 1; end <= 12; end++) {
      for (let now = 0; now <= end + 1; now++) for (const signedAt of [undefined, Math.max(0, now - 1), now]) {
        const model = calendarSchedule({ now, lag, boundaries: [end + 3, end],
          ...(signedAt === undefined ? {} : { unwitnessed: signedAt }) });
        const result = scopeSchedule({ now: BigInt(now), lag: BigInt(lag), boundaries: [BigInt(end + 3), BigInt(end)],
          ...(signedAt === undefined ? {} : { unwitnessedSignedAt: BigInt(signedAt) }) });
        expect({ admissionOpen: result.admissionOpen, commitNow: result.commitNow, lapsed: result.lapsed }).toEqual(model);
      }
    }
  });

  it("preserves the last clock and does not lapse the tail at the earlier refusal", () => {
    const at = (now: bigint) => scopeSchedule({ now, lag: 3n, boundaries: [20n, 10n] });
    expect(at(4n)).toMatchObject({ admissionOpen: true, commitNow: false, lastSigningIndex: 6n });
    expect(at(6n)).toMatchObject({ admissionOpen: true, commitNow: true });
    expect(scopeSchedule({ now: 6n, lag: 3n, boundaries: [10n], unwitnessedSignedAt: 6n })).toMatchObject({ admissionOpen: false, commitNow: false });
    expect(at(7n)).toMatchObject({ admissionOpen: false, commitNow: false, lapsed: false });
    expect(at(10n).lapsed).toBe(true);
  });

  it("agrees with the calendar during recovery with and without a known term boundary", () => {
    for (let lag = 0; lag <= 3; lag++) for (let now = 0; now <= 10; now++) {
      for (const boundaries of [[], [5, 9], [15]]) for (let resumed = 0; resumed <= now; resumed++) {
        const model = calendarSchedule({ now, lag, boundaries, resumed, unwitnessed: now });
        const result = scopeSchedule({ now: BigInt(now), lag: BigInt(lag), boundaries: boundaries.map(BigInt),
          resumedAt: BigInt(resumed), unwitnessedSignedAt: BigInt(now) });
        expect({ admissionOpen: result.admissionOpen, commitNow: result.commitNow, lapsed: result.lapsed }).toEqual(model);
      }
    }
  });

  it("waits on restart, keeps the operator-wide signing wait, and releases it upon exact witnessing", () => {
    expect(scopeSchedule({ now: 8n, lag: 3n, boundaries: [], resumedAt: 7n })).toMatchObject({ admissionOpen: false, commitNow: false, nextSigningIndex: 10n });
    expect(scopeSchedule({ now: 10n, lag: 3n, boundaries: [], resumedAt: 7n })).toMatchObject({ admissionOpen: true, commitNow: true });
    expect(scopeSchedule({ now: 8n, lag: 3n, boundaries: [12n], unwitnessedSignedAt: 7n })).toMatchObject({ admissionOpen: false, commitNow: false });
    expect(scopeSchedule({ now: 8n, lag: 3n, boundaries: [12n] })).toMatchObject({ admissionOpen: true, commitNow: true });
  });

  it("uses bigint above the safe-number boundary and refuses malformed clocks", () => {
    const now = 1n << 60n;
    expect(scopeSchedule({ now, lag: 2n, boundaries: [now + 3n] })).toMatchObject({ lastSigningIndex: now, commitNow: true });
    for (const clock of [
      { now: -1n, lag: 0n, boundaries: [] }, { now: 0n, lag: -1n, boundaries: [] },
      { now: 0 as never, lag: 0n, boundaries: [] }, { now: 0n, lag: 0n, boundaries: [-1n] },
      { now: 0n, lag: 1n, boundaries: [], unwitnessedSignedAt: 1n },
    ]) expect(() => scopeSchedule(clock)).toThrow();
  });
});
