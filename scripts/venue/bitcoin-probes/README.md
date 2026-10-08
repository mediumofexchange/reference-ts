# Bitcoin venue probes 1 and 2 (Next 12, slice 16)

Disposable tooling for the [research's](../../../docs/VENUE_ALTERNATIVES.md#4-recommendation) first two probes; it
retires once the results are recorded there. GET only, from two public suppliers (mempool.space, blockstream.info).

- `block.mjs`: our own block parser and verifier (no library decoder): frames every transaction, recomputes txid
  and wtxid, checks the Merkle root (refusing CVE-2012-2459's duplicated pair), the BIP141 witness commitment,
  BIP34 height, weight and proof of work; `checkChain` checks links, BIP113 median time, bits and each retarget.
  Counts OP_RETURN outputs by script size, multi-OP_RETURN transactions and taproot `OP_FALSE OP_IF` envelopes.
- `selftest.mjs <raw block> <height>`: the real block passes and each hostile variant is refused by its named check.
- `fetch.mjs <out> window pools headers A B`: fixes the window (2,016 blocks below tip−6), takes supplier A's pool
  attribution, fetches and verifies every block from A and the last 1,008 from B; resumable.
- `summary.mjs <out>`: one JSON report: per-pool counts against what each pool's block share predicts (a binomial
  lower tail), bytes and verification time a day, peak memory and the suppliers' agreement.
