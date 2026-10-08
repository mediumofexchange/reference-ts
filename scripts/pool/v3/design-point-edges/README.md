# Slice 15 probe (disposable)

The tooling behind [the design point's two edges](../../../../docs/POOL_DEPLOYMENT_PROBES.md#the-design-points-two-edges-slice-15),
kept at this revision only so the probe section can cite it; it is deleted in the next commit. It extends M13h's
probe ([at 51ea592](https://github.com/mediumofexchange/reference-ts/tree/51ea592/scripts/pool/v3/design-point-rerun)):
`node.mjs`, `standin-hook.mjs`, `standin-backend.mjs`, `mem-hook.mjs` and `prof.mjs` are used from there unchanged.

- `driver.mjs`, `profile.mjs`: M13h's, with the worktree and run directory taken from `DPR_WT` and `DPR_RUN`, and
  `profile.mjs` without `--cpu-prof` unless `DPR_PROF` is set. `ab.sh` builds each variant's history and times
  1,500 admissions; `summary.mjs` summarizes them; `hash-micro.mjs` compares the two hash implementations.
- `holdings-gen.mjs`: `profile.mjs` with every output paying the seed, to build a wallet of many holdings.
  `walprobe.mjs` measures a reader's and a seed-restored wallet's first and nothing-new syncs.
- `alloc-hook.mjs` + `heapprof.mjs`: every allocation sampled, collected ones included; `snap-hook.mjs` +
  `snapsum.mjs`: a heap snapshot once a wallet's holdings are built.

As run, the wallet run used copies of `driver.mjs`, `holdings-gen.mjs` and the probes with every port moved up by
100 (`3905x` to `3915x`), beside the 10⁵ run on the default ports.
