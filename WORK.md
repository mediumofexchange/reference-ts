# Current work

Updated: 2026-09-09

## Goal

Finish delivery of reviewed v3 evidence/history chains, snapshot and receipt
frames. Branches: reference `feat/pool-v3-commitments`, companion
`spec/pool-v3-commitments`. Acceptance demonstrated: committed failing evidence
authenticates but replica substitutions do not; proof variants preserve history
but change evidence/snapshot; adopted withdrawals retain original evidence at
new positions. Full local checks and independent reviews pass; CI and delivery
verification are next. Final configuration and runtime adoption remain later.

## Status

- Specification `4a58fdc` fixes pool-v3 §7 frames and suffix authentication,
  committed before dependent code. No adopted configuration is defined.
- `model/pool-v3-commitments.ts` implements history/evidence chains,
  snapshots, evidence suffix openings and signed receipts outside `src/`.
  `hashEvidenceFields` hashes actual malformed proof/authorization bytes
  separately from strict record validation. Missing fields never become empty.
- Normative review clarified malformed-length evidence vs strict decoding;
  independent readback cleared the correction. Fresh implementation review
  found no material issues and independently passed 59 focused tests.
  A narrow readback cleared the final signed-withdrawal adoption fixture.
- Authentication is separate from replay validity, inclusion and finality.
  Callers must authenticate the expected directory/context and match target
  hashes to actual bytes. Header/trail/certificate formats remain undefined.
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  Move retained v3 codecs and cases into one runtime when its final pins land.
- Prior slices: canonical records `5c1a246` / spec `ca727f6`; six proof
  relations `21f6843` / spec `d57ddb0`. Sources in `scripts/pool/v3/` remain
  conformance evidence, with observed artifact hashes not approved pins.
- Decision: [exact event evidence](decisions/2026-09.md#2026-09-09--bind-successor-snapshots-and-receipts-to-exact-event-evidence).
  Remaining adoption work: [recovery map](docs/POOL_V3_RECOVERY_MAP.md).

## Evidence

- Full `npm run check` passes: 93 files / 1,758 tests, typecheck, build,
  installed-package consumer, pilot, store crash probes and ten spent-set
  groups. Final fixture-only refinement passes all 59 focused tests again.
- Byte tests use independent Buffer/node:crypto frames, real strict Ed25519,
  committed bad authorization vs replica substitution, all truncations,
  range/overflow/seed/suffix tampering and mutable-buffer ownership checks.
  Proof bytes, roots and domains are synthetic; no valid state is claimed.
- Previous main [CI run 34358187309](https://github.com/mediumofexchange/reference-ts/actions/runs/34358187309)
  passes all seven jobs. Current branch CI remains to run before merge.
- Unchanged real-proof evidence: `check:pool:v3` previously passed 304 checks /
  18 real proofs of 14,656 bytes, all 81 public scalars, key substitution,
  ABI-bypass ranges and hostile reproof controls. [Report](docs/pool-v3-conformance-verification.json).
  This slice changes no circuit, proof relation, key or configuration.
- Specification link/diff checks pass. No current specification workflow exists.

## Next

1. Finish documentation/type checks, commit/push this branch, run seven-job CI,
   merge/push both repositories and verify clean remote parity.
2. Define segment headers, served-trail and fault-certificate framing, then
   replay/import/adoption order and final configuration/artifact pins in
   `pool-v3.md`. Name companion branches before coordinated changes. First
   acceptance: a signed directory authenticates a complete bounded opening,
   while missing dependencies remain unresolved and substitutions fail.
3. Implement the single v3 runtime/recovery path and wallet after final pins;
   repeat the six real-proof relations on the final configuration domain.

## Open questions

- About 45% done / 55% remaining, plausible done range 35–55%. These frames
  reduce integration work but close no runtime/product gate. Largest work:
  final configuration/evidence/replay formats, v3 runtime, wallet/transport,
  authenticated complete-range reads, witness publication and custody assurance.
- A8: no selected authenticated complete-range Ergo source. Missing required
  evidence remains unresolved, never zero balance or an older current state.
- Proof-mutation rejection is backend evidence, not a general nonmalleability
  proof or presenter participation. Parsing does not establish authority,
  demand standing or force. Copied journals, rollback, same-index venue order,
  setup/build provenance, phone budgets and publication remain gates.
- Real holders can make dishonest in-kind allegations; public outcomes do not
  prove external non-payment. No release, deployment, access change or funds
  authorized. Retain existing Ergo/v3 probes and parameter caches; no new
  disposable repository copies or dependency trees were created in this slice.
