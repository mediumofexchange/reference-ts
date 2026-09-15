# Current work

Updated: 2026-09-15

## Goal

The no-commitment clock in the local experiment: under a declared silence
clause the walk that classifies the original segment's carrying checkpoints
reads C2b.6.1's clock at the judging index, the segment's silence boundary
after its opening checkpoint, and the lapse of any continuation witnessed
past it (C2b.4.1). Delivered to main at b18cc1a (feature d5e6166, review fixes 51b33f8 and e3ec24f).
No specification change: the rules are pool-fault §5 and pool-recovery
C2b.6.1/C2b.4.1 as adopted 2026-09-08. No runtime, circuit, key, dependency
or host-control change.

## Status

- Expected result: with a clause, `c(i)` is the last valid carrying
  checkpoint strictly before `i`, the gap is open where `i − c(i)` exceeds
  the duration, the boundary is the first open index strictly after the
  opening checkpoint, and a later checkpoint witnessed while the gap is
  open is `lapsed`: held, its trail neither resolved nor replayed, closing
  nothing, refusing `lapsed-selection` with the clock record when
  selected. The empty-opening contradiction and segment identity are
  settled before the clock. The audit's `clock` reports the duration,
  `c(t)`, the gap, whether it is open, the boundary and the opening index.
  The opening checkpoint is the carrying checkpoint at the header's
  opening sequence (C2b.4.1), exempt from lapse; whenever ranges are read,
  a held opening carrying nothing for the backing is the contradiction
  `OPENING` and a missing one is unresolved, so the proof fixtures now open
  with the backing at sequence 1; without ranges a clause stays
  unsupported; without a clause the clock is null.
  [Decision](decisions/2026-09.md#2026-09-15--read-the-no-commitment-clock-from-the-classified-carrying-checkpoints).
- Earlier today on main: the [candidate Ergo venue profile](docs/ERGO_VENUE_PROFILE.md)
  (1d8f735, CI 34958350541) and the one-transaction capacity decision (72d54fd, CI 34961693625), both passed.
- Independent adversarial review of the clock: two blockers (lapse tested
  before the opening contradiction and segment identity) and four optional
  findings fixed; the readback's residual (the opening's carriage read only
  under a clause) fixed by ungating it and rebuilding the proof fixtures;
  a further readback confirmed no material finding remains.
- Recorded, not resolved: a decoder-refused transaction denies every range
  through its height; reads from index zero scan the genesis on a real chain.

## Evidence

- Baseline main 72d54fd: CI 34961693625 passed. Delivery main b18cc1a:
  CI 34989288167 passed on all seven jobs; both repositories at parity.
- `npm run check:pool:local-replay` on the final sources: 32 groups and 9
  real proofs passed, including the clock group's nineteen cases (gaps
  closed and open, lapse and refusal, supersession at the last allowed
  index, same-index twins, excluded and opening checkpoints, historical and
  zero-duration reads, both review blockers, the portable package).
  [Retained report](docs/pool-v3-local-replay-verification.json).
- `npm run check:docs` OK. The change touches only `scripts/pool/v3` and
  docs; the full suite last passed on 6f4e1e7 with no runtime change since.

## Existing local product and custody boundary

- Configured v2 supports one constant-payout backing, real-proof local payments,
  private delivery and independent public audit. Venue/digest authentication
  are locally modeled. No real funds or host controls changed.
- Offline handoff freezes source and binds one destination. Mark paper export
  historical before activating the matching unfrozen restore; lost replies stay
  with that destination. Old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): automatic preflight
  fail; directory ACL refused, BitLocker/PIN and Secure Boot unavailable.
  Physical theft, cross-account, power-loss, backup isolation and continuous
  recovery qualification need separately authorized test hardware/provisioning.
- Ergo node stopped; [continuation report](docs/ergo-node-sync-resume-verification.json)
  (headers 97,923, full heights null, unresolved). Retain the detached 20 GiB
  image scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd;
  do not delete it or allocate another. No sync run is active.

## Next

1. A successor's or scope-changed segment with its C2.10.5 imports in the
   local replay, then wire the candidate Ergo profile verifier into it in
   place of the fixture venue (an adapter binds the budget).
2. P2 (publication on a node) confirms the measured 24-piece transaction;
   P4 measures exhaustion from index zero on a real chain; decoder node
   equivalence is a selection prerequisite.
3. Configuration approval stays disabled until all adoption prerequisites
   hold; device qualification and external publication remain separate
   dependencies. Do not alter this workstation's controls.

## Open questions

- Reassessed 2026-09-15: unchanged, roughly **50% done / 50% remaining**,
  plausible range **40-60%**. The clock closes one recovery dependency in
  the experiment; successor segments, a selected venue profile, a
  node-equivalent decoder, runtime recovery, qualified custody and user
  operation remain the largest blocks.
- Switch to a fresh instance for the successor-segment slice: it reads
  C2.10.5 imports and pool-v3 §8 headers, not this session's sources, and
  this context is long. A context-efficiency recommendation, not measured
  model performance.
