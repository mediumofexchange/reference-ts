# Current work

Updated: 2026-09-22

## Goal

Last slice (delivered): recovery-map P2, publication and
reassembly on a node. Publish a complete release (15,498 bytes, four pieces)
through the public Ergo **testnet** node under the candidate profile layout,
spend its boxes and read it back as block-section evidence through the model
verifier. Acceptance: an explicit testnet-only experiment (never run by
`check` or CI) whose retained report records node acceptance, measured
box/transaction bytes, minimum values and fee (§7); the reassembled kind-4
answer in a stated same-index order; a duplicate read as two witnessings;
reordered, partial and merged runs not decoding while separated ones do
(A11); retrieval after the boxes are spent; per-transaction submission and
inclusion heights (A10). Docs agree; one independent review; merged and
pushed with CI green. Stop boundary: no mainnet or real funds, no profile
selection, no specification, runtime or dependency change.

## Status

- Delivered: `experiments/ergo-range/publish.mjs` (testnet-only; dry-run
  and live modes; state file, pinned creation height and `--resume`),
  reviewed by one opus lane before the run (two blockers, eight material
  findings, all applied). Live run 2026-09-22 on the public testnet node;
  its report is retained as `docs/ergo-publication-verification.json`
  (the dry-run report is in Git history). Probes, profile, recovery map
  (§7, A10, A11, P2), status and experiment guide carry the live numbers.
- Reviewed: one independent check of the live report against every changed
  claim and the code paths behind them found no discrepancy.
- Throwaway wallet: key in ignored `scratch/ergo-testnet/wallet.json`
  (address `3WzLhpY2Dbd8WSbvZTbHS5cbCiJFsfbLFrfoWWEt3GkQJJr6oxi9`, about
  19,999.99 tERG after the run); a byte-identical copy is kept outside the
  repository. Faucets are unreliable, so sweep experiment boxes back and
  spend only fees. Testnet transactions need no further approval.

## Evidence

- Testnet run: all seven transactions accepted on first submission at
  exactly the node dust minimum (`minValuePerByte` 360 over full box
  bytes): full piece box 4,095 bytes at 1,474,200 nanoERG, release
  transaction 16,077 bytes (dry run 16,075: the change value VLQ), fee
  1,100,000. The six cases landed in block 558,329, the 25-input sweep in
  558,333, each two blocks above the tip at submission (lag 3 at depth 2).
  After the sweep no piece box was served unspent and the indexed view
  named the sweep for each; the verifier over the window 558,328–558,333
  answered seven objects at one index in transaction-then-output order,
  decodable exactly where the profile says. The run cost 7,700,000 nanoERG.
- Limits: testnet, one public node for submission and headers; latency is
  two correlated observations, not a distribution; the refusal side of the
  dust rule was not exercised; publication content is synthetic.

## Next

1. Choose the next slice. Candidates: an A10 latency distribution from repeated independent
   testnet submissions (cheap now that the wallet is funded); an
   authenticated header source for the profile; decoder containment; the
   wallet/custody boundaries below.

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
2026-09-22: the venue cost is measured and small and P2 is done on the
testnet; selection still needs an authenticated header source and decoder
containment. Runtime integration, selected venue/decoder, qualified custody
and continuous wallet operation dominate remaining effort.
