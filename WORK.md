# Current work

Updated: 2026-09-09

## Goal

Delivered slice: contained Ergo decoder feasibility and local-node comparison,
at `d65daa2`, merged and pushed to `main` and `feat/ergo-contained-decoder`.
Clean status and remote parity verified; based on `72c18b0`.
Observable result: install/read back process limits before a fixed worker
runs, measure independent controls and recover the existing corpus. Acceptance
of hard containment FAILED; retain the negative result and do not execute
hostile parser cases or adopt a runtime boundary. No specification changes;
companion `money-from-first-principles` remains `main` at `7ea0ee8`.

## Status

- Windows Job launcher uses creation-time assignment, suspended start,
  membership/limit readback, restricted handle inheritance and checked cleanup.
  Default limits: 256 MiB process/job commit, one active process, two seconds
  user CPU, eight seconds wall and 64 KiB captured output. CPU control uses
  one second; prior corpus uses 10 seconds CPU and 30 seconds wall.

## Evidence

- [Retained report](docs/ergo-containment-verification.json) returns exit 2:
  memory control job peak **273,514,496** exceeds configured **268,435,456**
  bytes; process peak **266,940,416** is below it. Allocation refused, but
  the discrepancy is unexplained. Creation-time assignment did not resolve it.
- The final CPU control reached its eight-second wall deadline after
  **3.796875 seconds user CPU**, while full repository checks also ran.
  Earlier isolated runs terminated with native quota status after 1.375 and
  3.265625 seconds user CPU. Periodic checks do not give an exact CPU ceiling.
- Wall/output controls yielded their expected termination outcomes; descendant
  did not finish successfully, without independently established failure cause.
  Existing corpus passed **14,874 assertions / 24 transactions / 65 outputs**
  inside the job, peak **61,571,072** bytes. No hostile parser stress ran.
- Independent review checked actual C#/PowerShell/JS and x64 struct layouts;
  required direct process cleanup on failed membership readback, now fixed and
  read back. Review of `72c18b0..d65daa2` found no unresolved material findings
  for evidence delivery; all report hashes and node source claims checked.
  This review does not clear the failed containment/runtime gate.
- Baseline CI [34397257226](https://github.com/mediumofexchange/reference-ts/actions/runs/34397257226)
  passed at `72c18b0`. Upstream fetched, no intervening main changes.
  Full `npm run check` passed: 96 files / 1,795 tests, build, package consumer,
  pilot, crash and spent-set checks. Run outside sandbox after the same
  esbuild parent-directory denial; final docs/links pass. No circuits/config changed.

## Next

1. Read CI for the latest main/handoff revision. Local checks, independent
   review and implementation delivery are verified; new remote CI is pending.
2. Explain job memory accounting and CPU behavior, or evaluate another OS
   boundary with explicit resource semantics. Do not raise tolerances to hide
   unexplained overages. Hard containment remains open; hostile depth/count/
   declared-size parser inputs are gated on it. This OS-level investigation
   is a useful fresh-primary boundary; independent review is required.
3. Independently probe a dedicated keyless validating node with exact artifact,
   validation/history/bootstrap config and sync-state evidence. Bounded GET
   reads must reproduce fixture fields/order/roots. No local node ran here.
   [Comparison and source pins](docs/POOL_DEPLOYMENT_PROBES.md#comparison-with-a-local-validating-node)
   explain why a node does not itself close canonicality or resource gates.
4. Then authenticate complete contiguous ranges and publication order, followed
   by replay/import/adoption, openings and certificate dependencies. The
   [range-source-first decision](decisions/2026-09.md#2026-09-09--check-the-range-source-before-certificate-packaging)
   and [recovery map](docs/POOL_V3_RECOVERY_MAP.md) still govern integration.
5. Fix final `pool-v3.md` configuration/artifact pins, then build one v3 runtime
   and wallet and rerun all six real-proof relations on that configuration.

## Open questions

- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  A8/A9, authenticated contiguous headers, chain/finality, node equivalence,
  publication force and custody remain open. No runtime/protocol gate closed.
- The Windows supervisor is fixed trusted experiment code, not a file/network
  sandbox. It is outside default CI; run only `contained-check.ps1`, never the
  worker directly. Current explicit probe exits 2 with unresolved evidence.
- Earlier decoder/root evidence remains unchanged; failures are not absence.
  Package metadata is not a reproduced build. Prior v3 proof evidence remains
  304 checks / 18 proofs on a synthetic configuration domain.
- About **45% done / 55% remaining**, plausible done range **35–55%**. This
  slice exposes resource uncertainty and closes no product gate. Largest work:
  evidence/replay/configuration, v3 runtime, wallet/transport, authenticated
  range reads, witness publication and custody assurance.
- Deployment, public releases, access changes and real funds remain outside
  authorization. No dependency, node installation or live publication added.
