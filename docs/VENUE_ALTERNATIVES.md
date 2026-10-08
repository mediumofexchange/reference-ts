# Alternative venues and backing assets (research, 2026-10-05)

Read-only research. Measured facts carry a source and date; judgments are marked as such.

## 1. Two roles

- **Venue**: where kind 1–4 records (commitment, replacement, revocation, publication) are witnessed and ordered. It is the protocol's only clock (C2.3, pool-v3 §13).
- **Backing asset**: what a payout pays in or a reliance requires. A chain's native asset held on its own chain is **not a backing**. It is a *nameable term* that is never wrapped (paper §10, Construction glossary "chain asset", invariant 18; already decided [2026-08-27](../decisions/2026-08.md#2026-08-27--venues-ergo-is-queued-bitcoin-is-the-direction-after-it)).

The two roles can differ. The pool-recovery contract covers only payouts that settle outside the claim layer (pool-recovery §scope). So today any chain asset can be a payout term without a venue integration. Atomic chain-asset legs are different: C3 step 1 says "a chain-asset leg locks in an escrow on the decision venue". They therefore need the asset's chain to be the decision venue, or a cross-chain construction.

## 2. What a venue must provide (from the specification)

1. **One total order with a witnessed index**, and for kind 4 an ordinal within the index (pool-v3 §13.1, C2b.4.2). Time is that index, never wall-clock time.
2. **A named finality rule and lag** that form part of the venue's identity (C2.3.2, C2.3.5). The lead floor is 2·lag+1 (C2.5.3) and the C3.3 window is set by depth.
3. **Absence proven by exhaustion** over authenticated evidence. Inclusion proofs and a source's word do not count (pool-v3 §13.2). Revocation and the replacement chain are read **from index zero** (§13.3), so the reader's cost grows with deployment age.
4. **Carriage**: kinds 1–3 are exactly 136, 233 and 96 bytes. The kind-4 parser bound is 131,914 bytes. The largest v3 publication is 15,498 bytes and the largest lit-v1 publication is 569 bytes (venue-ergo §8, lit-v1 §10). venue-ergo also makes each kind-4 object a run within one transaction.
5. **Open publication**: holders publish releases and demands themselves. A venue that censors stops every clock (Construction failure table), and an obscure venue degrades load(z) (C2.3.1).
6. **Attribution by location and shape only**, with no content rules (§13.1).
7. **Profile choices, not construction requirements**: readers verify headers themselves (venue-ergo §3), and sections are authenticated by the header's transaction root (§4).
8. **No on-venue script is needed by the current profile.** Records are R4/R5 bytes at an exact tree, and whoever spends a box takes its value (venue-ergo §§1, 6). Scripts matter only for chain-asset escrows (C3) and for any future proportional range source.
9. **Lock-in and cohesion.** A backing leaves its venue only through a successor and a swap, because no record moves a venue (C2.3.1, venue-ergo §9, WORK Next 9). Backings presented together must share one venue (invariant 24; "a scope never spans independent venue clocks"). Every added venue therefore splits presentation sets.

## 3. Comparison

Attack cost uses crypto51's 1-hour rental model, which is not a measured attack (crypto51.app, updated 2026-10-05). "Exhaustion" means the bytes a reader must fetch per day to prove absence.

| Chain | Consensus / decentralization (measured) | Carriage for records | Exhaustion bytes/day | Phone header check | Fit (judgment) |
|---|---|---|---|---|---|
| **Ergo** | Autolykos PoW, 581 GH/s, **$28/h**, 8% rentable. **One payout address mined 51.0% of the last 700 blocks and the top two 78.3%** (explorer API, heights 1,887,502–1,888,201, 2026-10-04/05). Market cap about $20–27M (CoinGecko/Coinlore, 2026-10). | 4,096 B per box, 95,910 B per transaction; fits every kind (venue-ergo §8). Fees are cents. | About 4.1 MB of sections (P4, 2026-09 window); headers 159 KB/day | Yes. Autolykos v2 headers; NiPoPoW interlinks exist; the header **state root** commits the UTXO set | Best technical fit, weakest security budget |
| **Bitcoin** | SHA-256d. $1.88M/h. Top pools by blocks over one week (mempool.space, 2026-10-05): Foundry 27.2%, AntPool 20.4%, F2Pool 16.0%, ViaBTC 10.0%; the top four hold 73.6%. AntPool proxy pooling is estimated at about 40% ([b10c, 2025-04](https://b10c.me/blog/015-bitcoin-mining-centralization/)) | Core v30 (2025-10-10) relays OP_RETURN up to 100 KB and allows several per transaction. Taproot witness costs 0.25 vB/B. The BIP-110 data-limit soft fork split off with about 2.5% of hashrate on 2026-08-07, mined two blocks and stalled | **About 236 MB full / 118 MB without witness** ([probe 2](#results-of-probes-1-and-2-slice-16)); headers 11.5 KB/day | Yes, SHA-256d with 80-byte headers. No UTXO commitment | Strongest order; costly exhaustion |
| **Litecoin** | Scrypt, merged-mined with Doge. $71.7k/h, 7% rentable. Pools F2Pool, ViaBTC, AntPool | Older OP_RETURN policy (not re-verified); witness envelopes used by LTC-20 | Small blocks (not measured) | Yes (80 B) | Plausible cheap PoW fallback; weaker ethos |
| **Bitcoin Cash** | SHA-256 minority. **$5.6k/h** against BTC-scale hashrate | 223 B OP_RETURN per transaction in total (policy) | Small | Yes | Attack cost too low against BTC miners |
| **Monero** | RandomX. **Qubic took a majority in Aug 2025, with 6- and 18-block reorgs** ([CoinDesk 2025-08-12](https://www.coindesk.com/business/2025/08/12/monero-s-51-attack-problem-inside-qubic-s-controversial-network-takeover)) | tx_extra relay limit **1,060 B** ([PR #8733](https://github.com/monero-project/monero/pull/8733)). lit fits; a v3 release does not | Moderate | RandomX verification needs a 256 MiB cache, heavy for a phone (judgment) | Strong money ethos as an asset; poor venue |
| **Zcash** | Equihash ASIC. $79.5k/h. Crosslink PoS hybrid has **no activation height** (Aug 2026) | 512 B encrypted memo per output; small transparent data | Moderate | **FlyClient commitments (ZIP 221)** | Consensus is in transition; a PoS change would mean a new venue context |
| **Cardano** | Ouroboros Praos PoS; parameters changeable by on-chain governance (CIP-1694) | Max transaction **16,384 B**, fee 0.155381 ADA + 44 lovelace/B (Cardano docs). A 15,498 B release is tight to impossible in one transaction (unmeasured) | Moderate | **No.** Praos leader checks need the epoch stake distribution; Mithril substitutes stake-signer trust | Closest model (eUTXO) but breaks "reader verifies work from headers" |
| **Kaspa** | GHOSTDAG at 10 blocks/s. **$4.5k/h**, 10% rentable | Payloads enabled (Crescendo) | Very high; **nodes prune after about 30 h**, so reads from index zero need archival suppliers | 864k headers/day | Not now |
| *Ethereum (contrast)* | PoS with an economic-finality gadget; issuance not fixed by rule | Calldata is durable; **blobs are pruned after about 18 days**, so they fail reads from index zero | Receipts per block | Sync committee of 512 signers | Ethos and trust model mismatch |

Sidechains, Liquid (federated), Lightning and ecash (Fedimint, Cashu) give no independent ordering, so none of them is a venue.

## 4. Recommendation

**Is Ergo enough?** Ergo is enough for development, testnet and small-value pilots. It is not enough as the only venue for material value. Technically it fits best of all candidates: small sections, 4 KB boxes, every kind fits one transaction, scripts, and a UTXO state root. But its security budget is very small: $28/h on crypto51's model, and one address mined 51% of blocks over the last day. A majority miner can reorganize past depth 10, which is a venue failure for every backing on Ergo. Such a backing cannot leave except through a successor and a swap (§2 item 9). Before real value depends on it, either add a second venue profile or define the venue-moving record (WORK Next 9). That record would be a construction decision under C2.3.1 and C0a.

**Second venue: Bitcoin.** This agrees with the 2026-08-27 direction and adds new evidence:
- *For Bitcoin:* it has the deepest PoW by four orders of magnitude, practically no deep reorgs, and cheap header verification. Depth 2–3 (a lag of 30–40 min, with high variance) plausibly gives more safety than Ergo at depth 10. Core v30 removed the 80-byte OP_RETURN obstacle, so kinds 1–3 fit in one OP_RETURN each, and a kind-4 run maps onto adjacent OP_RETURN outputs, as on Ergo. The chain is also the native home of the most widely held asset, which is a prerequisite for atomic BTC legs (C3).
- *Against Bitcoin:* (a) §13.2 exhaustion costs about 118 MB/day if records sit in OP_RETURN, or about 236 MB/day if they sit in the witness ([probe 2](#results-of-probes-1-and-2-slice-16)). That is 29–58× Ergo's sections. A year from the anchor is about 43–86 GB, so a Bitcoin reader is a desktop or server role, not a phone. The 2026-08-27 plan to "anchor roots, serve leaves" does not avoid this, because absence still needs exhaustion. (b) The data policy is contested at the social layer. BIP-110 failed, but filtering nodes (Knots, 21% of reachable nodes in Aug 2025) and pool policy could delay records. (c) Cost: about 1,000 sats per KB in OP_RETURN, or about 250 sats in witness, at 1 sat/vB (mempool.space recommended 1 sat/vB on 2026-10-05). It is about 50× that at spikes; July 2025 reached 265 sat/vB.
- *Security note for a Bitcoin profile:* the section rule must refuse Bitcoin's duplicated-last-leaf Merkle mutation (CVE-2012-2459) and 64-byte-transaction ambiguity. It must also bind the witness commitment if records sit in the witness.

**Cheapest decisive probes, in order:**
1. *Offline policy probe* (hours, GET only). Over the last 2,016 mainnet blocks, count OP_RETURN outputs larger than 83 B and multi-OP_RETURN transactions, grouped by pool tag. **It falsifies the plan** if major pools exclude them, which would leave only the witness envelope, itself censorable by the same filters.
2. *Exhaustion probe* (a P4 analogue). Fetch about one week of blocks from two suppliers, verify headers and the txid/wtxid Merkle roots with our own code (no library decoder), and frame every transaction. Record bytes, time and memory against a desktop budget.
3. *Publication probe* on signet or testnet4, then mainnet with dust: inclusion latency of 136 B and 15.5 KB records against fee, at depth 2–3, inside the C3.3 window.

### Results of probes 1 and 2 (slice 16)

Measured 2026-10-08 with our own parser and verifier (no library decoder; [tooling and result](https://github.com/mediumofexchange/reference-ts/tree/1ddf862/scripts/venue/bitcoin-probes)), GET only. The window is heights 968,489–970,504: 2,016 blocks below tip−6, 13.5 days. Pools are as mempool.space attributes them. Every count excludes the coinbase's own outputs. [Decision](../decisions/2026-10.md#2026-10-08--keep-bitcoin-as-the-second-venue-direction-its-records-are-delayed-by-a-third-of-blocks-not-excluded-and-its-reader-exceeds-the-declared-transfer-budget-slice-16).

**Probe 1 does not falsify the plan; it finds delay, not exclusion.**
- *Filtering pools:* the pools sharing AntPool's templates (AntPool 415 blocks, SECPOOL 87, Luxor 63, BTC.com 24, Binance Pool 16, WhitePool 6, Poolin 2, ULTIMUSPOOL 1) mined 614 blocks (30.5%). None of those blocks holds an OP_RETURN script over 83 B or a transaction with two OP_RETURN outputs, and their largest OP_RETURN is exactly 83 B. Their block share predicts 241 such blocks for AntPool alone (binomial lower tail 3·10⁻¹⁵⁷), 50 for SECPOOL (2·10⁻³³) and 37 for Luxor (2·10⁻²⁴).
- *Including pools:* Foundry, F2Pool, ViaBTC, SpiderPool, MARA, NiceHash, Braiins and unattributed blocks together mined 1,342 blocks (66.6%). Braiins (27 blocks) mined single large OP_RETURNs but no multi-OP_RETURN transaction (0 against 5.9 expected, 1·10⁻³). OCEAN (60 blocks, 3.0%) mined them at 40% of its share.
- *Volume:* the window holds 13,280 OP_RETURN outputs over 83 B, 9,840 of at least 139 B (a kind-1 record's script) and 243 of at least 1,000 B. The largest is 33,351 B (Foundry), and SpiderPool mined one of 15,507 B, the largest v3 publication's size. There are 895 multi-OP_RETURN transactions. 58% of all blocks, and 89% of Foundry's, hold at least one OP_RETURN over 83 B.
- *Witness envelopes* (taproot `OP_FALSE OP_IF` scripts, a heuristic) appear in 96.9% of blocks, at every pool's share except OCEAN's (21 blocks against 58 expected). AntPool's group mines them.
- *Delay model (judgment):* if a third of blocks will not include a record, its wait for an including block is geometric. The mean is 1.5 blocks, not 1. The chance of waiting three or more blocks longer is 0.334³ ≈ 3.7%, and of six or more about 0.14%. If Foundry joined the filtering group, about 41% of blocks would remain. These figures count OCEAN as excluding although it includes some, so they are conservative: the AntPool group alone gives a mean of 1.44 blocks and 2.8%.
- *Confound:* the probe shows that pools mine large OP_RETURN outputs, not that they mine ones relayed through the public mempool. Out-of-band submission to a pool could explain part of the including pools' rate. The read-only probe 3 tests this.

**Probe 2: exhaustion is cheap to verify and costly to transfer.** The week is heights 969,497–970,504 (1,008 blocks, 6.69 days). It was fetched from mempool.space and from blockstream.info, and the two were byte-identical. Every block was parsed by our own code: each transaction framed, txid and wtxid recomputed, the Merkle root checked with CVE-2012-2459's duplicated pair refused, the BIP141 witness commitment, BIP34 height, weight and proof of work. The window held no 64-byte transaction. The headers from 967,680 to tip−6 (970,504) were checked for links, BIP113 median time, constant bits within a period, and the retarget at 969,696 recomputed exactly; the 809 below the window were rebuilt from supplier fields and checked against their ids. That chain is **not anchored**. Each header's proof of work is checked against its own bits, the first period's bits are the supplier's, and neither cumulative work nor a known hash is checked. So the evidence here rests on the two suppliers agreeing, which is not §13.2's authenticated evidence. A Bitcoin profile needs an anchor and a minimum of cumulative work. On an Intel Xeon at 2.10 GHz under Node 24.21.0:

| Per day (week) | Measured | Reader budget ([declared](PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets)) |
|---|---|---|
| Blocks, transactions | 150.7, 719,642 | |
| Bytes, records in OP_RETURN (blocks without witness) | 118.5 MB | ≤ 50 MB transferred: **2.4× over** |
| Bytes, records in the witness (full blocks) | 236.4 MB | **4.7× over** |
| Verification CPU (one thread) | 11.5 s (median 66 ms a block, p99 170 ms, max 253 ms) | ≤ 10 CPU-minutes: the venue part fits |
| Peak process memory, four blocks in flight | 375 MiB | ≤ 1 GiB for the whole reader: the venue part alone |

The budgets are the whole reader's, and the table compares the venue part alone. The transfer figure already fails without the reader's other transfers. A year from the anchor is about 43 GB without witness or 86 GB in full. Three years from index zero is about 130 GB without witness: roughly 3 h at the reader's 100 Mbit/s and 3.5 CPU-hours on one thread. Added to the pool's modelled first sync of 15.5–20.5 h, that gives about 19–24 h, at the edge of the 24 h budget (estimate). Per-day figures use timestamp days (150.7 blocks a day against the long-run 144), so the yearly figures run about 5% high. The two explorer suppliers serve only full blocks, so a reader of blocks without witness needs peer-to-peer suppliers, which serve them. Through the cloud proxy, one stream fetched a block in a median of 0.7 s.

**Limits.** This is one fortnight's policy snapshot. Pool attribution is the supplier's, and grouping the template users with AntPool follows b10c; Poolin, ULTIMUSPOOL and WhitePool have too few blocks to judge. The envelope count is a heuristic: it does not check that the prevout is taproot, and it can match `00 63` inside pushed data. OCEAN's envelope shortfall may partly reflect its smaller blocks. The parser counts 64-byte transactions and does not refuse them. Its BIP34 check accepts a height push that is not minimal. The self-test's refusals cover proof of work, height, trailing and truncated bytes, the Merkle root, the witness commitment and the duplicated pair. The review confirmed the chain's median-time, bits and retarget refusals. Refusals of a broken link, the segwit flag, varints, a superfluous witness, coinbase position and weight are untested. The delay model assumes independent blocks and a sufficient fee; the inclusion latency of a real record is probe 3's. Memory was not tuned to one block at a time.

**Spec and code if it passes:** a new normative `venue-bitcoin.md` (context such as `moe/venue/bitcoin/v1`, anchor, depth, exact-scriptPubKey or OP_RETURN-prefix locations, transaction grammar with segwit, section/root rule, retarget and timewarp header rules, ordinal, fork rule), mirroring venue-ergo §§1–10. Code: `bitcoin-headers.ts`, a framer, a `BitcoinVenue` implementing `RecordVenue`, and reference contexts (regtest or synthetic) in the v3 guard. **Construction changes: none for the venue itself**, which agrees with 2026-08-27. Two venues do raise the priority of the venue-moving record and of accepting that sets will split.

**Do not pursue now:** Cardano (PoS headers are not verifiable alone; tight transaction size), Kaspa (pruning, cheap attack), BCH (cheap attack), Monero and Zcash as venues. Litecoin is the fallback if Bitcoin's data policy fails probe 1. An Ergo-only alternative for the phone gap: a range source proportional to a subject's records, built on Ergo's **state root**. It would use a script-guarded box chain, with unspentness proven against a header, but it needs scripts and a new venue identity (WORK Next 9; not evaluated here).

## 5. Backing assets (terms, not backings)

These assets fit the ethos as chain-asset **terms**, held natively and never wrapped.

- **BTC (primary).** Fixed supply and the largest independent holder base. Atomic legs are easiest with Bitcoin as the decision venue.
- **XMR.** Strongest privacy and money ethos. It has no scripts, so escrow is only possible through adaptor-signature swaps; it fits payouts that settle outside the claim layer.
- **LTC.** A payments chain with MWEB privacy. Its ethos is weaker and its mining concentrated.
- **ZEC.** Privacy-focused, but its PoS transition and dev-fund governance are open.
- **ERG.** Natural for fees and same-chain escrow, but thin liquidity.

**Wrapped or bridged assets are not chain assets.** At best each is a custodian's backing and must be declared as one (paper §10). Before any atomic chain-asset leg, settle the cross-chain question noted on 2026-08-27: Bitcoin offers HTLCs, not C3's general lock and settle.

## Sources
- crypto51.app (2026-10-05); mempool.space API `/v1/mining/pools/1w`, `/v1/mining/blocks/sizes-weights/1m` and `/v1/fees/recommended` (2026-10-05); Ergo explorer API `/api/v1/blocks` (2026-10-05).
- [b10c, Bitcoin mining centralization 2025](https://b10c.me/blog/015-bitcoin-mining-centralization/); [Core v30 OP_RETURN](https://en.cryptonomist.ch/2025/10/13/bitcoin-core-update-v30-op-return-limit-controversy/); [BIP-110 rules](https://studyknots.com/guides/bip-110); [BIP-110 split](https://cryptobriefing.com/bip-110-nodes-fork-bitcoin-chain-split/).
- [Monero PR #8733](https://github.com/monero-project/monero/pull/8733); [Qubic and Monero](https://www.coindesk.com/business/2025/08/12/monero-s-51-attack-problem-inside-qubic-s-controversial-network-takeover); [Kaspa Crescendo](https://github.com/kaspanet/rusty-kaspa/releases/tag/v1.0.0).
- [Cardano fees](https://developers.cardano.org/docs/developers/curriculum/fundamentals/core-concepts/fees/); [Zcash FlyClient and Crosslink](https://zcash.readthedocs.io/en/latest/rtd_pages/nu_dev_guide.html); [BCH OP_RETURN](https://www.chaincatcher.com/en/article/2185522); [Ergo NiPoPoWs](https://docs.ergoplatform.com/dev/protocol/nipopows/); [Ergo market data](https://www.coingecko.com/en/coins/ergo).
- Not re-verified, from background knowledge: Litecoin's OP_RETURN policy, Praos stake-distribution validation, Ethereum blob retention, and the CVE-2012-2459 details.
