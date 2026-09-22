# Current work

Updated: 2026-09-22

## Goal

Active slice: the decoder dependency decision the P4 measurement made a
prerequisite of venue selection. Choose and pin, for `experiments/ergo-range`,
a sigma-rust build that reads the chain's current script versions and keeps
any sized tree it cannot parse as exact bytes, and record the decision with
its alternatives and the gate any later pin move must pass. Acceptance: the
experiment pins the chosen build by lockfile integrity and public commit;
`npm run check:ergo:range` passes with the decoder corpus extended by a real
Ergo 6.0 block (header version 4, ErgoTree header version 3 outputs) and by
synthetic sized trees of every header version with unparseable bodies, each
read as its exact slice after an exact round trip; the profile check
reproduces the new fixture's root beside the three existing ones; the P4
window is re-read offline from the cache under the new pin with zero
refusals and every root reproduced, with the old build as the control; the
`--ergo` local replay report is regenerated under the new lock; the decision,
profile doc, probes, recovery map and implementation status agree; one
independent adversarial review of the decision and the patch, findings
resolved; merged and pushed with CI green. Evidence limits: containment is
unchanged (no hard memory bound); node equivalence is still shown only over
the fixtures and one mainnet week, not proved; the chosen build is a
pre-release with no maintenance promise. Stop boundary: no profile
selection, no specification change, no runtime decoder path, no header-source
authentication, no P2 publication, no dependency change outside the
experiment.

## Status

- Decided and recorded: [the decision](decisions/2026-09.md#2026-09-22--pin-a-sigma-rust-build-that-keeps-every-sized-tree-as-exact-bytes)
  pins `ergo-lib-wasm-nodejs@0.29.0-alpha-2f840d3` (npm alpha, sigma-rust
  2f840d3) in `experiments/ergo-range`; `decoder.mjs` is unchanged. 0.28.0
  refuses an Ergo 6.0 tree at its header before reading the size; the alpha
  accepts header versions 0–7 and keeps a sized tree it cannot parse as the
  exact slice. No 0.29.0 stable exists; upstream `develop`'s extension
  re-ordering (19255a6) is a round-trip refusal risk any later pin move must
  pass three gates against (corpus, offline window re-read, `--ergo` replay).
- Delivered in the working tree: pin and lockfile; fixture block 1876512
  (header v4, two v3 trees) agreeing with the two-node P4 cache; corpus cases
  rewriting each sized tree to every header version with real and zeroed
  bodies, coverage counts and WASM hash pinned; child budget 30 s → 120 s;
  reports regenerated (block probe 414, corpus 20,050, profile 277,
  chain-cost offline re-read, replay 223 groups / 65 real proofs / 112
  through the Ergo adapter); docs, recovery map A8, implementation status,
  README, CI budget (45 min) and index updated.
- Review (one opus lane): two blockers (replay report not yet regenerated
  when the entry claimed it; a wrong statement about 0.28.0's `Unparsed`
  fallback) and six material findings, all applied; the lane reproduced the
  decoder and block reports byte for byte. `npm ci` from the lockfile
  reproduces the three experiment reports.
- Delivered: `main` d913edd, CI run 35727316803 green; pool-v3 took 13.5
  minutes on both runners, the prior baseline (the 45-minute budget is slack).

## Evidence

- Chain-cost re-read (retained report): the alpha reads all 5,040 sections,
  every root reproduced, 28,071 views equal to the 0.28.0 control (which
  refuses 125 transactions in 58 blocks); every index resolved, so the day's
  and week's requests answer empty; decode 253 s (alpha) against 39 s
  (control), verifier built in 1.3 s; replay 18.5 min locally under load,
  13.5 min on CI.
- No containment evidence binds the pinned build (the containment and
  metering probes cannot run against it as documented). Prior slice: 83dbeb1.

## Next

1. Finish this slice (above), then P2 node publication and reassembly, which
   also gives A10's inclusion latency; or the wallet/custody boundaries below.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  venue/digest authentication are modeled. Offline handoff freezes the source
  and binds one destination; old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): preflight fails;
  qualified hardware, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority.
- Ergo node is stopped. Retain the detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and verified
  parameter/tool caches. Do not delete the image or allocate another.
  [Sync handoff](docs/ergo-node-sync-resume-verification.json): headers 97,923;
  full heights null/unresolved. The week's cached node responses
  (`scratch/ergo-chain/`, digest in the report), `scratch/sigma-alpha/` and
  the `scratch/sigma-0.28.0/` control can be regenerated; keep the cache.
- Legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-22: the venue cost is measured and small; selection still needs P2,
an authenticated header source and decoder containment. Runtime integration,
selected venue/decoder, qualified custody and continuous wallet operation
dominate remaining effort.
