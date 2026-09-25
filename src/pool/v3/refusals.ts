// The v3 reader's two refusals. A record or checkpoint that fails a rule is
// a ReplayRefusal named by the check it failed; evidence the read cannot use
// (missing, unsupported, lapsed, superseded, over a budget) is an
// EvidenceRefusal named by its status. The verifier's and the caller's own
// failures are neither and propagate.

/** A deterministic failure of one record or checkpoint, named by its check (`PROOF`, `SPENT`, …). */
export class ReplayRefusal extends Error {
  readonly check: string;
  constructor(check: string) {
    super(check);
    this.check = check;
  }
}

/** The C2b.6.1 clock at an index, as the reader reports it beside a lapse. */
export interface ClockRecord {
  readonly duration: string;
  readonly snapshotIndex: string;
  readonly gap: string;
  readonly open: boolean;
  readonly boundary: string | null;
  readonly opening: string;
}

/** Evidence the read cannot use, named by its status (`unresolved-evidence`, `unsupported-scope`, …). */
export class EvidenceRefusal extends Error {
  readonly status: string;
  /** For a lapsed selection, the clock record proving the lapse (C2b.4.1). */
  clock?: ClockRecord;
  constructor(status: string) {
    super(status);
    this.status = status;
  }
}

/** A single-backing read met a checkpoint scoping several backings: the scope reader takes over. */
export class ScopeRequired extends Error {}

export function requireReplay(condition: boolean, check: string): asserts condition {
  if (!condition) throw new ReplayRefusal(check);
}
