# Current work

Updated: 2026-09-09

## Goal

F3 is complete as a design/feasibility slice. Next, choose the smallest fee-capable shape
before freezing v3. Measure a direct payment/change/fee output against the
smallest viable alternative, preserving per-backing conservation and private
receiver control. Keep the first supported profile at constant-payout roots
with no reliance graph.

## Status

- F3 delivery/restoration contract is merged/pushed in companion main at
  `02d911c`; companion branch: `spec/pool-delivery-restoration`.
- Reference delivery: `main`; slice branch `feat/pool-delivery-restoration`,
  from `61dc4bf`. Specification landed before the retained probes.
- [Decision](decisions/2026-09.md#2026-09-09--receiver-prepared-outputs-restore-from-bound-public-capsules):
  receiver-prepared exact outputs with seed-encrypted 89-byte capsules;
  issue/spend/burn bind the ordered vector through two public digest limbs.
  Note, owner and nullifier formulas stay unchanged. Lit settlements use
  their public opening and a separately derived backer secret.
- Runtime remains v2 and refuses silence clauses. These reproducible probes
  are outside exported runtime code; v3 finality, restoration and wallet
  durability are not implemented. Lost pending invoices still need backup.

## Evidence

- Independent contract/probe review resolved settlement creation/adoption,
  malformed byte subclasses and in-circuit digest range evidence. Final host
  source readback is complete; no unresolved material findings.
  See [deployment probes](docs/POOL_DEPLOYMENT_PROBES.md#delivery-and-seed-restoration).
- `npm run check:pool` passed: 153 checks, 24 real proofs, unchanged v2 pins.
- `npm run check:pool:delivery` passed 22 host checks, WebCrypto and a fresh
  process with seed plus prevalidated synthetic public data. It preserves
  unresolved coverage and separates venue-created notes awaiting adoption.
- Binding probe: +16 gates, same 32,768 subgroup and 14,656-byte proof;
  mutation of either digest limb fails. ABI-bypassed `2^128` fails ACIR.
- `npm run check` passed: 90 files / 1,686 tests, installed package, pilot and
  pool-store crash checks. Links passed across both repositories (37 files).
- Final report/source hashes: `docs/pool-delivery-verification.json`.
  CI includes delivery probes on Linux and Windows; inspect the exact main SHA.
  Disposable F3 copies/builds were removed after recording their evidence.

## Next

1. F4: measure 2-input/3-output spend including the selected delivery digest;
   compare separate fees/atomic batching and define who requests/receives the
   fee, retry behavior and fee backing constraints. Preserve conservation,
   zero padding and no privileged debit. Resolve review; commit spec first.
2. Before `pool-v3.md`, close remaining map choices and signed-attributable
   presentment wording versus the unsigned pool demand/fresh presenter key.
   Integrate final circuits, layouts, model cases and runtime only afterward.

## Open questions

- About 43% done / 57% remaining, plausible done range 33–53%. F3 removes a
  format/design uncertainty; it does not close the wallet/recovery product gate.
  Largest work: F4, v3 circuits/runtime, wallet/transport, witness publication
  and authenticated complete-range reads, custody and deployment assurance.
- A8: no selected authenticated complete-range source for Ergo. Missing full
  public evidence is unresolved, never zero balance or an older current state.
- A22: spent roots must stay set-determined and recomputable per statement;
  insertion-ordered indexed trees do not automatically satisfy those rules.
- Copied journals, rollback, same-index venue order, setup/build provenance,
  phone budgets and real publication acceptance remain release gates.
- Retain existing Ergo/pool-v3 probes and shared parameter caches. No public
  release, live deployment, access-control change or real funds are authorized.
