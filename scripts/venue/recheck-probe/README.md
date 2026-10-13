# Venue recheck probe (Next 12)

Disposable, read-only tooling for the [venue recheck](../../../docs/VENUE_ALTERNATIVES.md#the-venue-recheck-slice-29); it retires
once the results are recorded there. Builds go to `scratch/recheck-probe/`, fetched blocks to `scratch/recheck/`.

- `block.mjs`: slice 16's own Bitcoin parser and verifier, now counting the SHA-256 compressions of txids, wtxids
  and both Merkle trees.
- `btc-day.mjs <out>`: the 144 blocks below tip−6 from mempool.space, each verified; `btc.jsonl`, `btc-window.json`.
- `leaf.mjs inner | <K> [--witness]`: a chained leaf of K SHA-256 compressions over packed bytes and one recursive
  verification; `time-prove.sh <build>` times its proof (slice 21's script).
- `btc-cost.mjs <out> <seconds>...`: the day priced as a succinct proof of exhaustion, with the weight limit's
  ceiling; `btc-result.json`.
- `cands.mjs <out>`: a day of Litecoin, Dogecoin (with its AuxPoW parsed from raw blocks), Nervos CKB, Alephium and
  Ethereum Classic, and crypto51; `cands-result.json`.
- `model.mjs <dir>`: the comparison, per candidate; `model-result.json`.
