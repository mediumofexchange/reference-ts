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
| **Litecoin, Dogecoin, Nervos CKB, Alephium, Ethereum Classic** | Weighed in the [recheck](#the-venue-recheck-slice-29)'s table (attack cost, miners for a majority); Ethereum Classic suffered 51% attacks in August 2020 (background) | Litecoin and Dogecoin by policy: 83 B OP_RETURN, 1,650 B scriptSig, 520 B a push (LTC-20 uses Litecoin's witness envelopes; Dogecoin has no segwit). CKB's cells carry data; Ethereum Classic has calldata | In the recheck; Litecoin 69.3 MB in full | In the recheck | In the recheck |
| **Bitcoin Cash** | SHA-256 minority. **$5.6k/h** against BTC-scale hashrate | 223 B OP_RETURN per transaction in total (policy) | Small | Yes | Attack cost too low against BTC miners |
| **Monero** | RandomX. **Qubic took a majority in Aug 2025, with 6- and 18-block reorgs** ([CoinDesk 2025-08-12](https://www.coindesk.com/business/2025/08/12/monero-s-51-attack-problem-inside-qubic-s-controversial-network-takeover)) | tx_extra relay limit **1,060 B** ([PR #8733](https://github.com/monero-project/monero/pull/8733)). lit fits; a v3 release does not | Moderate | RandomX verification needs a 256 MiB cache, heavy for a phone (judgment) | Strong money ethos as an asset; poor venue |
| **Zcash** | Equihash ASIC. $79.5k/h. Crosslink PoS hybrid has **no activation height** (Aug 2026) | 512 B encrypted memo per output; small transparent data | Moderate | **FlyClient commitments (ZIP 221)** | Consensus is in transition; a PoS change would mean a new venue context |
| **Cardano** | Ouroboros Praos PoS; parameters changeable by on-chain governance (CIP-1694) | Max transaction **16,384 B**, fee 0.155381 ADA + 44 lovelace/B (Cardano docs). A 15,498 B release is tight to impossible in one transaction (unmeasured) | Moderate | **No.** Praos leader checks need the epoch stake distribution; Mithril substitutes stake-signer trust | Closest model (eUTXO) but breaks "reader verifies work from headers" |
| **Kaspa** | GHOSTDAG at 10 blocks/s. **$4.5k/h**, 10% rentable | Payloads enabled (Crescendo) | Very high; **nodes prune after about 30 h**, so reads from index zero need archival suppliers | 864k headers/day | Not now |
| *Ethereum (contrast)* | PoS with an economic-finality gadget; issuance not fixed by rule | Calldata is durable; **blobs are pruned after about 18 days**, so they fail reads from index zero | Receipts per block | Sync committee of 512 signers | Ethos and trust model mismatch |

Sidechains, Liquid (federated), Lightning and ecash (Fedimint, Cashu) give no independent ordering, so none of them is a venue. Merged-mined chains import only the hashrate that chooses to merge-mine them: Fractal Bitcoin, merged with Bitcoin, rents for $316/h (crypto51, 2026-10-13), so Namecoin and its kind are not weighed further.

## 4. Recommendation

**Is Ergo enough?** Ergo is enough for development, testnet and small-value pilots. It is not enough as the only venue for material value. Technically it fits best of all candidates: small sections, 4 KB boxes, every kind fits one transaction, scripts, and a UTXO state root. But its security budget is very small: $28/h on crypto51's model, and one address mined 51% of blocks over the last day. A majority miner can reorganize past depth 10, which is a venue failure for every backing on Ergo. Such a backing cannot leave except through a successor and a swap (§2 item 9). Before real value depends on it, either add a second venue profile or define the venue-moving record (WORK Next 9). That record would be a construction decision under C2.3.1 and C0a. The [recheck](#the-venue-recheck-slice-29) weighs both: neither defends a backing against a majority miner already attacking, the record serves only foreseen failure, and a deeper depth helps only against a minority key, at the price of another venue.

**Second venue: Bitcoin.** This agrees with the 2026-08-27 direction and adds new evidence. Since [slice 20](#absence-for-one-subject-slice-20) it is the desktop and backer venue only; a phone reaches it only through about ten provers in parallel ([recheck](#the-venue-recheck-slice-29)), and Dogecoin is the one candidate a phone could reach at about Ergo's prover cost:
- *For Bitcoin:* it has the deepest PoW by four orders of magnitude, practically no deep reorgs, and cheap header verification. Depth 2–3 (a lag of 30–40 min, with high variance) plausibly gives more safety than Ergo at depth 10. Core v30 removed the 80-byte OP_RETURN obstacle, so kinds 1–3 fit in one OP_RETURN each, and a kind-4 run maps onto adjacent OP_RETURN outputs, as on Ergo. The chain is also the native home of the most widely held asset, which is a prerequisite for atomic BTC legs (C3).
- *Against Bitcoin:* (a) §13.2 exhaustion costs about 118 MB/day if records sit in OP_RETURN, or about 236 MB/day if they sit in the witness ([probe 2](#results-of-probes-1-and-2-slice-16)). That is 29–58× Ergo's sections. A year from the anchor is about 43–86 GB, so a Bitcoin reader is a desktop or server role, not a phone. The 2026-08-27 plan to "anchor roots, serve leaves" does not avoid this, because absence still needs exhaustion. (b) The data policy is contested at the social layer. BIP-110 failed, but filtering nodes (Knots, 21% of reachable nodes in Aug 2025) and pool policy could delay records. (c) Cost: about 1,000 sats per KB in OP_RETURN, or about 250 sats in witness, at 1 sat/vB (mempool.space recommended 1 sat/vB on 2026-10-05). Since 2025 the busiest block median was 13 sat/vB, and the 2024-04-20 halving reached medians of 491–1,178 sat/vB (mempool.space fee-rate history, [slice 20](#absence-for-one-subject-slice-20)).
- *Security note for a Bitcoin profile:* the section rule must refuse Bitcoin's duplicated-last-leaf Merkle mutation (CVE-2012-2459) and 64-byte-transaction ambiguity. It must also bind the witness commitment if records sit in the witness.

**Probes.** The policy and exhaustion probes ran as [probes 1 and 2](#results-of-probes-1-and-2-slice-16), and the publication probe's read-only part as [probe 3](#results-of-read-only-probe-3-slice-17); its mainnet publication was dropped (2026-10-13). The plan as written: [at 05337cf](https://github.com/mediumofexchange/reference-ts/blob/05337cf/docs/VENUE_ALTERNATIVES.md#4-recommendation).

### Results of probes 1 and 2 (slice 16)

Measured 2026-10-08 with our own parser and verifier (no library decoder; [tooling and result](https://github.com/mediumofexchange/reference-ts/tree/1ddf862/scripts/venue/bitcoin-probes)), GET only. The window is heights 968,489–970,504: 2,016 blocks below tip−6, 13.5 days. Pools are as mempool.space attributes them. Every count excludes the coinbase's own outputs. [Decision](../decisions/2026-10.md#2026-10-08--keep-bitcoin-as-the-second-venue-direction-its-records-are-delayed-by-a-third-of-blocks-not-excluded-and-its-reader-exceeds-the-declared-transfer-budget-slice-16).

**Probe 1 does not falsify the plan; it finds delay, not exclusion.**
- *Filtering pools:* the pools sharing AntPool's templates (AntPool 415 blocks, SECPOOL 87, Luxor 63, BTC.com 24, Binance Pool 16, WhitePool 6, Poolin 2, ULTIMUSPOOL 1) mined 614 blocks (30.5%). None of those blocks holds an OP_RETURN script over 83 B or a transaction with two OP_RETURN outputs, and their largest OP_RETURN is exactly 83 B. Their block share predicts 241 such blocks for AntPool alone (binomial lower tail 3·10⁻¹⁵⁷), 50 for SECPOOL (2·10⁻³³) and 37 for Luxor (2·10⁻²⁴).
- *Including pools:* Foundry, F2Pool, ViaBTC, SpiderPool, MARA, NiceHash, Braiins and unattributed blocks together mined 1,342 blocks (66.6%). Braiins (27 blocks) mined single large OP_RETURNs but no multi-OP_RETURN transaction (0 against 5.9 expected, 1·10⁻³). OCEAN (60 blocks, 3.0%) mined them at 40% of its share.
- *Volume:* the window holds 13,280 OP_RETURN outputs over 83 B, 9,840 of at least 139 B (a kind-1 record's script) and 243 of at least 1,000 B. The largest is 33,351 B (Foundry), and SpiderPool mined one of 15,507 B, the largest v3 publication's size. There are 895 multi-OP_RETURN transactions. 58% of all blocks, and 89% of Foundry's, hold at least one OP_RETURN over 83 B.
- *Witness envelopes* (taproot `OP_FALSE OP_IF` scripts, a heuristic) appear in 96.9% of blocks, at every pool's share except OCEAN's (21 blocks against 58 expected). AntPool's group mines them.
- *Delay model (judgment):* if a third of blocks will not include a record, its wait for an including block is geometric. The mean is 1.5 blocks, not 1. The chance of waiting three or more blocks longer is 0.334³ ≈ 3.7%, and of six or more about 0.14%. If Foundry joined the filtering group, about 41% of blocks would remain. These figures count OCEAN as excluding although it includes some, so they are conservative: the AntPool group alone gives a mean of 1.44 blocks and 2.8%.
- *Confound:* the probe shows that pools mine large OP_RETURN outputs, not that they mine ones relayed through the public mempool. Out-of-band submission to a pool could explain part of the including pools' rate. The [read-only probe 3](#results-of-read-only-probe-3-slice-17) finds records in the public mempool before mining.

**Probe 2: exhaustion is cheap to verify and costly to transfer.** The week is heights 969,497–970,504 (1,008 blocks, 6.69 days). It was fetched from mempool.space and from blockstream.info, and the two were byte-identical. Every block was parsed by our own code: each transaction framed, txid and wtxid recomputed, the Merkle root checked with CVE-2012-2459's duplicated pair refused, the BIP141 witness commitment, BIP34 height, weight and proof of work. The window held no 64-byte transaction. The headers from 967,680 to tip−6 (970,504) were checked for links, BIP113 median time, constant bits within a period, and the retarget at 969,696 recomputed exactly; the 809 below the window were rebuilt from supplier fields and checked against their ids. That chain is **not anchored**. Each header's proof of work is checked against its own bits, the first period's bits are the supplier's, and neither cumulative work nor a known hash is checked. So the evidence here rests on the two suppliers agreeing, which is not §13.2's authenticated evidence. A Bitcoin profile needs an anchor and a minimum of cumulative work. On an Intel Xeon at 2.10 GHz under Node 24.21.0:

| Per day (week) | Measured | Reader budget ([declared](PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets)) |
|---|---|---|
| Blocks, transactions | 150.7, 719,642 | |
| Bytes, records in OP_RETURN (blocks without witness) | 118.5 MB | ≤ 50 MB transferred: **2.4× over** |
| Bytes, records in the witness (full blocks) | 236.4 MB | **4.7× over** |
| Verification CPU (one thread) | 11.5 s (median 66 ms a block, p99 170 ms, max 253 ms) | ≤ 10 CPU-minutes: the venue part fits |
| Peak process memory, four blocks in flight | 375 MiB | ≤ 1 GiB for the whole reader: the venue part alone |

The budgets are the whole reader's, and the table compares the venue part alone. The transfer figure already fails without the reader's other transfers. A year from the anchor is about 43 GB without witness or 86 GB in full. Three years from index zero is about 130 GB without witness: roughly 3 h at the reader's 100 Mbit/s and 3.5 CPU-hours on one thread. Added to the pool's modelled first sync of 15.5–20.5 h, that gives about 19–24 h, at the edge of the 24 h budget (estimate). Per-day figures use timestamp days (150.7 blocks a day against the long-run 144), so the yearly figures run about 5% high. The two explorer suppliers serve only full blocks, so a reader of blocks without witness needs peer-to-peer suppliers, which serve them. Through the cloud proxy, one stream fetched a block in a median of 0.7 s.

**Limits.** This is one fortnight's policy snapshot. Pool attribution is the supplier's, and grouping the template users with AntPool follows b10c; Poolin, ULTIMUSPOOL and WhitePool have too few blocks to judge. The envelope count is a heuristic: it does not check that the prevout is taproot, and it can match `00 63` inside pushed data. OCEAN's envelope shortfall may partly reflect its smaller blocks. The parser counts 64-byte transactions and does not refuse them. Its BIP34 check accepts a height push that is not minimal. The self-test's refusals cover proof of work, height, trailing and truncated bytes, the Merkle root, the witness commitment and the duplicated pair. The review confirmed the chain's median-time, bits and retarget refusals. Refusals of a broken link, the segwit flag, varints, a superfluous witness, coinbase position and weight are untested. The delay model assumes independent blocks and a sufficient fee; probe 3 measures the inclusion latency of other parties' records. Memory was not tuned to one block at a time.

### Results of read-only probe 3 (slice 17)

Measured 2026-10-08 over probe 2's week (heights 969,497–970,504), GET only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/e8b218f/scripts/venue/bitcoin-probes); [decision](../decisions/2026-10.md#2026-10-08--bitcoins-records-reached-mempoolspaces-mempool-before-mining-size-a-bitcoin-depth-by-the-excluding-third-slice-17)).
- *Blocks:* every raw block came from blockstream.info and was verified by probe 1's parser. The parser also lists each **record**: a transaction with an OP_RETURN over 83 B or several OP_RETURN outputs. These records are other parties' transactions, not ours.
- *Summary:* mempool.space supplied each transaction's fee rate and first sight. The summary was checked to list exactly the parsed txids in order.
- *Audit:* mempool.space also supplied its block audit. That is the template it projected from its own mempool, with first-sight times. *Unseen* lists the block's transactions its mempool never held.
- *Skipped:* a template transaction the audit lists as missing, mempool.space's "censored". It excuses a transaction under 1 sat/vB, one first seen within 180 s, a replaced one, and the template's low-fee tail when the block carried other weight. So skips are a lower bound, and records under 1 sat/vB are never skipped.
- *Thin blocks:* 29 blocks held under half their template's transactions, among them four holding only the coinbase. Their audits list either the whole template or none of it. They are counted apart from every skip figure: OCEAN 14, MARA 6, F2Pool, SECPOOL and AntPool 2 each, and SpiderPool, BTC.com and Binance Pool 1 each.

**Records reached mempool.space's mempool before mining, and the excluding blocks skipped them there.**
- *Seen:* the week holds 5,967 records. Only 5 were unseen, 0.1%, against 6.1% of ordinary transactions in the including pools' blocks. So the records pools mined had reached the public mempool, as mempool.space sees it. This does not show that a record sent only through the public mempool reaches every including pool. A sender may also hand the same record to a pool directly.
- *Skipped while in the template* (excluding thin blocks; the control is ordinary transactions of the same fee band):

| Blocks (week) | Records mined from the template | Record slots skipped | Skip rate, records | Skip rate, ordinary |
|---|---|---|---|---|
| AntPool's template group, 304 (30.2%) | 0 | 2,817 | 100% | 1.7% |
| Including pools, 664 | 5,758 | 42 | 0.72% | 0.42% |
| OCEAN, 27 (13 not thin) | 42 | 34 | 45% | 7.0% |
| Braiins, 13 | 105 | 11 | 9.5% | 1.6% |

  - Foundry (268 blocks, 2,304 records mined), ViaBTC (94), SpiderPool (69) and NiceHash (10) skipped none.
  - MARA skipped every record in 4 of the 27 blocks that held one in their template, and none in the rest.
  - F2Pool skipped 22 of 1,691 slots, one to four at a time. OCEAN skipped every record in 5 of its 12 such blocks.
  - A skip is a block's choice, so slots cluster by block, and rates are per slot, not independent trials.
- *Skips per seen record:* 0.47 by AntPool's group and 0.49 by all blocks. Of the 850 blocks that held a record in their template, outside thin blocks, 241 (28.4%) skipped every one. Slice 16's geometric model then predicts q/(1−q) = 0.40. The measured excess fits the heavier tail below.
- *Mined within L blocks of first sight:* C3.3's margin on Ergo is `depth + 2` blocks ([venue-ergo §2](https://github.com/mediumofexchange/money-from-first-principles/blob/46e6933/venue-ergo.md#2-index-finality-and-lag)).

| Fee band (sat/vB) | Records | L = 1 | 2 | 3 | 6 | Ordinary at L = 1, 3, 6 |
|---|---|---|---|---|---|---|
| 1–2 | 2,341 | 52% | 76% | 89% | 97.3% | 55%, 86%, 95.0% |
| 2–3 | 1,143 | 67% | 86% | 92% | 99.1% | 80%, 97%, 98.5% |
| 3–5 | 1,090 | 60% | 85% | 91% | 99.0% | 83%, 96%, 99.4% |
| 5–10 | 1,083 | 56% | 82% | 88% | 97.0% | 88%, 98%, 99.8% |
| 10–20 | 86 | 47% | 92% | 97% | 100% | 91%, 99.8%, 99.95% |

- *Minutes from first sight to the including block* (median, then p90):
  - Records at 1 sat/vB or more: 10–15 and 33–45. Ordinary transactions: 7–10 and 25–53.
  - One record paid 20 sat/vB or more. Below 1 sat/vB, 111 records were mined, 20% within one block and 68% within six.
  - The records of 1,000 B or more mostly paid under 1 sat/vB.
  - The two of 15.5 KB, each at 1 sat/vB, were mined 150 s and 1,015 s after first sight.
- *Model check (judgment):* take an independent-block model with 28.4% of blocks excluding and the ordinary first-block rate (88% at 5–10 sat/vB). It predicts 63%, 86%, 95% and 99.7% within 1, 2, 3 and 6 blocks. The measured 56%, 82%, 88% and 97.0% fall short at every L, and the shortfall widens in the tail.
- *For a Bitcoin profile (judgment):* a demand that names the latest witnessed instant must be mined within about `depth + 2` blocks of its authorization. First sight comes after proving and propagation, so the shares above are an upper bound on what a demand gets, and the refiling shares below are lower bounds. At these fees, depth 1 (L = 3) would leave at least 4–12% of such demands to be filed again. Depth 4 (L = 6) would leave up to 3%, and none of the 87 at 10 sat/vB or more. Ten-minute blocks make depth 4 roughly 50 minutes of lag.

**Limits.**
- *One observer:* mempool.space's nodes, with their relay policy, which accepts OP_RETURN over 83 B as Core v30 does, their peering, and transactions pushed through its broadcast API. Its first-sight clock and its pool attribution are its own. Its template projection ran under two algorithms (684 blocks under one, 324 under the other).
- *Audits change:* one block's live audit later listed one more skip than the stored copy. A refetch can therefore differ slightly from the result, which hashes its input file.
- *First sight:* in 373 blocks the summary carried no first-sight times, so those blocks' ordinary ages come from template transactions only.
- *Blocks waited:* counted from header timestamps after first sight, with ordinary first sights rounded to the minute. Only transactions mined from the week's 11th block on count, and the count stops at 10.
- *Skips:* only transactions mined within the week count. 24,483 of the 50,568 skip entries were never mined in the week, so records never mined are missing from every figure. Skipped transactions take the template's fee rate for their band, and template inclusions the summary's.
- *Fees:* fee bands are absolute across a week whose fee level moved.
- *Records:* other protocols' transactions, with their own fees, chains of unconfirmed parents and senders. Whether *our* records at a chosen fee behave alike is the mainnet publication's question (Open questions), which this probe does not replace.

**A Bitcoin profile** would be a new normative `venue-bitcoin.md` mirroring venue-ergo §§1–10, and a `BitcoinVenue` under `RecordVenue`; the venue itself needs no Construction change.

**Do not pursue now:** Cardano (PoS headers are not verifiable alone; tight transaction size), Kaspa (pruning, cheap attack), BCH (cheap attack), Monero and Zcash as venues. Litecoin is the fallback if Bitcoin's data policy fails probe 1 (since the [recheck](#the-venue-recheck-slice-29), Dogecoin before it for a phone). An Ergo-only alternative for the phone gap: a range source proportional to a subject's records, built on Ergo's **state root**. It would use a script-guarded box chain, with unspentness proven against a header, but it needs scripts and a new venue identity (WORK Next 9; weighed in [slice 20](#absence-for-one-subject-slice-20)).

### Absence for one subject (slice 20)

Measured 2026-10-12, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/dd827ef/scripts/venue/absence-probes); [decision](../decisions/2026-10.md#2026-10-12--compare-venues-on-what-a-phone-pays-to-prove-absence-for-one-subject-and-probe-a-succinct-proof-of-exhaustion-next-slice-20)). The question ([direction 2026-10-12](../decisions/2026-10.md#2026-10-12--judge-each-slice-against-a-practical-medium-of-exchange-for-ordinary-holders-and-reopen-the-second-venue-direction), item 3): what does a phone pay to prove §13.2 absence for its own subjects? Per backing, a holder has at least three: the backing name (kinds 2 and 4), the operator key (kind 1) and an obligor key (kind 3). §13.3 reads replacements and revocations from index zero, so the first sync grows with the deployment's age and the steady state grows with each day.

**Exhaustion follows the venue's carriage, not the subject's records.** §13.2 proves absence by reading every object the venue holds in the range. On a chain whose blocks commit nothing by subject, that means every transaction section. Three routes make a phone's cost follow its subjects instead:
- *A namespace commitment in each block*, such as a namespaced Merkle tree over the block's data. The phone needs one proof per block per subject, so its cost follows the number of blocks.
- *A per-subject log in the venue's state that consensus enforces.* The phone needs one proof at the range's end, so its cost follows the subject's records. The header chain can be shortened by a suffix proof.
- *A succinct proof of the exhaustion itself.* The proof shows that the scan over the range's sections matches the headers' roots and found exactly these objects. The phone checks headers, or a proof of them, and one proof. The trust stays exhaustion's, plus the relation's correctness, and the venue is unchanged. Probed in slices [21](#the-succinct-proof-of-exhaustions-prover-cost-slice-21) and [22](#the-attribution-scans-cost-slice-22), and complete in [slice 32](#the-complete-exhaustion-leaf-slice-32).

| One subject's reads | Ergo, exhaustion (today) | Ergo, state-root log (design, not built) | Celestia, namespace proofs | Bitcoin, exhaustion |
|---|---|---|---|---|
| Bytes a day | 6.0 MB of transaction sections, input proofs included (measured over 4 days; P4 found 4.1 MB in 2026-09), and 0.16 MB of headers. The runtime fetches node JSON, about 5× the section bytes in P4, so about 30 MB | 0.16 MB of headers; a few KB of lookup proofs per read; the subject's records, including whatever strangers append | 33–54 MB for a purpose-built client (estimate below); about 640 MB of extended headers for a stock light node (estimate) | 118 MB (OP_RETURN) or 236 MB (witness), and 11.5 KB of headers ([probe 2](#results-of-probes-1-and-2-slice-16)) |
| Per year of the deployment's age | 2.2 GB | 58 MB of headers checked as venue-ergo §3 checks them. A 173 KB suffix proof instead only with a comparison by work ([decision](../decisions/2026-10.md#2026-10-12--keep-a-nipopow-suffix-a-holders-option-and-require-a-comparison-by-work-before-a-phone-relies-on-one-slice-28-next-12)) | 12–20 GB, from archival suppliers | 43–86 GB |
| What the reader checks itself | Every header's work, and every section against its root | Each header's work and the lookup proofs. It trusts that the most-work chain applied the guard script | Signatures of more than two thirds of the voting power (95 validators), then hash links and data roots back from there | Every header's work, and every block's Merkle root |
| Finality | Depth over proof of work | The same | Instant BFT, with weak subjectivity: a 7-day trusting period ([CIP-36](https://cips.celestia.org/cip-036.html)) and 14.04 days of unbonding (measured). A phone away for longer must take a checkpoint from someone | Depth over proof of work |
| Data from index zero | Full nodes keep every block by default | The log's head is current state, and records come from any supplier, checked against it | Nodes may prune after 7 days and 1 hour ([CIP-34](https://cips.celestia.org/cip-034.html)). Of two public RPCs, one held 2.4 hours and one held everything from height 1 | Full nodes keep every block |
| A 136 B record, calm | About 0.0012 ERG ($0.0004; estimate: the 0.0011 ERG fee plus the box's minimum value) | More: one log input and output, a tree proof and a rent reserve (estimate) | 238 utia, the one-share gas of the measured small blobs ($0.00014) | About 260 vB, so 260 sats ($0.22) at 1 sat/vB |
| A 15.5 KB release, calm | 0.0068 ERG ($0.002), of which 0.0057 ERG is box value that any spender recovers, so 0.0011 ERG ($0.0004) net ([measured](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node)) | The same, plus the log append | About 900 utia ($0.0005); an 18.6 KB blob paid 981 | About 15,600 sats ($13) in OP_RETURN, or about 4,100 ($3.4) in the witness |
| Congested | Not observed (judgment: blocks run far below their limit) | Contention on the subject's log (below) | Not measured | At 13 sat/vB, the busiest block median since 2025: $2.8 and $169. At 491–1,178 sat/vB, the medians at the 2024-04-20 halving: up to $256 and $15,300 |

Prices are CoinGecko's on 2026-10-12: BTC $83,505, ERG $0.329, TIA $0.596. mempool.space recommended 1–2 sat/vB, and its block fee-rate history gives the congested rows. Celestia blob transactions paid 0.004 utia per gas.

The per-subject columns multiply by the holder's subject count. Exhaustion's column does not, because one scan answers every subject.

**Verdicts** (rationale in the [decision](../decisions/2026-10.md#2026-10-12--compare-venues-on-what-a-phone-pays-to-prove-absence-for-one-subject-and-probe-a-succinct-proof-of-exhaustion-next-slice-20)):
- *Celestia is no phone venue.* Its blocks come every 2.87 s, 30,127 a day, and one namespace's absence in a block costs a 404-byte header plus 0.7–1.9 KB of proof (estimated from the namespaced tree's layout at the measured square widths, median 8 and p90 32): 5–9 times Ergo's exhaustion for one subject. Its finality has a 7-day trusting period and its nodes keep data for a week. Other data-availability chains share the per-block shape (judgment).
- *Bitcoin is no phone venue under any design available today.* Its blocks commit nothing by subject, and neither compact block filters (BIP158) nor Utreexo is committed by consensus. It keeps the strongest order for desktop and backer readers.
- *Splitting ordering records from bulk publications helps no reader:* exhaustion follows the ordering venue's whole carriage, and one scope would get two venue clocks, against C2.10.2.
- *An Ergo state-root log* (a guard script keeping one log head per subject, a registry box, a phone checking headers and lookup proofs) would follow the subject at a trust change: a majority miner could extend a chain that leaves a revocation out of a log, and phones would follow it. Each log's box also invites contention, and an idle one storage rent. It was the fallback should the succinct route fail; that route passed ([slice 32](#the-complete-exhaustion-leaf-slice-32)).
- *Other measurements:* a NiPoPoW suffix proof from genesis to the tip of 195 KB as the node's JSON counts it (149 headers, m = 6, k = 10), about 173 KB at the wire's 221 B a header; UTXO lookup proofs of 900 B for one box and 3.8 KB for four, against the current state (a stock node serves none against an older state root); AD proofs of 31 MB a day.

*Limits:* four days of Ergo, one of Celestia and one snapshot of fees and prices; Celestia's proof sizes are estimated from the tree layout; Ergo's 6.0 MB includes input proofs that venue-ergo §4 does not need; Ergo's rent and mempool-replacement rules are not re-verified. Full text, with the state-root log's sketch: [at 05337cf](https://github.com/mediumofexchange/reference-ts/blob/05337cf/docs/VENUE_ALTERNATIVES.md#absence-for-one-subject-slice-20).

### The succinct proof of exhaustion's prover cost (slice 21)

Measured 2026-10-12, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/4d84026/scripts/venue/succinct-probe); [decision](../decisions/2026-10.md#2026-10-12--keep-ergos-headers-with-the-phone-and-prove-its-sections-a-days-hashing-costs-a-4-vcpu-prover-about-10-hours-slice-21)). The question: can a prover carry §13.2's exhaustion over a day of Ergo in the declared proof system (pool-v3 §4: UltraHonk over BN254, Barretenberg 5.2.0, Noir 1.0.0-beta.26), so that a phone checks a proof instead of reading every section? This probe measures the hashing, the part that was unknown. The attribution scan and the map are not measured.

**The headers stay with the reader.** One Autolykos v2 check is 2,152 Blake2b-256 compressions (33 of its hashes each cover the 8,192-byte constant `M`): 1.55 million a day, 29 times the 53,391 that a day's sections need, or 288 prover hours a day. The reference's check takes 11.2 ms a header on one core of the probe host in JavaScript: 8 s per day of chain, 49 minutes per year of a deployment's age. So the proof covers only the sections against their headers' transactions roots and the scan over them, and the reader checks every header's work and the difficulty rule from the anchor itself (venue-ergo §3).

| Measured (one 4-vCPU Xeon at 2.10 GHz, 15 GB) | Value |
|---|---|
| Blake2b-256 in Noir over 64-bit words, per 128-byte compression | 32,941 gates (257 a byte); Barretenberg's Blake2s black box costs 50 a byte |
| One recursive verification of a `noir-recursive` proof | 0.77 million gates; a node verifying two, 1.47 million |
| A chained leaf: 103 compressions and one recursive verification | 4,097,581 gates in 2^22 rows, proved on 4 threads in 68.9 s twice, 5.8 GB peak: 16.8 µs a gate |
| A day of Ergo mainnet (1,440 blocks to height 1,892,905) | 721 blocks, 4,832 transactions, 3.81 MB unsigned (4.34 MB signed); 53,391 compressions: 519 leaves, 9.9 prover hours |
| A proof | 14,656 bytes; native verification 16 ms |

**Superseded for the route's cost by [slice 32](#the-complete-exhaustion-leaf-slice-32)**, whose hinted Blake2b costs 9,861 gates a compression and whose complete leaf proves slice 22's day in 7.0 hours. This section's estimates of a tree of proofs, spam, a phone's reads, trust and roles and the specification question are in the full text; [succinct reading](https://github.com/mediumofexchange/money-from-first-principles/blob/8aa2f03/succinct-read.md) now states the reader's rules and their C0a record. A NiPoPoW suffix in place of the headers is a holder's option, not the protocol's route ([decision](../decisions/2026-10.md#2026-10-12--keep-a-nipopow-suffix-a-holders-option-and-require-a-comparison-by-work-before-a-phone-relies-on-one-slice-28-next-12)). Full text: [at 05337cf](https://github.com/mediumofexchange/reference-ts/blob/05337cf/docs/VENUE_ALTERNATIVES.md#the-succinct-proof-of-exhaustions-prover-cost-slice-21).

### The attribution scan's cost (slice 22)

Measured 2026-10-12, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/c5eeece/scripts/venue/scan-probe); [decision](../decisions/2026-10.md#2026-10-12--the-attribution-scan-costs-about-180-gates-a-byte-under-a-third-of-its-budget-so-the-succinct-route-has-not-failed-and-attributes-by-subject-slice-22)). The question: [slice 21](#the-succinct-proof-of-exhaustions-prover-cost-slice-21) left the route to the attribution scan, which must read every unsigned byte under venue-ergo §5's grammar so that no prover can call a grammatical transaction ungrammatical and omit its record. One 4-vCPU prover keeps up while the scan adds at most about 660 gates a byte.

**The scan costs under a third of its budget.** The circuit reads one byte a step, so a crafted transaction costs no more per byte than any other; each step applies the action a table names for its byte's class and the machine's mode. It costs 181.5 gates an unsigned byte attributing every output with §6's shape whatever its tree, 216.5 matching §6's four locations, and about 25,700 for its constant tables and frame once a circuit (a first draft as branching Noir cost about 1,280 a byte). It proves no slower per gate than Blake2b: 17.4–18.0 µs against 17.8–18.5 at 2^19 rows. The machine agreed with the reference's `frameTransaction` on validity and shaped outputs over 43,390 transactions (1,390 of mainnet, 2,000 synthetic record transactions, 40,000 mutations of either), and the circuit with the machine over 450 transactions in 357 buffers; the review added 86 targeted hostile cases.

**A day took one machine about 14 hours.** With the scan, slice 21's day takes 13.9 hours by shape and 14.6 by location; this probe's day (720 blocks to height 1,892,959: 4,994 transactions, 4.16 MB unsigned, 541 inside §5's grammar, no output with §6's shape) 14.9 and 15.7. Each extra unsigned MB a day cost 2.48 prover hours. [Slice 32](#the-complete-exhaustion-leaf-slice-32) supersedes these figures with the complete leaf, and succinct reading (§4.2) adopts this probe's attribution by subject: an entry for every output with the shape, which the reader attributes under §6 itself. Full text: [at 05337cf](https://github.com/mediumofexchange/reference-ts/blob/05337cf/docs/VENUE_ALTERNATIVES.md#the-attribution-scans-cost-slice-22).

### The complete exhaustion leaf (slice 32)

Measured 2026-10-13, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/76c4da5/scripts/venue/exhaustion-probe); [decision](../decisions/2026-10.md#2026-10-13--the-complete-exhaustion-leaf-keeps-up-with-an-ordinary-ergo-day-on-one-4-vcpu-prover-about-three-times-over-slice-32-next-12)). The question ([direction 2026-10-13](../decisions/2026-10.md#2026-10-13--keep-the-release-target-take-the-phone-path-now-and-prove-the-trails-proofs-rather-than-its-state-machine-direction), Next 12 step 1): [slice 22](#the-attribution-scans-cost-slice-22)'s scan with the bindings it left open (transaction boundaries bound to the hashing, entries bound to their transactions, state carried across leaves, challenges), the map by subject and the period fold, against one 4-vCPU prover's day. It is falsified if it cannot keep up with an ordinary Ergo day, or if the complete leaf exceeds 2^22 rows.

**It keeps up with an ordinary day about three times over.** Slice 22's day takes one 4-vCPU prover 7.0 hours with every binding, the map and the fold, against 14.9 hours there for the hashing and scan alone. The latest day, with 2.4 times the unsigned bytes, takes 14.1 hours.

| Measured (one 4-vCPU Xeon at 2.10 GHz, 15 GB, idle) | Value |
|---|---|
| Blake2b-256 compression, hinted additions and rotations | 9,861 gates, against slice 21's 32,941; digests equal `@noble/hashes`' at 10 and 20 compressions, an all-`0xff` message among them |
| T-leaf: 172 transaction slots (22 KB) and 688 list slots | 4,166,156 gates in 2^22 rows; 23,799 a slot with its four list slots, 33,920 fixed; proved in 71.4–72.0 s, 6.3 GB peak |
| M-leaf: 378 tree and header compressions | 4,192,719 gates; 11,044 a slot; 75.0 s, 6.4 GB |
| U-leaf: 790 subject-map updates | 4,162,214 gates; 5,253 a slot; 75.5 s, 5.4 GB |
| Node: two children verified and joined | 1,469,892 gates in 2^21 rows; 24.8 s, 2.0 GB |
| First and next fold | 711,228 and 1,477,559 gates |
| Proof | 14,656 bytes, as every UltraHonk proof of the declared system |

Per-slot and fixed figures are fits over small sizes; the full-size leaves measure 0.2–0.9% above them.

**Three leaf kinds share one state.**
- *T-leaves* hash and scan transaction bytes, one compression and 128 scan steps a slot, and list the entries their scan emits: at most four a slot, since an output with the shape spans at least 42 bytes.
- *M-leaves* hash each block's transactions-root tree and its header, one compression a slot.
- *U-leaves* apply the entries to the subject map, one update a slot.
- One state hash at each end of a leaf covers all three streams: 90 field elements under Poseidon2 (73 gates a permutation). Leaves of any kind therefore follow one another in one sequence, and each kind fills its own rows whatever a day's mix: slice 22's day needs 1.7 transaction compressions for each tree or header one, the latest day 3.7.

**The bindings.**
- *Transaction boundaries:* each transaction starts a fresh compression, and its last slot is zero past its length, which enters Blake2b's counter. The ids the T-leaves compute are therefore those of the bytes they scanned, divided where they scanned them. Each id joins a chain with its labels, the block's height and its position in the block.
- *Ids to headers:* M-leaves push the same ids under the same labels into a stack machine. It hashes tree leaves and nodes under venue-ergo §4's prefixes, and at each header's first chunk it requires a single stack entry equal to the bytes at offsets 65–97 (the transactions root) and the bytes at 1–33 equal to the previous header's id.
  - The machine needs no rule for the tree's shape. Without a Blake2b collision, any tree whose root equals the header's is the real one, leaf for leaf and in order, because a leaf, a single-child node and a node hash messages of different lengths or prefixes.
  - A leaf pushed below the tree leaves two entries at the header and is refused.
  - The stack's two lowest positions are sentinels: a merge needs two live entries and a lift one, so every id pushed enters the root. The review found that a merge into the sentinel let a made-up id join the chain outside the root, shifting every real position label of its block by one (a false absence for a phone that fetches by position). The two checks that close it cost 7 gates a slot.
  - A period ends only where both chains are equal, so the T-leaves scanned exactly each block's transactions, in order, under the labels its tree gives them.
- *Entries:* the scan emits (subject, height, position, output) for every output with §6's shape that it reaches.
  - A T-leaf lists its entries in order of position and checks the list against what it scanned as multisets. The two challenges are derived in the circuit from the leaf's own two state hashes, which bind every byte it hashed (through the ids and the Blake2b chaining value), its scan registers and its list.
  - Challenges from the period's header ids, as slice 22 planned, would make every leaf wait for its period's end. A leaf's own ends serve as soon as its bytes do.
  - The list joins a chain of entries, and U-leaves take the same chain in order. A period ends only where the two entry chains are equal.
- *No validity test:* slice 22 counted an entry only for a transaction inside §5's grammar. Here every shaped output the machine reaches is an entry, and its error checks are gone.
  - A grammatical transaction parses the same without them, so absence stays proven.
  - An entry from an ungrammatical transaction costs a phone one fetch, as one at another tree already does. The model found 50 such entries among 757 over 30 synthetic periods, and none on either mainnet day.
  - The scan, mask and padding now cost about 105 gates a byte beside the hashing, against slice 22's 181.5 for the scan alone.

**The map and the fold.** The probe's map is a sparse Merkle tree of depth 32 under Poseidon2, keyed by a subject's last four bytes, each key holding a count and a chain of its entries. A node verifies two children under keys from a fixed set (the three leaf keys and the node key) and joins them where the left's end state is the right's start. A first and a next fold verify a period's tree, require a canonical start and an end at a block boundary where both pairs of chains are equal, and chain (end id, height, root). The reader's rules for the map, a fold's public inputs and a phone's checks are now [succinct reading](https://github.com/mediumofexchange/money-from-first-principles/blob/8aa2f03/succinct-read.md) §§4.2–4.4, whose digests differ from the probe's (its §5). Two of those checks come from this probe's review: the node and fold keys against the pinned ones (a first fold over a three-input circuit with a made-up map root verified under the genuine fold key), and the start against the pinned one (the first fold's start height is free). The probe's own description: [at 05337cf](https://github.com/mediumofexchange/reference-ts/blob/05337cf/docs/VENUE_ALTERNATIVES.md#the-complete-exhaustion-leaf-slice-32).

**A day of Ergo mainnet.**

| | Slice 22's day (to height 1,892,959) | The latest day (to 1,893,553) | Slice 43's day (to 1,894,624) |
|---|---|---|---|
| Unsigned bytes and transactions a day | 4.08 MB, 4,898 | 9.89 MB, 5,048 (237 transactions over 10 KB, 5.9 MB) | 13.3 MB, 5,899 |
| Transaction and tree-or-header compressions | 34,793 and 20,996 | 80,148 and 21,591 | 107,371 and 25,069 |
| Leaves (T, M, U) and nodes | 203, 56, 0; 258 | 466, 58, 0; 523 | 625, 67, 0; 691 |
| Prover hours: leaves and nodes | 5.2 + 1.8 = 7.0 | 10.5 + 3.6 = 14.1 | 13.8 + 4.8 = 18.6 |
| One 4-vCPU prover keeps up | 3.4 times | 1.7 times | 1.29 times |

The proofs were timed on bb.js's bundled native `bb`. Slice 43's day (720 blocks, heights 1,893,905–1,894,624, fetched
2026-10-14 and modelled with this probe's tooling and slot costs) shows how far a day varies: its unsigned bytes are
3.3 times slice 22's, and one prover keeps up with it only 1.29 times. A period's leaves and each level's nodes are
independent proofs, so provers on several machines share a day: two keep up about 2.6 times. Its 640 grammatical
transactions hold no output with §6's shape, and the scan
([slice 43](../decisions/2026-10.md#2026-10-14--read-a-venue-range-succinctly-from-a-fold-a-subject-map-path-the-keys-entries-and-included-transactions-and-take-the-venues-pace-as-a-prover-pool-slice-43-next-12))
reads none in any of its 6,125 transactions.

Folds add one 1.5 M-gate proof a period. The two windows overlap by 126 blocks.

**Spam now costs less prover time per byte.**
- *Plain bytes:* each extra unsigned MB a day costs 1.22 prover hours, against slice 22's 2.48. One machine absorbs about 14 MB more on an ordinary day: about 0.16 ERG a day in 98,304-byte transactions at 1.1 mERG each (estimate; Ergo's fee policy not re-verified).
- *Small transactions:* 100-byte transactions cost 4.49 hours a MB, a transaction compression and about four tree ones each. That is 10,000 transactions and about 11 ERG a MB.
- *Shaped outputs at one per 42 bytes:* 2.06 hours a MB, 24,000 entries in 30 U-leaves. With one map update per entry inside the T-leaf (16 a leaf), as first built, such spam would cut each T-leaf to about five slots: about thirty times the plain cost per byte (estimated from that build's slot costs, three entries a slot). The separate kind bounds it.
- A tree of proofs lets several machines share a day; spam threatens liveness, not soundness.

**Hostile cases and agreement.**
- *Model:* over 30 synthetic periods (both root rules; record, plain and mutated transactions), every shaped output of every grammatical transaction, 707 by the reference's `frameTransaction` and §6's shape, is an entry.
- *Circuits:* all 864 leaves of those periods (489 T, 177 M, 198 U) execute, as do 302 over 40 mainnet blocks to height 1,893,548 (329 transactions, 1.09 MB). Both pass the period's top check and end at their last header.
- *Leaf witnesses, 22 refused:* an emitted entry left out of a list or one added; a listed subject, position or order changed; a nonzero byte past a transaction or a tree leaf; a transaction started inside another or ended or shortened early; a wrong map sibling, prior count, prior chain or key; a header's root or parent bytes altered; a pushed id other than the bytes hashed; a tree leaf under the node prefix; a merge over other bytes than the stack holds; a leaf below a block's tree; a made-up id merged into the sentinel, and a lift over the empty stack (both added after the review).
- *Streams, 9 refused by the top check:* a transaction omitted, added, swapped, split at a slot boundary, a block boundary moved, a block left out of the trees, and map entries reordered, left out or applied twice. The honest streams pass.
- *Nodes, 6 refused:* a child proof altered, the T-leaf's key used for an M-leaf's proof, an M-leaf's key claimed under the T-leaf's hash, a changed child public input (each proves but does not verify), and a key outside the set or children that do not join (refused at execution).
- *End to end:* two consecutive synthetic periods (29 leaves of all three kinds, 26 entries) are proved, joined and folded; the final fold verifies, ends at the last header and carries the map's root. Six hostile folds are refused: another end height or root, the other period's tree, a previous fold ending elsewhere, a first map not empty, and a lone first leaf whose streams end apart.

**Next steps.** The aggregation probe (step 2, [slice 33](POOL_DEPLOYMENT_PROBES.md#the-trails-proof-aggregation-slice-33)) and the C0a (step 3, succinct reading) are done; a phone's side, a path, a fold's verification and the transaction fetches natively on a phone, is step 5. Levers not taken: nodes over four children (about a third less node time), a leaf that also verifies its predecessor, and the period's length, which sets how much of the tip a phone reads natively.

**Limits.**
- *Host:* one host; leaf proofs are one or two runs each. Their 17–18 µs a gate is near slice 21's 16.8.
- *Window:* two days of Ergo, whose use sets the cost; mainnet carried no shaped output on either, so U-leaves are costed, not observed. The U-leaf was timed with 230 of its 790 slots used, which a fixed circuit proves alike.
- *Tests:* agreement with the reference's framer, not with the node; mutations are random. The scan's hints are those slice 22's review read, less its error checks, and no hostile hint is injected.
- *Review:* one pinned circuit set becomes every phone's verifier, so the relation needs the external review a parser and circuit get.

### The exhaustion circuits in production form (slice 43)

Measured 2026-10-15 ([decision](../decisions/2026-10.md#2026-10-15--prove-the-exhaustions-six-circuits-in-production-form-end-to-end-and-keep-up-with-a-heavy-ergo-day-one-and-a-half-times-on-one-prover-slice-43-next-12); [proving report](ergo-exhaustion-prove-verification.json), [execution report](ergo-exhaustion-check-verification.json)). The six circuits of [succinct reading](https://github.com/mediumofexchange/money-from-first-principles/blob/282c925/succinct-read.md) §4.3 over pool-v2 §1's sponge and §2's tags (sources `scripts/venue/exhaustion-sources.mjs`, `exhaustion-circuits/`, since moved to `src/exhaustion-circuits/`), proved on bb.js's bundled native `bb` on one 4-vCPU Xeon at 2.10 GHz (15 GB), against [slice 32's probe](#the-complete-exhaustion-leaf-slice-32) on the same CPU model.

| Circuit | Slots | Gates (2^22 rows for leaves) | Proofs, first run | Witness (noir_js) |
|---|---|---|---|---|
| Transaction leaf | 167 (24,597 a slot, 30,209 fixed; probe 23,799 and 172) | 4,179,945 | 58.5–62.2 s | 22–29 s |
| Tree-and-header leaf | 380 (10,880 a slot; probe 11,044 and 378) | 4,143,333 | 57.3–58.4 s | 16 s |
| Map-update leaf | 746 (5,552 a slot; probe 5,253 and 790) | 4,150,381 | 57.6–58.7 s | 6 s |
| Node | | 1,469,901 (2^21) | 18.1–18.4 s | |
| First and next fold | | 708,272 and 1,474,513 | 9.2–9.4 s and 18.1–18.8 s | |

Slot costs are fits over 2 and 6 slots; the full-size leaves land 0.0–1.0% above them. Every proof is 14,656 bytes. The [report](ergo-exhaustion-prove-verification.json), re-recorded on 2026-10-15 after slice 43's pool changed its sources (not the circuits), ran leaves in 59.0–65.0 s and nodes in 20.0–21.4 s.

**Slice 43's day keeps one prover busy about 16 hours.** That day (720 blocks to height 1,894,624: 107,371 transaction
compressions, 25,069 tree or header ones, no entry) takes 643 transaction leaves and 66 tree-and-header leaves, 11.9
prover hours at the means, and about 708 nodes, 3.6 hours: 15.4 hours, so one 4-vCPU machine keeps up 1.55 times (the
probe's slot costs gave 1.29). Witnesses computed by noir_js on one core add 4.6 hours where they share the machine (1.20 times).
Native witness generation was the lever, since taken: `nargo execute` in a process of its own overlaps each proof fully,
so the day takes about 15.6 hours (1.54 times; [native witnesses](#native-witnesses-slice-43)). Two machines keep up
about three times.

**The departures from the probe.** `H` over seven inputs puts three permutations on each chain an entry joins (the
stream in two leaves, its key's chain): a map update costs 5.7% more and a transaction slot 3.4% more (its list's
chain and the id chain's two permutations); the state hash over 71 inputs, the scan's register resets and the exact
shape test are inside those figures. The fold's limbs cost one byte decomposition of the end id. Proofs ran 13–24% faster than the probe's on
the same CPU model (the probe's 71–75 s; an earlier run of the same circuits but for their checks' names took 56–64 s), likely from the host, not the circuits.

**Agreement and hostile witnesses.** `exhaustion-check.mjs` compiles the same sources at 6, 12 and 6 slots (noir_wasm,
equal byte for byte to native nargo, which compiles the full size) and executes every leaf of a synthetic chain of 9
blocks (both root rules, 21 entries for keys shared and not, kind-4 runs, an ungrammatical transaction holding a shaped
output, transactions over several slots), as one period and as two, and of 8 consecutive mainnet blocks to height
1,894,700 (64 transactions, 334 leaves); each period ends where a fold requires with `SubjectMap`'s root. 65 crafted
and mutated transactions (tokens, extensions, data inputs, fixed trees, 18 minimal shaped outputs in one, bytes outside
the grammar) give 260 entries, each leaf executing with `scanTransaction`'s outputs as its list. It refuses 28 hostile
leaves and 23 hostile streams, folds and node admissions, each witness otherwise consistent with the state hashes, by
the check each targets (by name; the list's order check is the leaf's one unnamed range check).
`exhaustion-prove.mjs` proves two periods of three synthetic blocks end to end (leaves, nodes, first and next fold); five
hostile recursions (a node over children that do not join, a fold over a node carrying another node key-hash input,
next folds naming another `foldKeyHash` or start or continuing the wrong fold) prove but do not verify; and the
reader's `checkFold` takes the last fold under the derived fold keys on the pinned WebAssembly verifier and refuses
five hostile ones.

**Limits.** A test set: keys derived here, no adoption (§6). One run on one host. The mainnet blocks carry no shaped
output, so the map leaves run on synthetic entries. Proving reads 2^22 G1 points whose leading 2^21 match the check
set's pinned hash; the rest are the CDN's, unpinned until an adoption names them. Full-size compilation exceeds
noir_wasm's memory and uses nargo 1.0.0-beta.26, shown equal at small sizes only.

### The prover pool over mainnet blocks (slice 43)

Measured 2026-10-15 ([decision](../decisions/2026-10.md#2026-10-15--prove-a-replicas-exhaustion-periods-in-a-resumable-prover-pool-from-pinned-222-points-and-fold-real-ergo-mainnet-blocks-slice-43-next-12); [report](ergo-exhaustion-pool-verification.json)). `scripts/venue/exhaustion-pool.mjs` hands 48 consecutive mainnet blocks (heights 1,894,826–1,894,873; 425 transactions, 1.40 MB unsigned) to an `ExhaustionServer` in three periods of 16 blocks, and `ExhaustionPool` proves them with the [production circuits](#the-exhaustion-circuits-in-production-form-slice-43) on bb.js's native binary from the pinned 2^22 points, one 4-vCPU Xeon at 2.10 GHz (15 GB), the same CPU model as before.

**Real blocks fold.** The periods take 8, 40 and 26 leaves (71 transaction, 3 tree-and-header, no map-update: these blocks hold no output with §6's shape) and 7, 39 and 25 nodes; the first fold and two next folds verify, and the reader's `checkFold` takes each under a test set of the built circuits on the pinned WebAssembly verifier (0.2 s for the first, 0.03 s after). It refuses seven hostile folds by rule: another map root, the next fold's proof under the first fold's key, the first fold's proof for the last fold's inputs, another end header, an end above the depth, another start and another fold key hash. A subject's path at the last fold reproduces its root with no entry. A second pool over the kept proofs proves the three periods again in 10 seconds without a proof (each kept proof verified again), with the same fold bytes.

**Times.**

| Proof | Mean (range) | Count |
|---|---|---|
| Transaction or tree leaf, alone | 52.6 s (52.5–52.8) | 2 |
| The same while the next leaf's witness runs | 77.7 s (56.6–92.9) | 51 |
| Leaf witness, noir_js | 25.4 s (transaction), 19–45 s (tree) | 53 |
| Node | 19.0 s (17.9–20.1) | 64 |
| Next fold | 19.9 s | 2 |

- *The built key cuts a leaf's proof:* bb.js's `generateProof` passes no key and derives it again each proof (about 100 s a leaf here); with the key, a leaf proves in 52.6 s, under the 58–62 s of `bb prove -k` before.
- *Overlapping a noir_js witness buys nothing:* a leaf proved beside the next witness takes 77.7 s, as long as the witness and the proof one after the other (78.0 s). noir_js holds the event loop for the whole witness, so the proof's answer waits on it; a native witness overlaps ([native witnesses](#native-witnesses-slice-43)).
- *This window is heavier than slice 43's day:* 1.40 MB in 48 blocks is about 21 MB a day against that day's 13.3 MB; its last period (16 blocks, 32 minutes of chain) took 42 minutes, so one prover keeps up with it 0.76 times. At these means slice 43's day (709 leaves, 708 nodes) takes 19.1 hours, one prover keeping up 1.26 times (the estimate was 1.20).
- *Memory:* proving left at least 5.4 GiB of the 15.7 available; one native instance at a time.

**Limits.** A test set over circuits built here (no adoption); one run on one host; 48 blocks, not a day; no map-update leaf on real blocks; witnesses by noir_js; one prover.

### Native witnesses (slice 43)

Measured 2026-10-16 ([decision](../decisions/2026-10.md#2026-10-16--compute-the-exhaustions-witnesses-with-the-pinned-compiler-in-a-process-of-their-own-slice-43-next-12); probe [`scripts/venue/exhaustion-witness-ab.mjs`](https://github.com/mediumofexchange/reference-ts/blob/20078cd/scripts/venue/exhaustion-witness-ab.mjs)). One full-size transaction leaf (167 slots, the first leaf of eight mainnet blocks to height 1,894,700) is proved under the shipped key on bb.js's native binary, on one 4-vCPU Xeon at 2.10 GHz (15 GB). It is proved alone, beside a noir_js witness of the same leaf in the same process (as the pool ran it), and beside a `nargo execute` witness in a process of its own (as the commands now run it). Each way ran in a process of its own, after a warm-up proof.

| Leaf proof | Proof | Witness | Longest event-loop stall |
|---|---|---|---|
| Alone | 58.9–61.3 s (6), once 79.2 s | | 0.5–0.7 s |
| Beside a nargo witness | 58.8–62.0 s (3) | 18.1–19.3 s | 0.6 s |
| Beside a noir_js witness | 82.1 and 83.6 s, once 179.8 s | 25.2–33.4 s | the whole witness |
| Witness alone | | nargo 17.4–17.7 s, noir_js 24.9–25.3 s | |

- *A native witness costs a proof nothing:* beside nargo a leaf takes its proof's time. Beside noir_js it takes about the witness and the proof in turn, as the [pool](#the-prover-pool-over-mainnet-blocks-slice-43) measured (77.7 s).
- *The day:* at 60 s a leaf and 19 s a node, slice 43's day (709 leaves, about 708 nodes) takes about 15.6 hours on one prover, which keeps up 1.54 times; with noir_js witnesses, at the pool's means, 19.1 hours and 1.26 times.
- *The replica keeps answering:* with noir_js, a proving replica's listener and rounds stopped for 25–33 s at every leaf of a period.
- *Same bytes, little memory:* nargo's witness equals noir_js' byte for byte. It reuses the crate's compiled program, paying its front end (3.8 s for a tree-and-header leaf) and no compile. Its peak is 1.4 GB, with at least 3.8 GiB left free beside the proof.

**Limits.** One leaf kind, one host, two or three rounds a way. The two slow runs came after noir_js' WebAssembly memory had grown (3.3 and 2.8 GiB free), and their cause is not isolated. Node and fold witnesses are timed only in the succinct drill's log.

### The venue recheck (slice 29)

Measured 2026-10-13, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/bcd39d2/scripts/venue/recheck-probe); [decision](../decisions/2026-10.md#2026-10-13--keep-ergo-for-the-release-a-phone-reaches-bitcoin-only-through-about-ten-provers-dogecoin-is-the-next-venue-probe-and-a-venue-move-is-a-planned-move-for-pool-v4-slice-29-next-12)). Three questions, scoped 2026-10-12: does a chain not yet weighed beat Ergo for the release, or Bitcoin as the second venue, by §2 and by what a phone pays ([slice 20](#absence-for-one-subject-slice-20)); what does a phone pay to reach Bitcoin through [slice 21](#the-succinct-proof-of-exhaustions-prover-cost-slice-21)'s succinct route; and can Ergo alone carry the release, with which hedges?

**A phone reaches Bitcoin only through about ten provers working in parallel.**
- *The day:* heights 971,029–971,172, the 144 blocks below tip−6 (23.4 h by timestamps), each fetched raw from mempool.space and verified by [slice 16](#results-of-probes-1-and-2-slice-16)'s parser. They hold 688,039 transactions: 114.4 MB without witness, 232.0 MB in full.
- *The hashing a relation pays:* txids take 2.77 million SHA-256 compressions (2.09 million over the transactions' bytes, one more each for the second hash), the Merkle trees 2.07 million (three a node), the header ids 432. Records in the witness add the wtxids and the witness tree.
- *The leaf:* 830 compressions over bytes packed into words and one recursive verification: 4,155,044 gates in 2^22 rows, 4,158 a compression (slice 27's 3,974 plus the packing). It proved in 74.0 and 75.0 s on one 4-vCPU Xeon at 2.10 GHz (5.6 GB peak; the proof verified): 17.8 µs a gate, against slice 21's 16.8 for its Blake2b leaf on the same host type.
- *A day's proof:* the hashing alone is 19.6 billion gates, **117 prover hours** with each leaf's recursion. Bitcoin's attribution scan is not built; at slice 22's 181.5 gates a byte for Ergo's grammar (an estimate) the day takes **about 240 machine-hours**, against Ergo's 9.9 and 14.6 (slices 21–22). The measured leaf is chained, each verifying its predecessor, so one chain falls ten times behind; ten 4-vCPU provers keep up only on parallel chains joined by a tree of proofs (slice 21: 1.47 million gates a node verifying two), whose joins of the scan's state across chains are unmeasured. Records in the witness cost at most 272 and 523 hours (an upper bound: that count hashes every txid as well as every wtxid, where a witness relation needs only the wtxid tree and the coinbase's txid path).
- *A ceiling Ergo lacks:* Bitcoin's weight limit caps the bytes without witness at 1 MB a block, so even a day of blocks full of minimal 60-byte transactions (16,665 a block) costs about 350 hours of hashing and 500 with the scan (estimate), about twice today's. Ergo's day is cheap because Ergo is little used: its full blocks (917 MB a day) would take about 2,300 hours at slice 22's 2.48 hours a MB.
- *Verdict (judgment):* proofs are public, so one fleet would serve every phone; but a release whose holders depend on ten machines someone runs for ever, joined by a merge not yet built, has a liveness cost Ergo's one machine does not. Bitcoin stays the desktop and backer venue [slice 20](#absence-for-one-subject-slice-20) left it, with its publication held (Open questions).

**Candidates** (one snapshot; attack cost is crypto51's one-hour rental on 2026-10-13; miners for a majority count the fewest pools or addresses that mined over half the blocks named; prover hours are a model fitted to the two measured days, below):

| Chain | Attack cost an hour | Miners for a majority | Phone's headers a day | Exhaustion a day | Prover hours a day: hashing, with scan | Verdict (judgment) |
|---|---|---|---|---|---|---|
| Ergo | $30, 15% rentable | 1: one key 51.5% of 720 blocks ([slice 28](#5-backing-assets-terms-not-backings)) | 0.16 MB | 3.96 MB of sections | 9.9, 14.6 (measured) | The release venue |
| Bitcoin | $2.61M, 0% rentable | 3 ([slice 28](#5-backing-assets-terms-not-backings)) | 11.5 KB | 114 MB | 117 (measured), 240 | Desktop and backer venue |
| Litecoin | $62,850, 8% rentable | 2: F2Pool 38.2%, ViaBTC 22.7%, AntPool 19.4% of 576 blocks (coinbase tags) | 45 KB | 38.8 MB without witness | 31, 73 | Dogecoin's security domain at five times its prover cost |
| Dogecoin | about $40k (merged into Litecoin's blocks at 63% of its hashrate; estimate) | 2: Litecoin's pools ([slice 28](#5-backing-assets-terms-not-backings)) | 1.1 MB (with AuxPoW, 816–882 B a header) | 8.6 MB | 5.3, 14.6 | The next probe |
| Nervos CKB | $273, 2% rentable | 1: one address 59.5% of 2,000 blocks | 2.0 MB (208 B every 9 s; FlyClient MMR in consensus) | 14.3 MB | 41, 56 | Ergo's concentration, costlier |
| Ethereum Classic | $2,604, 0% rentable | 1: one address 67.9% of 6,350 blocks | 3.4 MB, and an Etchash cache per epoch | 4.9 MB, mostly headers (0.47% of gas used) | Keccak and RLP: not modelled | Ergo's concentration, heavier headers |
| Alephium | not listed | not measured | up to 63 MB (157,067 blocks over 16 chains; fewer for one group's chains) | 84.4 MB | not modelled | Fails a phone on headers |

- *The model:* SHA-256d chains pay 65.0 gates a byte without witness plus 17,716 a transaction (second hash, Merkle nodes, padding), fitted to Bitcoin's day; Blake2b-256 chains pay 257 a byte plus 161,060 a transaction and two compressions a header, fitted to slice 21's Ergo day; the scan adds 181.5 a byte; each leaf's recursion adds 20%; 17.8 µs a gate. Its Ergo figures (slices 21–22) predate [slice 32](#the-complete-exhaustion-leaf-slice-32)'s complete leaf, so the Ergo row and the comparisons with it rest on them.
- *Sources:* Litecoin's 576 blocks below tip−6 (heights 3,193,535–3,194,120) from litecoinspace; Dogecoin's 1,440 latest blocks (heights 6,411,517–6,412,956) from Blockchair, with 6 of 8 raw blocks spread over them parsed for the AuxPoW (the other two not served) and Dogecoin's exhaustion counted without the headers; CKB's day from its explorer's count and 288 blocks fetched serialized over RPC; Alephium's rate over 1,000 blocks and its bytes from 200 of them; Ethereum Classic's day from Blockscout. Litecoin's and Dogecoin's relay policy from their sources (`standard.h`, `policy.cpp`); CKB's light client from RFC 0044. Dogecoin's hashrate share is its difficulty over its 60 s blocks against Litecoin's over 150 s (one block each). Blockchair's free tier refuses requests after a few dozen; the probe waits and asks again.

**Dogecoin is the one candidate near Ergo's prover cost with three orders of magnitude more attack cost (judgment).**
- *For:* about 14.6 prover hours a day (estimate), the same as Ergo's measured day; a rental attack about 1,300 times Ergo's; two pools for a majority against Ergo's one key; fees under a cent ([slice 28](#5-backing-assets-terms-not-backings)); SHA-256d sections, cheaper in the declared proof system than Ergo's Blake2b.
- *Against:* its pools are Litecoin's, one security domain; its headers carry the parent's coinbase and branches, about seven times Ergo's header bytes a day unless a relation proves them; records travel only in scriptSig pushes (at most 520 B a push and 1,650 B a scriptSig by policy, no segwit), so each record is a commit and a reveal, and a 15.5 KB release needs about ten inputs; its 1 MB blocks every minute put the ceiling at 1.44 GB a day, so spam reaches the prover as on Ergo; and as a term it fails nothing but adds nothing (slice 28).
- *The cheapest decisive probes,* read-only, before any profile: (1) policy, as [probe 1](#results-of-probes-1-and-2-slice-16): over a fortnight, scriptSig pushes over 83 B (the Doginals precedent) by merged-mining pool, to find exclusion or delay; (2) a day of raw blocks from two suppliers, verified by our own parser with the AuxPoW, txids and Merkle roots, to replace this row's estimates. It needs a raw-block supplier for a day of blocks; Blockchair's free tier serves a few dozen requests at a time.
- *Litecoin* is the same domain at five times the prover cost, with cheaper headers; it stays behind Dogecoin for a phone.

**Ergo alone, and its hedges (judgment).**
- *What a thin budget means:* Ergo pays its miners 3 ERG a block (explorer API, heights 1,893,398–1,893,400, 2026-10-13) plus fees, about 2,160 ERG ($710 at slice 20's price) a day; the largest key earns about half. A miner with a majority reorganizes past any depth and censors any record, at no rental cost. crypto51's $30 an hour prices only an outsider, who can rent 15% of the hashrate and so no majority.
- *Deeper depth for high value: not taken as a rule.* No depth defends against the majority key, and the top two keys together hold 78% ([§3](#3-comparison)). Against the second key alone, about 27%, depth does help: by Nakamoto's estimate, its chance of reversing a witnessed index is about 7.6·10⁻² at depth 6, 1.7·10⁻² at the reference's default depth 10, 4·10⁻⁴ at 20 and 1·10⁻⁵ at 30. But depth is part of the venue's identity (venue-ergo §1, C2.3.2), so a "high-value depth" is another venue: its backings cannot be presented with the rest (invariant 24), and every holder of it waits the longer lag (C2.5.3's lead floor is 2·lag+1). A deployment sizing its one Ergo venue weighs that table against the lag; it does not split venues by value.
- *A value bound per backing: policy now, a C0a candidate later.* Terms are immutable once named, Construction's core declares no value bound, and pool-v3's terms have no ceiling field (§11.2). Extensions' [declared ceiling](https://github.com/mediumofexchange/money-from-first-principles/blob/46e6933/extensions.md#pro-rata-ceilings-and-workouts) exists only as one of its pro-rata conditions; using it as a standalone bound is a C0a generalisation for a later version, not available to v3 backings. Until then the bound is the backer's issuance and the holder's wallet policy. While one miner holds a majority, an Ergo backing stays at pilot value: what its holders could lose to one miner without recourse.
- *The venue-moving record serves foreseen failure, not an attack under way.* Construction already provides its place: C2.5.1's replacement is "published always at the successor venue and at the old one while it serves", and C2.10.2 asks for "a separate, specified bridge" for a venue change, never an operator-replacement record. A sketch for C0a:
  1. E declares, beside its venue, an ordered list of destination venues, each with its anchor, and a notice period counted in the current venue's indices, at least C2.5.3's lead floor (2·lag+1) and C3.3's window.
  2. The move is a replacement of the venue role: signed by whoever E's rule names (the backer by default), co-signed by the operator in force, whose duty to serve then moves with it (C2.5.2's harm otherwise: silence and non-service graded against a key that never agreed), and witnessed on the current venue. It names one declared destination. Its copy, which C2.5.1 publishes at the successor venue too, carries the current venue's header at the cutover (the move's witnessed index plus the notice) once that header is at its depth; the destination's clock starts at the first index witnessing that copy. So the start follows the cut causally, chosen by no signer, and no index of one venue is compared with the other's. The current venue is the clock up to the cutover. Indices of the two venues are never compared (C2.10.2): durations that straddle the switch (C2b.5 and C2b.6's grades, C3 deadlines, slice 28's hashlocked release's `T_v`) need their own rule, which is C0a's question.
  3. One clock per scope: a move splits a scope unless every backing in it moves at one index (invariant 24).
  4. Its limits: a move the failing venue must witness can be censored by the miner it escapes. Witnessing it only on the destination would make every reader prove the destination's absence from the backing's start, so a phone would pay two venues for ever, and would let the authority choose the cut, a power over which witnessed acts count; what C2.5.1's "while it serves" means when the old venue censors is the C0a's open question. A destination outside E would let the authority move holders to a venue it controls. The operator's co-signature is also a veto: an operator that refuses, or colludes with the miner, must first be replaced under C2.5, a lead floor before the notice starts. Witnessed acts on the old venue keep their standing only while its finality holds after the move.
  5. Its cost: v3's E names no destinations and its record kinds are fixed (pool-v3 §1), so the record is pool-v4 or a later construction version, and reaches v3 backings only by successor and swap. A reader switches venue inside one clock, with different lags on each side. Estimate: one C0a decision and about two implementation slices, beside the pool-v4 candidates.
- *Comparing the hedges:* a second venue profile serves backings created on it and splits presentation sets by venue; the venue-moving record serves v4 backings against a foreseen failure (a hard fork announced, a miner's share rising); successor and swap, available today, serves any backing at every holder's act. None protects a backing from a majority miner already attacking: only a venue whose majority costs more does, Bitcoin's for desktop holders and, if its probes pass, Dogecoin's for phones.
- *Ergo changes that would help:* decentralized mining (one key mined 51.5% of a day's blocks) and a NiPoPoW comparison by work ([slice 28](../decisions/2026-10.md#2026-10-12--keep-a-nipopow-suffix-a-holders-option-and-require-a-comparison-by-work-before-a-phone-relies-on-one-slice-28-next-12)). The protocol depends on neither (Open questions).

**Limits.**
- *Snapshots:* one day of each chain and one day's rental prices, refetched in review after a parser fix (the figures above are the refetch); Dogecoin's pool shares are slice 28's.
- *Modelled, not measured:* every candidate's prover hours, and Bitcoin's scan, at Ergo's grammar's rate; Bitcoin's hashing is measured, and its leaf timings are two runs on one host.
- *Attribution:* coinbase tags (Litecoin) and miner addresses (CKB, Ethereum Classic); an address may be a pool, whose operator chooses the blocks, which is the concentration that matters here.
- *Estimates:* Dogecoin's rental cost scaled by hashrate from Litecoin's; Alephium's header bound from its smallest block over all 16 chains and Ethereum Classic's from its smallest block; Ethereum Classic's 2020 attacks and Alephium's hash functions from background knowledge, not re-verified.

## 5. Backing assets (terms, not backings)

Measured 2026-10-12, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/7f1b572/scripts/venue/asset-probe); [decision](../decisions/2026-10.md#2026-10-12--promise-btc-first-then-xmr-then-ltc-as-chain-asset-terms-and-take-a-hashlocked-release-to-c0a-for-their-cross-chain-legs-slice-28-next-12)). The question: which chain assets should a backing be able to promise, judged by the intent to be money, an aligned ethos, and usability for ordinary holders, in that order?

**What a term does.** A chain asset is a nameable term, not a backing (§1). A holder keeps it beside claims as a bare asset, a payout pays in it, a reliance requires it (v3 fixes the reliance count at zero, so that waits for a later version), and trigger cover posts it as an escrow that stands at each index on the root's venue (Extensions), so in practice only in ERG on Ergo. Payouts that settle outside the claim layer need no venue integration: the holder's release is the receipt, and whoever performs first extends credit (C3, pool-recovery). Atomic legs need an escrow on the decision venue (C3 step 1), and Ergo, the decision venue, holds only ERG natively, so every other asset's atomic leg needs a cross-chain construction (below). v3's terms name the payout thing as free UTF-8 text (pool-v3 §11), so nothing yet pins which chain a term means.

**Not ranked: custodians' backings.** Wrapped and bridged assets (Rosen's rsnBTC, wBTC), federated ones (Liquid's L-BTC), ecash (Cashu mints, Fedimint guardians) and stablecoins are each somebody's promise to pay the asset (paper §10). A backing paying in them pays in another backing, which must be declared as one. Lightning is not custodial: a channel balance is the asset, enforceable on its own chain, so it is a payout rail (below). Ark and Spark sit between: unilateral exit, but an operator's liveness (Ark) or one operator's key deletion (Spark).

**How the measurements were taken.** Pool shares are each pool's own count of blocks among the last 1,000 (miningpoolstats), except Bitcoin's and Litecoin's week from mempool.space's and litecoinspace's coinbase attribution and Ergo's day from the explorer's miner keys. Attack cost is crypto51's one-hour rental model, not a measured attack. Liquidity is CoinGecko's; addresses with a balance, nodes and median fees are one Blockchair snapshot, converted at CoinGecko's price; reachable Bitcoin nodes are Bitnodes'. Supply, funding, governance and rails come from each project's own sources, linked in the decision.

**1. Intent to be money** (inflation is gross issuance over supply, 2026-10-12; judgment in the last column):

| Asset | Supply rule | Inflation | Launch | Protocol funding now | Intent |
|---|---|---|---|---|---|
| BTC | 21M cap, halvings, never changed | 0.82% | Fair, no premine | None | Money: passes |
| XMR | Tail of 0.6 XMR a block for ever, in the 2014 design | 0.84% | Fair, no premine | None (donations) | Money: passes |
| LTC | 84M cap, halvings | 1.69% | Fair | None | Money: passes |
| BCH | 21M cap, Bitcoin's schedule | 0.82% | Fork of BTC (2017) | None: the 8% funding plan was rejected, and its sponsor split off as eCash (2020) | Money: passes |
| DOGE | 10,000 a block for ever (since 2015) | 3.36% | Fair (2013) | None | Money by its own statement; perpetual flat emission by rule: passes |
| Grin | 60 a minute for ever | 12.9% | Fair (2019), no premine or founders' reward | None (donations) | Money, designed as a medium of exchange: passes |
| KAS | 28.7B cap, monthly reduction; 96.7% issued | 1.7% | Fair (2021) | None | Payments chain turning programmable (covenants and ZK, June 2026): passes, under watch |
| ERG | 97.7M cap; EIP-27 (2022, miner vote) stretched the tail to about 2045 | 0.94% | No premine; the foundation took 4.43% from early blocks | None | Calls itself a smart-contract platform, but a capped schedule with no premine, designed as "contractual money": partial (ETC, CKB and ALPH are gas or state units) |
| DGB | 21B cap by about 2035 | 2.85% | 0.5% premine | None | Payments plus assets and a stablecoin: partial |
| BSV | 21M cap | 0.82% | Fork of BCH (2018) | None | Rules set by one association: partial |
| ZEC | 21M cap | 3.9% | 20% founders' reward to 2020 | **20% of the subsidy**: 8% to grants and 12% to a coinholder-voted fund to height 4,406,400, about late 2028 (NU6.1) | Fails: a standing treasury |
| Dash | Decreasing subsidy | 2.7% | Instamine of about 10% (2014) | **20% treasury** by masternode vote; masternodes 60% | Fails |
| Firo | 21.4M, then 1 a block | 3.4% | 8% founders' allocation | **25%** to development and community funds; masternodes 70%, miners 5% | Fails |
| DCR | 21M cap | 3.0% | 8% premine | **10% treasury**; ticket holders 89% | Fails |
| XEC | 21T (BCH ×10⁶) | 0.82% | Fork of BCH (2020) | **32% to the one implementation's developer**, 10% to stakers | Fails |
| Zano | Uncapped, 1 a block | 3.4% | 3.69M premine (about 21% of the initial supply) | None beyond the premine | Fails: a premine of a fifth (a few percent, as DGB's and ERG's, is partial) |
| Beam | 262.8M cap | 6.8% | 20% of emission to a treasury for 5 years (12% of the cap) | None since 2024 | "Confidential DeFi": fails |
| ETC, CKB, ALPH | Fixed schedules | 2.4% (ETC) | | | Gas or state units of contract platforms: fail |

**2. Ethos, measured** (attack cost per hour; "—" where crypto51 lists no rental market):

| Asset | Largest pools | Pools for a majority | Attack cost | Finality, governance, privacy |
|---|---|---|---|---|
| BTC | Foundry 25.8%, AntPool 20.9%, F2Pool 17.2% (1,061 blocks) | 3 | $2.82M | PoW depth; 25,130 reachable nodes; client maintainers and soft-fork signalling; BIP-110's split (August 2026) stalled with about 2.5% of hashrate; no privacy |
| XMR | SupportXMR 31.6%, Nanopool 17.8%, Kryptex 16.5% (P2Pool's endpoints 8.1%, same response) | 3 | — (RandomX is CPU-mined) | Qubic claimed a majority in August 2025; an 18-block reorganization on 2025-09-14; privacy by default |
| LTC | F2Pool 34.7%, ViaBTC 22.6%, AntPool 19.2% (3,754 blocks) | **2** | $49.7k | Optional privacy (MWEB, about 0.5M LTC); some exchanges refuse MWEB |
| DOGE | F2Pool 35.7%, ViaBTC 21.6%, AntPool 18.8% | **2** | merged with LTC (judgment: LTC's pools, LTC's figure) | Same scrypt pools as LTC; no privacy |
| ZEC | ViaBTC 32.2%, Foundry 17.0%, F2Pool 14.8% | 3 | $66.4k | Its development company's staff resigned (January 2026); a block-time change (NU7) pending and a PoS hybrid planned; optional privacy, 26–31% of supply shielded |
| BCH | ViaBTC 15.1%, AntPool 11.0% (472 attributed) | — | **$9.4k**, 0.3% of BTC's | A minority of SHA-256 hashrate: any large BTC pool can reorganize it |
| Grin | 2miners 43.5%, easygrin 44.5% (pool and solo) | **2** | — | Majority attacks reported (November 2020); privacy by default |
| ERG | **one miner key 51.5% of 720 blocks** (heights 1,892,585–1,893,304) | **1** | **$31** | Miner-voted parameters; no privacy |
| KAS | f2pool 25.5%, humpool 25.3% of reported hashrate (only 120 of 1,000 blocks attributed) | **2** | $4.2k | No privacy |
| Firo | **woolypooly 86.2%** | **1** | — | Masternode quorums (70% of the subsidy) |
| Dash | f2pool 23%, ViaBTC 17% of reported hashrate | — | **$448** | Masternode quorums finalize blocks |
| Beam | **2miners 59.3%** | **1** | — | Privacy by default |
| XEC, BSV | fragmented | 7 and 5 | $107, — | One implementation (XEC); one association (BSV) |

**3. Usability for ordinary holders** (fees are the median of a day's transactions; one snapshot):

| Asset | Market cap, 24 h volume | Addresses with a balance | Fee, calm | Fee, congested | Block, spend wait | Phone wallets | Escrow script | Live atomic swaps |
|---|---|---|---|---|---|---|---|---|
| BTC | $1,645B, $27.4B | 59.9M | 39 sats ($0.03); a 141 vB payment at 1 sat/vB $0.12 | $1.50 at 2025's busiest bucket median (13 sat/vB); 2024-04-20's 1,178 sat/vB is about $136 at today's price | 10 min | Many; Lightning (Phoenix), Ark | SHA-256 hashlocks, CLTV and CSV, Taproot | eigenwallet, BasicSwap, DCRDEX, Komodo |
| XMR | $10.0B, $112M | private | about 0.00003 XMR ($0.016; estimate at 1.5 KB) | not measured | 2 min; **outputs spendable after 10 blocks** | Cake (Polyseed with birthday), Monerujo, Stack | **None**: the side without scripts only | eigenwallet (BTC), BasicSwap |
| LTC | $4.8B, $293M | 9.12M | $0.0005 | not measured | 2.5 min | Cake (with MWEB), Litewallet, Stack | As BTC, Taproot | BasicSwap, DCRDEX, Komodo |
| DOGE | $12.9B, $623M | 8.48M | $0.009 | not measured | 1 min | Cake, Stack | SHA-256 and CLTV; **no CSV** | BasicSwap, DCRDEX, Komodo |
| ZEC | $19.9B, $880M | 0.85M (transparent) | $0.12 (ZIP-317's 10,000 zat) | not measured | 75 s | Zodl (formerly Zashi), Cake | Transparent outputs only, **no CSV** | DCRDEX |
| BCH | $5.4B, $197M | 25.7M | $0.0012 | not measured | 10 min | Paytaca, Cake, Stack | Covenants: introspection, CashTokens | BasicSwap, DCRDEX |
| Grin | about $2.5M, **$6.9k** | private | about 0.023 GRIN (estimate: 46 weight units at 0.0005) | | 1 min; **interactive transactions** | GRIM | None (height-locked kernels) | None (proofs of concept) |
| ERG | $26.8M, $182k | | 0.0011 ERG ($0.0004) | | 2 min | Ergo Mobile Wallet (Terminus), Minotaur | Full (eUTXO), SHA-256 and Blake2b | None (Rosen is a federated bridge) |
| KAS | $1.07B, $16.9M | | about 0.00002 KAS | | 0.1 s blocks | Kaspium | SHA-256, CLTV, CSV, covenants | None |
| Dash, Firo, DCR, Zano, Beam, XEC, DGB, BSV | $0.6B and below; Firo $118k, Beam $59k a day | | under $0.01 | | | | Firo's CLTV is not consensus-enforced on mainnet (source reading) | Dash, Firo, DCR: BasicSwap and DCRDEX |

**How a payout or C3 leg would settle** (judgment; the cross-chain constructions are not specified):
- *Outside the claim layer (today, every asset):* the backer pays and the holder releases, or the reverse; the first to perform extends credit. Cheapest, and what the wallet's bare holdings and pool-recovery's payouts already allow.
- *Same-venue escrow (ERG only):* C3's lock, an ErgoScript escrow on the decision venue, reading the venue's own records. ERG is the one asset whose atomic legs need nothing new.
- *A hashlocked release (HTLC chains and Lightning):* the acceptance names `h = SHA-256(s)` for a fresh secret `s` the holder chose for this attempt; the backer locks the asset to the holder under `h` with an absolute refund time `T_a`; the holder's release takes effect only when a record carrying `s` is witnessed before the lock timeout `T_v`. The holder claims the asset by revealing `s`, which anyone then copies to the venue; if the holder never claims, the backer refunds after `T_a` and the claims unlock at `T_v`. It serves BTC, LTC, DOGE, BCH, Dash, KAS, DCR (through `OP_SHA256`, since its `HASH160` is Blake-256-based) and ZEC's transparent outputs, all with SHA-256 and an absolute timelock. Its conditions run across two clocks (the asset chain's heights and the venue's index), and each side has its own:
  - *the holder* reveals `s` only after the venue lock is witnessed and the backer's lock is buried at the asset chain's own depth, and only early enough that its claim is buried before `T_a` less a margin: a claim still unconfirmed at `T_a` (congestion, a reorganization, a phone offline) races the backer's refund, and if the refund wins, the backer still copies `s` to the venue and the holder loses both legs;
  - *the backer* needs `T_v − T_a` to cover a claim confirmed late (a claim path stays valid after `T_a` until the refund confirms) and the publication of `s` at the venue's depth;
  - *the venue* must not be censorable for that window: once the holder has the asset, keeping `s` off the venue until `T_v` gives the holder both legs. On Ergo, where one miner key mined 51.5% of a day's blocks, the margin or a value bound per attempt must be sized against that, which a same-venue escrow never needs (there censorship only aborts).
  - *Lightning* has the same shape: the holder issues an invoice for `h`, and the preimage the backer's payment returns is both its receipt and the release's key. The relevant timelock is the backer's outgoing HTLC expiry, the sum of the route's deltas (up to about 2,016 blocks), since any hop, the holder's own channel provider included, can hold the preimage back until then; `T_v` must exceed it, and the holder must still settle on-chain in time if a channel closes. That makes Lightning the natural phone rail for BTC payouts, at a lock-up as long as the route's expiry.
  - The hash ties the two legs together in public. A release conditional on a preimage changes C3's objects, so it is a later pool-recovery version through C0a. It does not serve trigger cover, whose escrow must be readable on the root's venue.
- *Assets without scripts (XMR, Grin, Beam):* the backer's leg sits in a jointly keyed output, and the release must reveal the backer's key share (a point lock rather than a hash) so the holder can sweep it. The backer's refund is the hard half. Grin and Beam have height-locked refund kernels a backer can pre-sign. Monero has no timelock, so a refund needs the holder's key share revealed when the attempt aborts, and C3's abort is a unilateral timeout that reveals nothing. That is the BTC side's cancel and punish in the BTC↔XMR protocol, and the venue would have to play it; Monero's Ed25519 keys also need a cross-group proof of equality with the venue's, and the abort path asks the holder to stay live. XMR legs therefore need the most construction. Its 10-block spend lock and the 18-block reorganization of 2025 also argue for a deep margin.
- *Not payout rails:* ecash mints, federations, bridges and Spark (above), and Haveno's arbitrated multisig and THORChain's vaults, which are not atomic.

**Recommendation (judgment).**
1. **BTC first.** It passes intent outright, has by far the highest attack cost, 25,130 reachable nodes and the largest holder base and liquidity, and it has the richest rails: HTLCs, Taproot, live atomic swaps and Lightning for phones. Its costs are mining concentrated in three pools, no privacy, and fees that spiked to a median of 1,178 sat/vB in April 2024, about $136 a payment at today's price (Lightning absorbs that on the payout side). Order, as 2026-08-27 set: bare holdings in the wallet; payouts outside the claim layer (expressible now); then the hashlocked release, which also serves Lightning.
2. **XMR second.** It passes intent, and its privacy by default matches the protocol's own private payments. Against it: three pools hold a majority, Qubic's claimed majority and an 18-block reorganization in 2025, and shrinking exchange access (Binance, Kraken EEA and OKX delisted it; EU rules bar anonymity-enhancing coins at service providers from July 2027). Atomic legs are the route that delisting leaves open, and they are the costliest construction here, so XMR payouts settle outside the claim layer until that construction exists.
3. **LTC third, with DOGE beside it.** Both are cheap and fast and have HTLCs and live swaps. Two pools hold a majority of each, and they are the same scrypt pools, so the two share one security domain. LTC has a cap and optional MWEB privacy; DOGE has perpetual flat issuance by rule and deeper liquidity. Neither adds anything the hashlocked release does not already cover.
- **ERG stays the fee and same-venue escrow asset,** the only one whose atomic legs work today. It is not a first term for material value: one miner key mined 51.5% of a day's blocks, a rental attack costs $31 an hour, a day trades $182k, and the project calls itself a platform. A backing that pays in ERG on Ergo also stacks its payout's risk on its venue's.
- **Not now:** ZEC (a standing 20% treasury to about late 2028, a development team that left its company in January 2026, consensus changes pending, and escrow only in transparent outputs; revisit when the treasury ends); BCH, XEC and BSV (minority SHA-256 chains that any large Bitcoin pool can reorganize: BCH's rental cost is 0.3% of Bitcoin's); Dash, Firo, DCR, Zano and Beam (treasuries, premines and quorums, and Firo and Beam each have one pool with a majority); Grin, best on intent, fails usability (a day trades $6.9k, transactions are interactive, no live swaps); KAS (recheck when its programmable direction settles); DGB (thin); ETC, CKB and ALPH (platform units).
- **Name the chain, not the ticker.** BIP-110's split in August 2026 is the reminder: a term reading "BTC" names no chain once a chain splits. A chain-asset term should name the chain by its genesis id and the asset, with a rule for a split, before the wallet names one. That convention fits v3's free-text `thing` without a byte change, and needs its own decision.

**Limits.**
- *One snapshot:* one day's fees, prices, volumes and pool counts; pools report their own blocks, and miningpoolstats misses some (attributed blocks run from 120 to 992 of 1,000).
- *Not measured:* congested fees outside Bitcoin (Litecoin's history timed out), node counts outside Bitcoin (Blockchair's are its own crawler's), the holder base of private chains, and phone wallets' sync and restore costs.
- *Sources:* supply, funding and governance facts come from project pages and code, some through secondary reports (marked in the decision); Firo's CLTV status and Kaspa's covenant activation come from a single source reading each.
- *Judgment:* the intent and ethos verdicts and the order are judgment, applying the criteria in their stated order; the cross-chain constructions are sketches, unreviewed as protocol.

## Sources
- crypto51.app (2026-10-05); mempool.space API `/v1/mining/pools/1w`, `/v1/mining/blocks/sizes-weights/1m` and `/v1/fees/recommended` (2026-10-05); Ergo explorer API `/api/v1/blocks` (2026-10-05).
- [b10c, Bitcoin mining centralization 2025](https://b10c.me/blog/015-bitcoin-mining-centralization/); [Core v30 OP_RETURN](https://en.cryptonomist.ch/2025/10/13/bitcoin-core-update-v30-op-return-limit-controversy/); [BIP-110 rules](https://studyknots.com/guides/bip-110); [BIP-110 split](https://cryptobriefing.com/bip-110-nodes-fork-bitcoin-chain-split/).
- [Monero PR #8733](https://github.com/monero-project/monero/pull/8733); [Qubic and Monero](https://www.coindesk.com/business/2025/08/12/monero-s-51-attack-problem-inside-qubic-s-controversial-network-takeover); [Kaspa Crescendo](https://github.com/kaspanet/rusty-kaspa/releases/tag/v1.0.0).
- [Cardano fees](https://developers.cardano.org/docs/developers/curriculum/fundamentals/core-concepts/fees/); [Zcash FlyClient and Crosslink](https://zcash.readthedocs.io/en/latest/rtd_pages/nu_dev_guide.html); [BCH OP_RETURN](https://www.chaincatcher.com/en/article/2185522); [Ergo NiPoPoWs](https://docs.ergoplatform.com/dev/protocol/nipopows/); [Ergo market data](https://www.coingecko.com/en/coins/ergo).
- Not re-verified, from background knowledge: Litecoin's OP_RETURN policy, Praos stake-distribution validation, Ethereum blob retention, and the CVE-2012-2459 details.
