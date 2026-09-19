# Current work

Updated: 2026-09-19

## Goal

Single-backing successor/restarted segments in the local v3 experiment,
with exact finalized C2.10.5 imports and real-proof spending of an imported
note. Branch `feat/v3-finalized-imports`; specification remains on `main`
at 3ed1800 (no normative change). Base main aa21230.

Acceptance: transitive imports preserve totals, spent nullifiers, output
commitments and accepted roots while starting an empty local output tree;
missing/stale/unwitnessed imports, imported double spends and duplicate
outputs refuse. Replacement, reappointment and same-index restart must pass
through the portable package and fresh seedless/receiver processes.

## Status

- Implementation and acceptance complete. Each checkpoint
  replays from its segment's fixed imported base; prior state is never
  mutated. Wallet candidates retain their original tree paths.
- Independent adversarial review found one blocker: an unheld opening was
  excluded, permitting descent to older state. Fixed by preserving it as
  unresolved; readback found no remaining material issue. Regressions cover
  missing B opening and a later C attempting rollback to A.
- Portable-package replay and fresh seedless/receiver processes agree with
  the in-process result. Authorized delivery remains pending.
- [Decision](decisions/2026-09.md#2026-09-19--import-the-exact-single-backing-finalized-closure-in-local-replay).
- No runtime, circuit, key, dependency, device-control or specification change.
  Silence-bearing imports, multi-backing closure and adoption remain unsupported.
  Import term-lapse currently requires full trail evidence; header-only lapse
  is a recorded availability improvement.

## Evidence

- Base main aa21230: CI 34990416105 passed (confirmed remotely).
- Expanded local replay: 40 groups / 14 real proofs passed, including
  replacement, imported-note spending, nonzero burn inheritance,
  reappointment, same-index restart and imported SPENT/OUTPUT refusals.
  [Retained report](docs/pool-v3-local-replay-verification.json).
- `npm run check:pool:restoration`: all 14 checks passed; local-only scanner
  retains its default import refusal.
- `npm run check:docs` passes; the patch has no whitespace errors.
- GitHub access works with approved network escalation; fetched origin remains
  aa21230, main unprotected. Delivery has not yet been attempted.

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

1. Commit and deliver the reviewed import slice, then verify hosted CI and
   remote parity. No implementation review remains owed.
2. Wire the candidate Ergo profile verifier into local replay in place of the
   fixture venue (an adapter binds the budget). Multi-backing and silence
   recovery imports remain distinct replay dependencies.
3. P2 (publication on a node) confirms the measured 24-piece transaction;
   P4 measures exhaustion from index zero on a real chain; decoder node
   equivalence is a selection prerequisite. A decoder-refused transaction
   currently denies every range through its height.
4. Configuration approval stays disabled until all adoption prerequisites hold;
   device qualification and external publication remain separate dependencies.
   Do not alter this workstation's controls.

## Open questions

- Reassessed from current evidence: roughly **50% done / 50% remaining**,
  plausible range **40-60%**. Single-backing imports advance the experiment;
  selected venue/decoder, complete recovery, qualified custody and user
  operation remain the largest blocks. No percentage change is warranted.
- Stay with this instance through verification and delivery: the relevant
  replay and review context is current. Reassess for the venue-adapter slice.
