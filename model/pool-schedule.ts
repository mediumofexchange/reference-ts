// Bounded calendar model of C2.4.3, C2.6.1, C2.8.2 and C2.10.9.
// Enumerate possible signing and witnessing clocks instead of using the
// runtime's deadline arithmetic. Authority and record currency are assumed;
// this model does not establish inclusion when the venue delays or drops.
export interface Calendar {
  readonly now: number;
  readonly lag: number;
  readonly boundaries: readonly number[];
  readonly unwitnessed?: number;
  readonly resumed?: number;
}

export function calendarSchedule(c: Calendar, ignoreEarliest = false) {
  const boundaries = ignoreEarliest && c.boundaries.length ? [Math.max(...c.boundaries)] : c.boundaries;
  const live = (at: number) => boundaries.every(end => at < end);
  const free = (at: number) =>
    (c.unwitnessed === undefined || at >= c.unwitnessed + c.lag) &&
    (c.resumed === undefined || at >= c.resumed + c.lag);
  const candidates: number[] = [];
  // Every possible commitment clock before all terms end; inclusion occurs
  // at the venue lag in this conditional-progress model.
  const horizon = boundaries.length ? Math.max(...boundaries) :
    Math.max(c.now, c.unwitnessed ?? 0, c.resumed ?? 0) + 2 * c.lag + 1;
  for (let sign = c.now; sign <= horizon; sign++) {
    if (free(sign) && live(sign + c.lag)) candidates.push(sign);
  }
  const last = candidates.at(-1);
  return {
    admissionOpen: last !== undefined && (c.resumed === undefined || c.now >= c.resumed + c.lag),
    commitNow: candidates.includes(c.now) && last !== undefined &&
      (boundaries.length === 0 || c.now === last || c.now + c.lag <= last),
    lapsed: !live(c.now),
  };
}
