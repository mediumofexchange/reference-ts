# Slice 44 probe result (disposable)

`witness-probe.jsonl`: [the 10⁶ run's witness probe](https://github.com/mediumofexchange/reference-ts/tree/9cc291c/scripts/pool/v3/design-point-1e6),
unchanged, run as `node --expose-gc witness-probe.mjs --leaves 20 --every 8 --spend --from 15` on the runtime at `e3c314e`
(spent witnesses dropped, a completed block rewritten a page at a time), beside the unit suite for its first 14 minutes.
Kept at this revision only so [the probes section](../../../../docs/POOL_DEPLOYMENT_PROBES.md#a-wallets-spent-witnesses-dropped-slice-44)
can cite it; it is deleted in the next commit.
