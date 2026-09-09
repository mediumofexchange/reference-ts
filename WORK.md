# Current work

Updated: 2026-09-09

## Goal

Deliver canonical v3 segment headers, the first dependency of bounded
complete-opening evidence. Branches: reference `feat/pool-v3-segment-headers`,
companion `spec/pool-v3-segment-headers`. Acceptance: independent byte/hash
vectors bind domain, venue, operator, first sequence, ordered scope and exact
opening references; strict bounded decoding rejects malformed inputs and owns
buffers; substituted headers cannot authenticate through a signed directory.
No complete-opening, replay, finality or adoption result is claimed.

## Status

- Specification `061f87e` is reviewed, committed before code, merged/pushed
  to `main` with clean status and remote parity. It fixes pool-v3 §8's header
  fields under the new context without changing v2 or adding derived fields.
- `model/pool-v3-headers.ts` implements the codec outside the runtime. Count
  and exact byte length are checked before entries; structural validation
  checks ordered unique scopes, the sole empty sentinel and same-operator
  predecessor sequences. Other operators' counters remain independent.
- Maximum header is 8,913,023 bytes for 65,536 entries; encoding uses a
  preallocated byte buffer. This format bound is not a proven device budget.
- Fresh normative and implementation reviews found no material issues.
  Implementation reviewer independently passed all 17 focused tests; its
  documentation correction distinguishes framing checks from entry validation.
- Full project checks pass. Implementation delivery remains pending.
  Current upstream main `b824f41` has all seven CI jobs passing.
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  Header key bytes are structural data: strict signatures and record context
  still establish authentication. Missing opening evidence stays unresolved.
- Decision: [reuse header fields](decisions/2026-09.md#2026-09-09--reuse-the-segment-header-fields-for-v3).
  Integration order and remaining assumptions: [recovery map](docs/POOL_V3_RECOVERY_MAP.md).

## Evidence

- Focused suite: 17 tests pass; typecheck passes. Independent Buffer/SHA256
  vectors, v2 separation, every truncation, count/length prechecks, maximum
  scope, sentinel/order/counter/range cases, sparse/malformed objects,
  Buffer ownership and real signed-directory substitution are covered.
- Full `npm run check` passes: 94 files / 1,775 tests, typecheck, build,
  installed-package consumer, pilot, pool-store crash probes and ten spent-set
  groups. Final documentation and cross-repository link checks pass.
- Specification links and whitespace checks pass. Both repositories report
  no main branch protection or effective rules; no safeguards were changed.
- Proof relations, circuits, keys and configuration are unchanged. Existing
  v3 real-proof evidence remains 304 checks / 18 proofs of 14,656 bytes,
  all 81 public scalars and hostile reproof controls. [Report](docs/pool-v3-conformance-verification.json).
  These are synthetic-domain observations, not approved configuration pins.

## Next

1. Finish implementation commit and authorized delivery;
   verify remote parity and distinguish the new CI run from prior evidence.
2. Define served-trail and fault-certificate framing, including exact invalid
   evidence and dependency references, then complete-opening verification.
   Name companion branches before coordinated changes. Acceptance: a signed
   directory authenticates a complete bounded opening, missing dependencies
   remain unresolved, and substitutions fail. Header conformance alone does
   not fulfill this acceptance.
3. Fix replay/import/adoption order and final configuration/artifact pins in
   `pool-v3.md`, then implement one v3 runtime/recovery path and wallet;
   repeat the six real-proof relations on the final configuration domain.

## Open questions

- About 45% done / 55% remaining, plausible done range 35–55%. Header formats
  reduce integration work but close no runtime/product gate. Largest work:
  complete evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated complete-range reads, witness publication and custody assurance.
- A8: no selected authenticated complete-range Ergo source. Missing required
  evidence remains unresolved, never zero balance or an older current state.
- Proof-mutation rejection is backend evidence, not a general nonmalleability
  proof or presenter participation. Parsing does not establish authority,
  demand standing or force. Copied journals, rollback, same-index venue order,
  setup/build provenance, phone budgets and publication remain gates.
- Real holders can make dishonest in-kind allegations; public outcomes do
  not prove external non-payment. No release, deployment, access change or
  funds authorized. Existing probes and parameter caches remain; this slice
  creates no disposable repository copies or dependency trees.
