import { describe, expect, it } from "vitest";
import { calendarSchedule } from "./pool-schedule.js";

describe("C2.10.9 shared-scope calendar model", () => {
  it("keeps the final in-term signing clock free for both backings", () => {
    for (let lag = 0; lag <= 4; lag++) {
      const end = 3 * lag + 5;
      let unwitnessed: number | undefined;
      let latest = -1;
      for (let now = 0; now < end; now++) {
        const state = calendarSchedule({ now, lag, boundaries: [end + 4, end],
          ...(unwitnessed === undefined ? {} : { unwitnessed }) });
        if (state.commitNow) { latest = now; unwitnessed = now; }
        if (state.admissionOpen) expect(now + lag).toBeLessThan(end);
      }
      expect(latest + lag).toBe(end - 1);
    }
  });

  it("ignoring the earlier backing creates a receipt with no possible whole-scope commitment", () => {
    const c = { now: 7, lag: 2, boundaries: [9, 15] };
    expect(calendarSchedule(c).admissionOpen).toBe(false);
    expect(calendarSchedule(c, true).admissionOpen).toBe(true);
    expect(calendarSchedule(c).lapsed).toBe(false);
    expect(calendarSchedule({ ...c, now: 9 }).lapsed).toBe(true);
  });
});
