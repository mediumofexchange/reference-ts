# Current work

Updated: 2026-09-19

## Goal

Completed slice: two-backing finalized import/replay at the conditional v3 layer,
through shared ancestry, split/rejoin and a later continuation, with seedless
public audit and restored candidate note paths.

Every scoped predecessor must be canonical and finalized; common events count
once; distinct-event nullifier/output conflicts fail. Independent readers must
agree on totals/roots. A missing/stale dependency refuses the complete checkpoint
without partial audit or wallet candidates. Existing single-backing silence
retirement, exact adoption and receipts must remain valid. No runtime adoption,
live-chain or production spendability claim. Stop after acceptance, review and
verified delivery, not at an internal helper or fixture milestone.

## Status

- Implementation main includes this two-backing slice, delivered from
  `feat/two-backing-finalized-replay`. Baseline hosted CI 35461587920 passed all
  seven jobs; inspect this delivery revision's hosted run separately.
- Shared replay tracks event identities and per-backing totals. The normal-scope
  classifier resolves whole checkpoints and child-relative predecessors, merges
  common history once and preserves original-tree paths. Separate issuers and
  revocation cutoffs are checked for every backing. Wallet queries filter the
  selected backing when one seed owns notes across the shared history.
- Scope changes follow existing C2.10.3–7; no normative amendment. Companion
  specification stays on main e41cac8; normative pin remains fb7dd07.
## Evidence

- Fifteen focused fixture groups passed with an ideal proof oracle, including
  whole-scope lapse, same-index predecessor order, missing unselected evidence,
  conflicting merges and unsupported recovery ancestry. This is not proof evidence.
- Independent design and integrated adversarial reviews found no remaining
  material blockers. Required real-proof/fresh-process acceptance passed.
- `npm run check` passed: 1,934 tests plus packaging, profile, service, wallet,
  crash-recovery and spent-set acceptance.
- Final real replay (`prepare-crs.mjs`, then `local-check.mjs --ergo`) passed
  121 groups and 45 real proofs, including fresh seedless and wallet processes.
  The [retained report](docs/pool-v3-local-replay-verification.json) binds the
  43 exact source hashes, unchanged circuit identities and candidate configuration.
- Required multi-scope ancestry with silence/non-service clauses or recovery
  records and multi-backing receipt queries is explicitly unsupported. The
  existing single-backing recovery classifier remains separate.

## Next

1. Check main/remote parity and hosted CI for the delivery commit from Git.
2. Next product slice: multi-backing recovery through a scope change. Start with
   C2b.4's per-backing adoption obligations and venue-ordered publication union,
   then probe shared ancestry with two backing clocks before dependent code.
   Require seedless audit, restoration and continuation after exact adoption.
3. Import lapse still needs full trails. A future proof-fixture cache must bind
   exact sources, artifacts and configuration and retain independent generation
   checks. Neither improvement should interrupt the active capability slice.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  venue/digest authentication are modeled. Offline handoff freezes the source
  and binds one destination; old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): preflight fails;
  qualified hardware, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority.
- Ergo node is stopped. Retain the detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and the
  verified parameter/tool caches. Do not delete the image or allocate another.
  [Sync handoff](docs/ergo-node-sync-resume-verification.json): headers 97,923;
  full heights null/unresolved. P2 node publication, P4 real-chain exhaustion,
  decoder equivalence and authenticated venue evidence remain open.
- The legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**. Normal shared
history replay is reusable progress; complete recovery, selected venue/decoder,
qualified custody and user operation still dominate remaining work.

After delivery, switch to a fresh instance for multi-backing recovery: it needs
concentrated context for publication ordering and adoption across backing clocks.
