// The time constraints for one current scope (C2.4.3, C2.6.1, C2.8.2,
// C2.10.9). These are one part of the sequencer's entry checks: the caller
// must establish record currency, scope authority and the opening commitment.
// Nothing here signs, admits, classifies receipts or discards a tail.
import { EncodingError } from "../bytes.js";

export interface ScopeClock {
  /** Current witnessed venue index, never wall-clock time. */
  readonly now: bigint;
  readonly lag: bigint;
  /** Effective end indices of the scope's terms, as derived from the record.
   * Include ended terms until the old scope is retired; no known end is []. */
  readonly boundaries: readonly bigint[];
  /** Last signed but not yet witnessed commitment, across ALL segments of
   * this operator on this venue. Omit once that exact commitment is witnessed. */
  readonly unwitnessedSignedAt?: bigint;
  readonly resumedAt?: bigint;
}

export interface ScopeSchedule {
  readonly nextSigningIndex: bigint;
  readonly boundary?: bigint;
  /** May be negative when the boundary has no nonnegative safe signing clock. */
  readonly lastSigningIndex?: bigint;
  /** Time checks only: admission still requires the sequencer's other checks. */
  readonly admissionOpen: boolean;
  /** Sign when otherwise ready, preserving the last whole-scope commitment. */
  readonly commitNow: boolean;
  /** The effective boundary, not the earlier admission cutoff, ends the scope. */
  readonly lapsed: boolean;
}

export function scopeSchedule(clock: ScopeClock): ScopeSchedule {
  const index = (value: bigint): void => {
    if (typeof value !== "bigint" || value < 0n) throw new EncodingError("scope clocks must be nonnegative bigints");
  };
  index(clock.now); index(clock.lag);
  if (!Array.isArray(clock.boundaries)) throw new EncodingError("scope boundaries must be a list");
  let boundary: bigint | undefined;
  for (const end of clock.boundaries) {
    index(end);
    if (boundary === undefined || end < boundary) boundary = end;
  }
  let nextSigningIndex = clock.now;
  for (const at of [clock.unwitnessedSignedAt, clock.resumedAt]) {
    if (at === undefined) continue;
    index(at);
    if (at > clock.now) throw new EncodingError("a signing or restart index is in the future");
    if (at + clock.lag > nextSigningIndex) nextSigningIndex = at + clock.lag;
  }
  const lastSigningIndex = boundary === undefined ? undefined : boundary - clock.lag - 1n;
  const admissionOpen = lastSigningIndex === undefined || nextSigningIndex <= lastSigningIndex;
  // On restart, even an otherwise safe future commitment does not reopen
  // admission before the recovery wait has actually passed (C2.8.2).
  const recovered = clock.resumedAt === undefined || clock.now >= clock.resumedAt + clock.lag;
  const reserveLast = lastSigningIndex !== undefined && clock.now < lastSigningIndex &&
    clock.now + clock.lag > lastSigningIndex;
  return Object.freeze({
    nextSigningIndex,
    ...(boundary === undefined ? {} : { boundary, lastSigningIndex: lastSigningIndex! }),
    admissionOpen: admissionOpen && recovered,
    commitNow: nextSigningIndex === clock.now && admissionOpen && !reserveLast,
    lapsed: boundary !== undefined && clock.now >= boundary,
  });
}
