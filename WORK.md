# Current work

Updated: 2026-09-22

## Goal

Active slice: recovery-map P2, publication and reassembly on a node. Publish
a complete release publication (15,498 bytes, four pieces) through the public
Ergo **testnet** node under the candidate profile's layout, spend its boxes,
and read it back as block-section evidence through the model verifier; record
each submitted transaction's inclusion latency (A10; a distribution needs
repeated independent submissions beyond this slice).
Acceptance: an explicit network experiment (`experiments/ergo-range/publish.mjs`,
never run by `check` or CI) that refuses any node not reporting `testnet`,
builds and signs with the pinned sigma-rust from a throwaway key kept in
ignored `scratch/ergo-testnet/`, and records in a retained report: node
acceptance of a four-piece release and the measured box/transaction bytes,
minimum values and fee (§7 sizes); the reassembled kind-4 answer equal to
the publication bytes with its ordinal as transaction position then output
index (a stated same-index order); an exact duplicate read as two
witnessings; reordered, partial and merged-adjacent runs failing to decode
under §6 while separated publications both decode (A11); retrieval from
block sections after the boxes are spent while the UTXO view no longer
serves them; per-transaction submission height, inclusion height and
timestamps. An `--offline` dry run over a synthetic input proves the same
cases without a node. Docs (probes, profile, recovery map P2/A10/A11/§7,
implementation status, experiment guide) agree; one independent review of
the patch and report; merged and pushed with CI green. Evidence limits:
testnet acceptance and latency, not mainnet; the publication's proof bytes
are synthetic where no real settle proof is retained; headers come from one
public node. Stop boundary: no mainnet or real funds, no profile selection,
no specification change unless node acceptance contradicts the profile, no
runtime path, no dependency change.

## Status

- Built and reviewed: `experiments/ergo-range/publish.mjs` (testnet-only;
  dry-run and live modes; state file, pinned creation height and `--resume`).
  The dry run passes and repeats offline from its cache; its report is
  retained as `docs/ergo-publication-verification.json`; probes, profile,
  recovery map (P2, A10, A11, §7), experiment guide and status updated. One
  opus review lane: two live-path blockers (resume after a partial run;
  funding selection for the chain) and six material findings, all applied;
  its readback found two more (rebuild at a new creation height; a live
  `/info` read making the dry run irreproducible), both applied.
- Blocked: the live run needs about 0.05 testnet ERG at the throwaway address
  `3WzLhpY2Dbd8WSbvZTbHS5cbCiJFsfbLFrfoWWEt3GkQJJr6oxi9` (key in ignored
  `scratch/ergo-testnet/wallet.json`); every public faucet was down on
  2026-09-22. Once funded, run
  `node experiments/ergo-range/publish.mjs --out docs/ergo-publication-verification.json`
  and refresh the numbers in probes, profile, recovery map and status.

## Evidence

- Dry run (retained report): release transaction 16,075 bytes, piece boxes
  4,095/4,095/4,095/3,669 bytes; under the node's dust rule (its reported
  `minValuePerByte` 360 over full box bytes) 1,474,200 nanoERG a full piece
  box, 5,743,440 a release, plus the 1,100,000 fee; sigma-rust's
  candidate-only estimate understates by 33 bytes a box; seven objects read
  back at one index in transaction-then-output order, decodable exactly where
  the profile says. The report binds the node's `/info` (ergo-testnet-6.0.3),
  parameters, library pin and model sources.
- Node rules checked against upstream `v6.0.3` or the node: dust over full
  box bytes, monotonic creation height, `chainSlice` is `(from, to]`, indexed
  transactions are confirmed only, the mempool chains. Prior slice d913edd:
  the alpha reads all 5,040 P4 sections; no containment evidence binds it.

## Next

1. This slice; then the wallet/custody boundaries below, or an
   authenticated header source for the profile.

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
