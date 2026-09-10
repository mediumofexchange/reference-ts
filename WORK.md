# Current work

Updated: 2026-09-10

## Goal

Delivered slice: decoder cost accounting on `main` and
`test/decoder-cost-accounting`, based on `d446f83`. Phase measurement, source
analysis, independent review and final report hash readback passed.
Acceptance: explain the API's additional work, preserve the original refusal,
measure host overhead and choose the next source probe.
No normative/runtime change. Companion `money-from-first-principles`
remains `main` at `7ea0ee8`.

## Status

- Baseline CI [34436250463](https://github.com/mediumofexchange/reference-ts/actions/runs/34436250463)
  passed at `d446f83`; upstream fetched without intervening commits. No branch
  protection or rulesets; no safeguards changed.
- The next source experiment is a dedicated keyless validating node. Independent
  review confirms this follows the
  [range-source-first decision](decisions/2026-09.md#2026-09-09--check-the-range-source-before-certificate-packaging).
  It is an independent alternative; hostile alternate-parser tests need not
  precede it. No production node/decoder boundary or resource budget is selected.

## Evidence

- New optional observations preserve every deterministic field of the pinned
  baseline: 23/24 transactions and 60 outputs match at 10 million fuel; one
  valid transaction still refuses during parsing. No accepted output from it.
- Separate predeclared diagnostics run once on that same transaction and its
  five original scripts, at 100 million fuel each with the original 16 MiB
  guest memory. The transaction completes at 21,525,326 fuel; parse 12,830,008,
  serialization 2,599,805, guest JSON 5,714,147, instantiation 380,929 and
  input/stack allocation 437. All fields/IDs of its five outputs and exact bytes match.
- Direct parsing of its original 515/948/36/36/105-byte trees consumes
  2,322,785 fuel combined; all five round-trip. The source confirms transaction
  parsing also constructs/hashes boxes twice and serializes/hashes the tx ID.
  It supports repeated constructor work as the extra cost, but does not measure
  how much of the 10,507,223-fuel difference belongs to clones, hashes or writes.
- Windows current/lifetime-peak private commit/working set and process CPU,
  before/after snapshots, paired phases and Store cleanup are measured.
  Neither observed peaks nor fuel imply a total-process or exact CPU bound.
  The launcher always exits 2; diagnostic completion never clears acceptance.
  Final compile: 2.377 s wall / 7.719 s process CPU, lifetime peak commit
  154,443,776 bytes; current commit after engine closure 28,057,600 bytes.
- Nine worker-free regressions pass: four provenance and five phase/error-cleanup
  cases. Independent review inspected actual code, baseline equality, source
  paths and next-probe priority; no material finding remains. `npm run check`
  passed: 96 files / 1,795 tests plus build/package/pilot/crash/spent-set checks.
  Final docs passed; eight source hashes match working/index bytes and all
  36 engine hashes plus DLL/WASM pins match. Disposable engine and intermediate
  reports were removed after capture; pinned installation reproduces them.
- [Cost analysis](docs/POOL_DEPLOYMENT_PROBES.md#decoder-cost-and-host-overhead),
  [profile](docs/ergo-decoder-cost-verification.json),
  [reproduction](experiments/ergo-range/README.md). Historical
  [baseline report](docs/ergo-metering-verification.json) is hash-pinned at
  `d446f83`; do not overwrite it with an observational rerun.

## Next

1. Read CI for the latest main revision. Local checks, independent review and
   final report/source/index/engine readback passed; new CI is pending at handoff.
2. Preflight a dedicated local keyless validating-node probe: select and pin
   artifact/source; declare disk, network, wall and OS resource budgets before
   installation/sync; bind only local APIs and disable wallet/key services.
   Record validation/history/bootstrap settings and best fully validated
   chain/sync state. Reproduce all 24 fixture transactions, 65 output fields,
   order and roots through bounded GET reads. Matching fixtures or HTTP success
   alone cannot establish full validation or best-chain membership.
3. Compare that measured node boundary with the metered-decoder evidence before
   selecting production dependencies or optimizing/forking the parser.
   Reusing one compiled module with fresh capped Stores is plausible, but host
   allocation/copy/JSON bounds, containment and hostile parser cases remain owed.
4. Authenticate complete contiguous ranges/publication order, then replay,
   import/adoption, openings and certificate dependencies; see the
   [recovery map](docs/POOL_V3_RECOVERY_MAP.md). Fix v3 configuration/artifact
   pins, implement one v3 runtime and wallet, rerun all six real-proof relations.
5. A fresh primary instance is recommended for the node work: this investigation
   is captured, and the next slice changes to node configuration/sync evidence.

## Open questions

- Windows exact CPU containment remains failed. No old budget/report changed.
  No hostile parser inputs, live deployment, node installation or real funds
  were involved; no product gate closed. Runtime remains v2, rejects silence
  clauses and has no pool wallet.
- About **45% done / 55% remaining**, plausible done range **35–55%**.
  Largest work: evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated ranges, witness publication and custody assurance.
- Deployment, public releases, access changes and real funds remain outside
  standing authorization.
