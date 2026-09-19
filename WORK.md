# Current work

Updated: 2026-09-19

## Goal

Next product slice: complete two-backing finalized import/replay at the conditional
v3 layer, through shared ancestry and a scope change, with seedless public audit
and restored candidate note paths. This is one capability slice with internal
milestones, not separate tasks for each helper or regression test.

Acceptance: every scoped predecessor is canonical and finalized; common events
count once; distinct-event nullifier/output conflicts fail; totals and roots
agree for independent fresh readers; one missing/stale scoped dependency refuses
the whole checkpoint without partial audit or wallet candidates. Carry the trace
through a later valid continuation. Preserve silence retirement and exact adoption.
No live-chain, configuration-adoption or production spendability claim.

## Status

- Implementation main includes same-index openings (21af018) and handoff 8329bd3.
  Hosted CI 35460587446 passed all seven jobs on Linux/Windows and Node 20/24.
- Companion specification main is e41cac8 (documentation cleanup); the latest
  normative amendment remains fb7dd07, committed before its dependent code.
- Agent/workflow cleanup: shorter shared guidance, explicit capability slices,
  risk-based review boundaries, focused iteration and exact-baseline reuse.
  Current docs distinguish v2 runtime from v3 experiments and local wallet limits.
- Removed 25 fully merged local branches and 12 obsolete scratch entries.
  Remaining active branch is main in both repositories; no unfinished feature
  branch. Workspace-root guidance is local; repository guidance is tracked.
- Cleanup is documentation-only. Check its final commit/CI from git on resumption;
  a follow-up commit just to insert its own hash is unnecessary.

## Evidence

- Final same-index acceptance: `npm run check:pool:ergo-replay` passed 106 groups
  and 37 real proofs, including seedless/issuer fresh-process agreement.
  [Retained report](docs/pool-v3-local-replay-verification.json) binds 41 source hashes.
- Normative and independent adversarial patch reviews found no material blockers.
  Shared runtime, circuits, keys and dependencies are unchanged by cleanup;
  reuse 8329bd3's passing hosted baseline.
- Cleanup: instruction constraint comparison, focused diff review, documentation
  checks and links across all four repositories; CLAUDE imports remain exact.
  No protections, required checks, host permissions or model settings changed.

## Next

1. Read C2.10.3–7 in companion `pool-authority.md`, the relevant C2b.4 rules,
   and v3 header/trail layouts. Use `model/pool-authority.ts` and its tests as
   existing semantic evidence; inspect `scripts/pool/v3/local-replay.mjs`,
   `import-check.mjs`, `recovery-check.mjs` and relevant codec callers.
2. First probe a two-backing shared-prefix import and otherwise-valid conflicting
   ancestry. Reuse the existing closure rules; resolve any concrete ambiguity
   with independent review and a spec commit before dependent implementation.
   Then complete the real-proof audit/restoration path above and deliver it.
3. Use focused checks during iteration, then final real-proof replay and the
   appropriate broader checks from AGENTS.md. Review the integrated sensitive
   patch; do not stop at the first passing fixture.
4. Import lapse still needs full trails. A future proof-fixture cache must bind
   exact sources, artifacts and configuration and retain independent generation
   checks; repeated fixture corrections currently regenerate unchanged proofs.

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
- The registered legacy Temp/moeclean worktree points at a different
  Claude_local checkout in its .git file; preserved rather than altering that
  checkout during this workspace cleanup.
- Configuration approval stays disabled. Device qualification and external
  publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**. Selected
venue/decoder, complete recovery, qualified custody and user operation remain
the largest blocks. Cleanup does not change the estimate.

Switch to a fresh instance for the two-backing capability slice; this instance
has completed cleanup and the next work needs concentrated protocol context.
