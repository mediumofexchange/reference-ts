# Current work

Updated: 2026-09-09

## Goal

Finish the v3 configuration before runtime adoption. Canonical statement,
authorization and publication records are now fixed and tested. Next acceptance:
explicit delivery-profile identity/encoding, six ordered bytecode/key identities,
helper and remaining bounds, evidence/snapshot/receipt/segment commitments,
replay/import rules, independent review and a specification commit before
runtime changes. Repeat real-proof evidence on the final build and domain.

## Status

- Delivered code: `5c1a246` from reference `feat/pool-v3-records`; companion
  `spec/pool-v3-records` merged/pushed to specification `main` at `ca727f6`.
  Specification was committed before the dependent codec was written.
- `model/pool-v3-records.ts` implements pool-v3 §§5–6 outside `src/`:
  seven statement kinds, exact proof/authorization/capsule fields, domain and
  integer checks, C4.4 delivery association, three signing messages, five
  bounded publication bodies and exact evidence hashes. No adopted domain,
  proof verification, admission, force or semantic replay is claimed.
- Independent normative review found a first-witness/first-force ambiguity.
  The corrected spec preserves first-effective-index semantics for recovery
  publications and first-witness statement identity for request counting.
  Readback cleared the correction and adjacent variants. Implementation
  review cleared the codec and independently passed its 43 initial tests;
  an additional boundary test exercises exact maximum publication bodies.
- This is a prerequisite for final configuration, not runtime adoption.
  Runtime remains v2, refuses silence clauses and exports no pool wallet.
  Preserve the codec and its cases when moving it into the single v3 runtime.
- Previous six-relation conformance slice: `21f6843`, specification `d57ddb0`.
  Issue/burn bind delivery; spend has four ordinary outputs; demand alone
  requires zero padding anchors; request binds its final u64 refresh.
  Retained sources are in `scripts/pool/v3/`. Observed artifact hashes are
  not approved configuration pins. The verified parameter-download fix is
  `4f37593`, with passing seven-job CI run `34352925479`.
- Decision: [canonical records](decisions/2026-09.md#2026-09-09--fix-canonical-successor-statement-and-publication-records).
  Remaining configuration and runtime work: [recovery map](docs/POOL_V3_RECOVERY_MAP.md).

## Evidence

- `npm run check` passes: 92 files / 1,743 tests, including all 44 codec
  tests, typecheck, build, installed-package consumer, pilot, store crash
  probes and ten spent-set groups. Final documentation/link checks pass.
- [CI run 34357577567](https://github.com/mediumofexchange/reference-ts/actions/runs/34357577567)
  passes all seven jobs at `5c1a246`: Node 20/24 Linux and Node 24 Windows
  checks, both platforms' v3 proofs and unchanged v2/delivery/fee proofs.
  The final follow-up changes only this handoff and exact publication sizes;
  its documentation checks pass, reusing the verified code evidence.
- Byte tests use independent Buffer/node:crypto framing, every truncated
  record/publication prefix, excessive lengths/counts, domain/limb/u64/field
  bounds, capsule profile/order/digest association and Buffer ownership.
  Real strict Ed25519 tests mutate every bound input and both settlement
  signatures. Proof bytes are shape-only; capsules are opaque synthetic data.
- Specification link/diff checks pass; its `main` and `origin/main` match
  `ca727f6` and are clean. No current specification workflow is defined.
- Unchanged real-proof evidence: `npm run check:pool:v3` at the previous slice
  passed 304 checks / 18 real proofs of 14,656 bytes, all 81 public scalars,
  key substitution both ways, ABI-bypass ranges and hostile reproof controls.
  [Report](docs/pool-v3-conformance-verification.json) records observations.
  No circuit, key or configuration changed in this byte-codec slice.

## Next

1. Fix final configuration and remaining evidence/snapshot/replay formats in
   `pool-v3.md`; name companion branches before coordinated changes.
2. Implement v3 runtime/recovery and wallet after final normative pins.
   Move retained proof and byte-conformance sources/cases into that path.

## Open questions

- About 45% done / 55% remaining, plausible done range 35–55%. Record codecs
  reduce integration work but close no runtime/product gate. Largest work:
  final configuration/evidence formats, v3 runtime, wallet/transport,
  authenticated complete-range reads, witness publication and custody assurance.
- A8: no selected authenticated complete-range Ergo source. Missing required
  evidence remains unresolved, never zero balance or an older current state.
- Proof-mutation rejection is selected-backend evidence, not a general
  nonmalleability proof or presenter-key participation. Byte parsing does not
  establish proof validity, authority, demand standing, time or finality.
- Real holders can make dishonest in-kind allegations; public outcomes do not
  prove external non-payment. Copied journals, rollback, same-index venue
  order, setup/build provenance, phone budgets and publication remain gates.
  No release, deployment, access change or real funds authorized.
- Retain existing Ergo/pool-v3 probes and parameter caches. No new disposable
  full repository copies or dependency trees were created for this slice.
