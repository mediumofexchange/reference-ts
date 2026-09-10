# Current work

Updated: 2026-09-10

## Goal

Delivered behavior: stock Ergo node startup without spending keys, on
`test/ergo-node-startup`, based on `206e0e3`. Decision `760fa4a`; first refusal
`2309bdf`; second observation/classifier refusal `a462dd3`. Final observations
pass after source-checked fixes. No sync, publication, funds or runtime adoption.
Companion specification remains `money-from-first-principles/main` at `7ea0ee8`.

## Status

- [Decision](decisions/2026-09.md#2026-09-10--keep-the-source-probe-free-of-spending-keys):
  reuse the pinned stock node for this finite trusted-host probe. It never
  initializes/imports/persists/uses a spending key, wallet prover or keystore.
  Wallet actor/routes and hardcoded wildcard CORS remain; no fake disable flag.
- Startup strips inherited JVM overrides, checks bundle hashes, uses fresh
  private directories, CPU-rate/memory/process limits and three literal GETs.
  Source-configured offline plus socket samples is not hard network isolation.
- Independent boundary/implementation review is complete with no material
  findings remaining. Final code's Windows controls and startup passed.
  `npm run check` passed: 96 files / 1,795 tests, build/package/pilot/crash and
  spent-set checks. Initial sandbox esbuild access refusal was resolved by
  rerunning the unchanged required command with normal filesystem access.
  Final docs/links passed; delivery CI is pending for the resulting main commit.
- No branch protection or rulesets at entry; safeguards unchanged. Baseline
  CI [34440565868](https://github.com/mediumofexchange/reference-ts/actions/runs/34440565868)
  passed; upstream refreshed without intervening commits.

## Evidence

- [Probe, source references and limits](docs/ERGO_NODE_PREFLIGHT.md),
  [startup report](docs/ergo-node-startup-verification.json),
  [resource controls](docs/ergo-node-controls-verification.json),
  [reproduction](experiments/ergo-range/README.md).
- Final run: 73.897 s wall; 20.797 s job user CPU / 2.281 s kernel;
  peak job commit 336,232,448 bytes; observed files+stdout 9,193,752 bytes.
  Installed limits: 4 GiB commit, 2 GiB JVM heap, 25% CPU rate, one process,
  120 s wall and 16 MiB combined observed file/output envelope.
- Three GETs return 200 / 200 / 403: initialized mainnet UTXO root, no block
  headers (explicit null heights), empty peers, rejected unauthenticated wallet
  access. Secret directory remains empty. 287 TCP/UDP samples show only loopback
  TCP; whole-job cleanup passes. Zero packets/hostile-input isolation not proven.
- Java is Microsoft OpenJDK 21.0.1+12-LTS. Node appVersion reports
  `6.0.4RC2-109-c3646640-SNAPSHOT`; preserve this beside v6.1.5 prerelease
  artifact hashes. Artifact identity is not a reproducible-source-build proof.
- Six process controls; ten worker-free resource-report regressions; sixteen
  startup-evidence regressions; eleven loopback HTTP/socket cases pass.
- All eight report/source hash entries match working and Git index bytes;
  all 167 bundle files match after execution. Secret storage is empty.
  Disposable bundle, node state and source-inspection files were removed.
- First attempt's 500 ms request at listener appearance refused before readers
  were ready. Second attempt's null-height/empty-array classifier rejected valid
  empty history. Immutable reports/code remain at the two commits above; neither
  is reclassified as passing. Final run fixes readiness schedule and predicates,
  and checks final+sampled files together with raw captured output bytes.

## Next

1. Check CI for the delivered startup commit. Local required checks, independent
   review, report/source/index hash readback and scratch cleanup passed.
2. Use a fresh Astra primary instance for the next slice. The source/startup
   investigation is captured; disk/network containment is a distinct boundary
   that still needs strong judgment. This is an efficiency recommendation,
   not measured comparative model performance.
3. Select and demonstrate the first sync's disk/network controls before enabling
   peers. The declared envelope is 30 minutes, 20 GiB dedicated data, 10 GiB
   combined traffic, existing memory/CPU controls and 100 GiB host disk reserve.
   File sampling/process I/O counters alone do not enforce those quotas. No host
   firewall, WSL-wide settings or access-control changes are authorized.
4. Add full effective-settings readback if practical; current evidence combines
   source/config hashes, JVM properties, listeners and selected API flags.
5. Then measure a finite sync; reproduce 24 fixture transactions, all 65 output
   fields/IDs, order and roots with ancestry to a captured fully validated tip.
   HTTP success/matching fixtures alone cannot establish validation/membership.
6. Authenticate contiguous ranges/publication order before replay/adoption,
   openings and certificates; see [recovery map](docs/POOL_V3_RECOVERY_MAP.md).
   Fix v3 artifact/config pins, integrate runtime/wallet and rerun six real proofs.

## Open questions

- Earlier exact CPU-time containment is still failed. New CPU-rate scheduling
  does not reinterpret it. No full sync, hostile parsing, hard filesystem/network
  isolation or production node/JRE suitability is established. Runtime remains
  v2, rejects silence clauses and has no pool wallet.
- About **45% done / 55% remaining**, plausible done range **35–55%**. This startup
  evidence does not close a product gate. Largest work: evidence/replay/config,
  v3 runtime, wallet/transport, authenticated ranges, publication and custody.
- Deployment, releases, access changes and real funds remain outside standing
  authorization.
