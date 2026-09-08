# Readers of the fault-recovery candidate

Research model only. This implements evidence handling for the candidate in
[the proposal](POOL_FAULT_RECOVERY_PROPOSAL.md), not a selected protocol rule.
The normative contracts and `src/` remain unchanged.

## Record and reader

`World.include` witnesses a signed checkpoint at the current venue index and
keeps its initial validation result for the base models and diagnostics.
Validation itself is a separate operation. A recorded `status` is not a
venue-certified fact about an opaque checkpoint.

`FaultWorld.record` evaluates a held checkpoint afresh. Its evaluation view
contains earlier witnessed indices and, at its own index, only lower
sequences of the same operator. The child is absent from that view. Validation
reuses the authority/recovery model's checks against this prefix, including
the canonical predecessor, final prefix, imported state, faulted segment,
clock and adopted recovery block. Later checkpoints cannot enter that read
or retrospectively fault an earlier finalized prefix.

Results are memoized only within a read. An unresolved result is recomputed
when evidence changes; an active dependency cycle refuses instead of trusting
an earlier status. The model enumerates its finite record to stand for the
venue's predecessor interface. It is not a production validation cache,
bounded retrieval algorithm or history-scaling result.

`world.reader()` takes an independent snapshot of the record, public terms,
revocations, recovery publications and available evidence. Readers share the
immutable ideal checkpoint/proof identities, not validation results. Each
reader has its own `withheld`, `withheldDirectories`, `withheldScopes` and
`shownScopes`. Removing an ID from a withheld set models obtaining its exact
authenticated evidence. Keeping a facet available models retaining those
bytes, not retaining a bare assertion that it was once valid.

A reader created before new record facts remains a snapshot at the old
index/state of knowledge. Obtain a fresh reader for a changed record,
including same-index revocation. Evidence retention never turns an old
snapshot into a current authorization to serve. Future-index queries in the
model are hypothetical reads against that finite snapshot, not assertions
that the venue has supplied a complete future record.

## Evidence and lapse

The classification is valid, excluded, unresolved or lapsed. Mismatching
scope evidence is unresolved; it is not an authenticated malformed header.
Malformed bytes authenticated by the signed checkpoint can establish
exclusion. Missing history does not establish invalidity or an empty state.

Lapse is checked separately from full event validity:

- Term lapse needs authenticated scope and witnessed replacement terms. It
  can be established without the checkpoint's event proofs.
- Silence lapse also needs the historical clock. Under intrinsic exclusion,
  that can require earlier fault evidence, including another scope's evidence
  when passing a non-carrying checkpoint in a backing's clock.
- An ordinary non-carrying step needs authenticated directory absence and
  a resolved lapse question, but does not need its unrelated event history.

The R1 cross-scope dependency from the
[review](../decisions/archive/2026-09-08-pool-fault-review.md) is now visible:
withholding Y's fault evidence makes X's clock unresolved where passing a
Y-only silence-lapsed continuation requires that evidence. Restoring it
resolves the read. This repairs the reader, not the candidate's isolation
claim. The clock/lapse policy choice remains open.

`nonCarryingSilenceClosesInterval` is an opt-in research alternative: a
non-carrying step checks term lapse but not silence lapse. It removes that
particular history dependency while permitting stale commitments to suppress
another backing's silence recovery. The [comparison and return decision](POOL_RECOVERY_RETURN_DECISION.md)
records its tests and the safety failure shared by the base recovery model
and both clock choices. Neither is ready for normative adoption.

## Receipts and service

Import, canonical validation and fresh opening validation use the same
reader results. The present receipt reader and the supplied-boundary repair
reader pass evidenced exclusions in their base, same-segment and
different-segment paths. Passed records still consume their held sequences;
only a real missing sequence can support the repair-hole check. An excluded
record supplies no canonical transition or inclusion. Earlier finalized
inclusion can still be proven from its earlier prefix.

Restored evidence can make the current service's checkpoint final and permit
its normal scope change; service readiness no longer consults only the
initial inclusion result. The candidate still faults an entire segment on
authenticated invalid evidence, including a stale twin's later checkpoint,
while preserving earlier finality.

The model deliberately retains the existing undecided receipt precedence:
fault alone leaves an unfinalized tail pending; a canonical transition can
abandon it; a later real publication hole or term end can lapse it. Permanent
abandonment on fault is a different proposal and has not been selected.

## Adversarial evidence

`model/pool-fault-reader.test.ts` covers evidence absent on first witnessing,
different arrival orders, selective retention, repaired-descendant imports,
same-index rank, authenticated absence and malformed headers, term versus
silence lapse, receipt selection and revocation snapshots. The older fault
suite still exercises rollback and reversed-verdict departures. It now
re-evaluates those verdicts rather than trusting their initial status.

The semantic observer separately evaluates the record with all ideal
evidence, so it can detect a finalized spend that an ordinary reader's faulty
missing-data rule would roll back. Recovery publication behavior remains
relative to the tested reader. The observer has access to hidden note
openings solely to check holdings, supply, authority and double consumption;
ordinary readers and service never use that information to route or decide
proof validity.

Validation on Node 24.6.0 / Vitest 3.2.7: 27 new regression cases passed;
the full `npm run check` passed 79 files / 1,543 tests, documentation,
typecheck, build, installed package, local pilot and pool-store crash checks.
Independent adversarial review verified the service, observer, malformed
header and supplied-repair corrections with seven focused probes; the final
parent-scope authentication guard was also independently reviewed and tested.
