# Bitcoin venue probe 3, read-only (Next 12, slice 17)

Disposable tooling for the [research's](../../../docs/VENUE_ALTERNATIVES.md#4-recommendation) read-only probe 3; it
retires once the results are recorded there. GET only. Slice 16's probes 1 and 2 used `block.mjs` and retired at
[1ddf862](https://github.com/mediumofexchange/reference-ts/tree/1ddf862/scripts/venue/bitcoin-probes).

- `block.mjs`: slice 16's own block parser and verifier, which now also returns the txids and each record candidate
  (an OP_RETURN over 83 B or several OP_RETURN outputs) with its largest OP_RETURN.
- `selftest.mjs <raw block> <height>`: the real block passes and each hostile variant is refused by its named check.
- `fetch3.mjs <out> [n]`: over probe 2's week (969,497–970,504), verifies every raw block from blockstream.info, checks
  mempool.space's per-transaction summary against the parsed txids, and joins its block audit (projected template,
  first-seen times, unseen and missing lists); resumable.
- `summary3.mjs <out>`: one JSON report: by pool group, records unseen in the public mempool and the probability that a
  block leaves out a record it had in its template, against ordinary transactions of the same fee band; minutes and
  blocks from first sight to inclusion.
