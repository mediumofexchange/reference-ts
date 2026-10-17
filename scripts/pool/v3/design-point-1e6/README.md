# Slice 18 probe (disposable)

The tooling behind [the design point at 10⁶](../../../../docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-at-10-slice-18),
kept at this revision only so the probe section can cite it; it is deleted in the next commit. It extends slice 15's
probe ([at defc7ee](https://github.com/mediumofexchange/reference-ts/tree/defc7ee/scripts/pool/v3/design-point-edges)),
itself M13h's ([at 51ea592](https://github.com/mediumofexchange/reference-ts/tree/51ea592/scripts/pool/v3/design-point-rerun)):
`node.mjs` and `standin-backend.mjs` are M13h's unchanged.

- `driver.mjs`: slice 15's driver made to run for days on a Windows PC (its header lists the changes): each process
  samples itself (`sample-hook.mjs`), every process runs at above-normal priority beside a record of the host's CPU,
  holdings stop at 25,000, and `serve` restarts at each mark. `standin-hook.mjs` is M13h's with its memory sampler
  moved to `sample-hook.mjs`.
- `keep.mjs`, `launch.cmd`, `rekeep.mjs`: the keeper that restarts the driver after a PC sleep or shutdown, from a
  Startup entry it removes when the report is done; it resumes from the journal's count.
- `tail.mjs`: the driver's generation alone, run after the report, timing each of 3,000 admissions past 10⁶ at a
  given block size (`--per-block 14` the run's 42 statements a checkpoint, 9 about 27, the design point's peak).
- `hash-memory.mjs`: the host hash's memory over 10⁶ calls (a diagnostic of the wallet's growth; it stayed flat).
- `tail-summary.mjs`: a tail report's admissions by kind and each checkpoint's slowest admission.
- `witness-probe.mjs`: the wallet's growth isolated: the runtime's `ReplayStore` appending four-output records to a kept
  file, witnessing every eighth output and spending it two records later, timing each append that completes a block of
  2^15 leaves or more with the process's memory around it (`--leaves 20 --from 15 --spend`, about 23 min here).
- `report.json`, `tail-report-14.json`, `tail-report-9.json`, `witness-probe.jsonl`: the results as the section reads them.

As run, the worktree was `bc43e79` with `9f6515d` applied at 4.7·10⁵ statements, on the default ports `39053`–`39056`.
