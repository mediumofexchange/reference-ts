# Current work

Updated: 2026-09-09

## Goal

Complete binary-decoder feasibility slice at `f1eeae2` on
`feat/ergo-decoder-probe`. Acceptance demonstrated: recover all 65 fixture
output IDs/fields from 24 signed transactions, retain malformed/canonicality
counterexamples, and identify resource gaps. The broader bounded-reader gate
is NOT closed: hard memory containment and node-equivalence evidence remain.
No runtime API or venue-profile change; companion specification `main`
at `7ea0ee8` is unchanged. Next slice changes to process/node-boundary design.

## Status

- Independent adversarial review of `b110d6b..f1eeae2` found no unresolved
  material findings and reproduced the exact report. Source/package claims
  were independently checked; the opaque-script clarification was accepted.
  Full checks pass; merge/push is next.
- Clean experiment install and `npm run check:ergo:range` pass. Inherited main
  `b110d6b` passed all CI ([run](https://github.com/mediumofexchange/reference-ts/actions/runs/34394566142)).
  Upstream was fetched; no effective main rules/protection were present or changed.
- The [range-source-before-packaging decision](decisions/2026-09.md#2026-09-09--check-the-range-source-before-certificate-packaging)
  still applies. [Recovery map](docs/POOL_V3_RECOVERY_MAP.md) owns integration order.
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  Complete certificate dependencies, configuration and adoption remain open.

## Evidence

- [Decoder report](docs/ergo-decoder-verification.json): 14,874 assertions,
  24 transactions / 65 outputs fully recovered by `ergo-lib-wasm-nodejs@0.28.0`.
  All 14,450 proper prefixes reject. Raw parser accepts trailing bytes and
  nonminimal input counts in all 24 transactions; exact round trips reject both.
  All 65 script/height aliases recover original committed fields from bytes.
- [Source analysis](docs/POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility):
  pinned sigma-rust allocates a declared u32 script size before reading it,
  without a local cap. Source evidence only; exhaustion was not executed.
  Experimental limits: 256 KiB fixture, 64 KiB transaction, 30-second corpus
  process deadline, 1 MiB output. No hard process/WASM memory bound.
- Existing [block-root report](docs/ergo-range-verification.json): 342 checks,
  all three roots/24 transaction IDs match. 138,228 raw JSON bytes and 14,450
  signed transaction bytes. Fleet decodes only 11/24; sigma-rust closes that
  observed coverage gap. Fixtures and upstream/package sources are pinned.
- Required full `npm run check` initially failed at esbuild's sandboxed
  parent-directory read; the unchanged authorized outside-sandbox run passed:
  96 files / 1,795 tests, build, package consumer, pilot, crash probes and ten
  spent-set groups. Docs/links and clean-install offline checks pass. No circuits/config changed;
  prior [v3 proof report](docs/pool-v3-conformance-verification.json) remains
  304 checks / 18 proofs, synthetic domain only.

## Next

1. Merge/push the reviewed and verified slice, then read latest CI. Preserve
   required safeguards.
2. Compare OS-contained binary decoding with a local validating-node boundary.
   Acceptance: hard memory/CPU/read budgets demonstrably contain hostile
   depth/count/declared-size inputs; failures remain unresolved evidence;
   selected-node valid transaction coverage and canonicality policy are explicit.
   Use isolated disposable probes, never an unrestricted allocation stress run.
   This is a new security/design slice suitable for a fresh primary instance;
   independent adversarial review is required before adopting a runtime boundary.
3. Build authenticated contiguous-range reads and stable publication order,
   then replay/import/adoption, complete openings and certificate dependencies.
   Missing or unsupported evidence remains unresolved.
4. Fix final configuration/artifact pins in `pool-v3.md`, then implement one
   v3 runtime/recovery path and wallet; repeat all six real-proof relations
   on the final configuration domain.

## Open questions

- About 45% done / 55% remaining, plausible done range 35–55%. Decoder evidence
  reduces uncertainty but closes no runtime/product gate. Largest blocks:
  evidence/replay/configuration, v3 runtime, wallet/transport, authenticated
  complete-range reads, witness publication and custody assurance.
- A8/A9 remain open: fixtures are noncontiguous; headers were not independently
  authenticated. Version 1 roots do not authenticate witnesses. Raw outputs
  supply no held-commitment status or publication force.
- Npm source metadata is not build reproduction. Canonical round trips may
  refuse node-valid encodings; unsupported input cannot imply omission.
  Proof rejection is not general nonmalleability or presenter participation.
  Rollback/finality, setup provenance, phone budgets and publication stay open.
- Deployment, releases, access changes and real funds remain unauthorized.
  Dependencies remain private to the experiment; slice scratch probes were
  removed after their evidence was captured in the retained corpus and docs.
