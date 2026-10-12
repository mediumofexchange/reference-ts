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
- *Against Bitcoin:* (a) §13.2 exhaustion costs about 118 MB/day if records sit in OP_RETURN, or about 236 MB/day if they sit in the witness ([probe 2](#results-of-probes-1-and-2-slice-16)). That is 29–58× Ergo's sections. A year from the anchor is about 43–86 GB, so a Bitcoin reader is a desktop or server role, not a phone. The 2026-08-27 plan to "anchor roots, serve leaves" does not avoid this, because absence still needs exhaustion. (b) The data policy is contested at the social layer. BIP-110 failed, but filtering nodes (Knots, 21% of reachable nodes in Aug 2025) and pool policy could delay records. (c) Cost: about 1,000 sats per KB in OP_RETURN, or about 250 sats in witness, at 1 sat/vB (mempool.space recommended 1 sat/vB on 2026-10-05). Since 2025 the busiest block median was 13 sat/vB, and the 2024-04-20 halving reached medians of 491–1,178 sat/vB (mempool.space fee-rate history, [slice 20](#absence-for-one-subject-slice-20)).
- *Security note for a Bitcoin profile:* the section rule must refuse Bitcoin's duplicated-last-leaf Merkle mutation (CVE-2012-2459) and 64-byte-transaction ambiguity. It must also bind the witness commitment if records sit in the witness.

**Cheapest decisive probes, in order:**
1. *Offline policy probe* (hours, GET only). Over the last 2,016 mainnet blocks, count OP_RETURN outputs larger than 83 B and multi-OP_RETURN transactions, grouped by pool tag. **It falsifies the plan** if major pools exclude them, which would leave only the witness envelope, itself censorable by the same filters.
2. *Exhaustion probe* (a P4 analogue). Fetch about one week of blocks from two suppliers, verify headers and the txid/wtxid Merkle roots with our own code (no library decoder), and frame every transaction. Record bytes, time and memory against a desktop budget.
3. *Publication probe* on signet or testnet4, then mainnet with dust: inclusion latency of 136 B and 15.5 KB records against fee, at depth 2–3, inside the C3.3 window. Its read-only part, other parties' records watched from first sight to inclusion, [is done](#results-of-read-only-probe-3-slice-17).

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

**Spec and code if it passes:** a new normative `venue-bitcoin.md` (context such as `moe/venue/bitcoin/v1`, anchor, depth, exact-scriptPubKey or OP_RETURN-prefix locations, transaction grammar with segwit, section/root rule, retarget and timewarp header rules, ordinal, fork rule), mirroring venue-ergo §§1–10. Code: `bitcoin-headers.ts`, a framer, a `BitcoinVenue` implementing `RecordVenue`, and reference contexts (regtest or synthetic) in the v3 guard. **Construction changes: none for the venue itself**, which agrees with 2026-08-27. Two venues do raise the priority of the venue-moving record and of accepting that sets will split.

**Do not pursue now:** Cardano (PoS headers are not verifiable alone; tight transaction size), Kaspa (pruning, cheap attack), BCH (cheap attack), Monero and Zcash as venues. Litecoin is the fallback if Bitcoin's data policy fails probe 1. An Ergo-only alternative for the phone gap: a range source proportional to a subject's records, built on Ergo's **state root**. It would use a script-guarded box chain, with unspentness proven against a header, but it needs scripts and a new venue identity (WORK Next 9; weighed in [slice 20](#absence-for-one-subject-slice-20)).

### Absence for one subject (slice 20)

Measured 2026-10-12, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/dd827ef/scripts/venue/absence-probes); [decision](../decisions/2026-10.md#2026-10-12--compare-venues-on-what-a-phone-pays-to-prove-absence-for-one-subject-and-probe-a-succinct-proof-of-exhaustion-next-slice-20)). The question ([direction 2026-10-12](../decisions/2026-10.md#2026-10-12--judge-each-slice-against-a-practical-medium-of-exchange-for-ordinary-holders-and-reopen-the-second-venue-direction), item 3): what does a phone pay to prove §13.2 absence for its own subjects? Per backing, a holder has at least three: the backing name (kinds 2 and 4), the operator key (kind 1) and an obligor key (kind 3). §13.3 reads replacements and revocations from index zero, so the first sync grows with the deployment's age and the steady state grows with each day.

**Exhaustion follows the venue's carriage, not the subject's records.** §13.2 proves absence by reading every object the venue holds in the range. On a chain whose blocks commit nothing by subject, that means every transaction section. Three routes make a phone's cost follow its subjects instead:
- *A namespace commitment in each block*, such as a namespaced Merkle tree over the block's data. The phone needs one proof per block per subject, so its cost follows the number of blocks.
- *A per-subject log in the venue's state that consensus enforces.* The phone needs one proof at the range's end, so its cost follows the subject's records. The header chain can be shortened by a suffix proof.
- *A succinct proof of the exhaustion itself.* The proof shows that the scan over the range's sections matches the headers' roots and found exactly these objects. The phone checks headers, or a proof of them, and one proof. The trust stays exhaustion's and the venue is unchanged. The prover's cost, measured in [slice 21](#the-succinct-proof-of-exhaustions-prover-cost-slice-21), is about 7 hours of a 4-vCPU machine a day.

| One subject's reads | Ergo, exhaustion (today) | Ergo, state-root log (design, not built) | Celestia, namespace proofs | Bitcoin, exhaustion |
|---|---|---|---|---|
| Bytes a day | 6.0 MB of transaction sections, input proofs included (measured over 4 days; P4 found 4.1 MB in 2026-09), and 0.16 MB of headers. The runtime fetches node JSON, about 5× the section bytes in P4, so about 30 MB | 0.16 MB of headers; a few KB of lookup proofs per read; the subject's records, including whatever strangers append | 33–54 MB for a purpose-built client (estimate below); about 640 MB of extended headers for a stock light node (estimate) | 118 MB (OP_RETURN) or 236 MB (witness), and 11.5 KB of headers ([probe 2](#results-of-probes-1-and-2-slice-16)) |
| Per year of the deployment's age | 2.2 GB | 58 MB of headers checked as venue-ergo §3 checks them. With one honest prover among the suppliers, a 173 KB suffix proof instead (below) | 12–20 GB, from archival suppliers | 43–86 GB |
| What the reader checks itself | Every header's work, and every section against its root | Each header's work and the lookup proofs. It trusts that the most-work chain applied the guard script | Signatures of more than two thirds of the voting power (95 validators), then hash links and data roots back from there | Every header's work, and every block's Merkle root |
| Finality | Depth over proof of work | The same | Instant BFT, with weak subjectivity: a 7-day trusting period ([CIP-36](https://cips.celestia.org/cip-036.html)) and 14.04 days of unbonding (measured). A phone away for longer must take a checkpoint from someone | Depth over proof of work |
| Data from index zero | Full nodes keep every block by default | The log's head is current state, and records come from any supplier, checked against it | Nodes may prune after 7 days and 1 hour ([CIP-34](https://cips.celestia.org/cip-034.html)). Of two public RPCs, one held 2.4 hours and one held everything from height 1 | Full nodes keep every block |
| A 136 B record, calm | About 0.0012 ERG ($0.0004; estimate: the 0.0011 ERG fee plus the box's minimum value) | More: one log input and output, a tree proof and a rent reserve (estimate) | 238 utia, the one-share gas of the measured small blobs ($0.00014) | About 260 vB, so 260 sats ($0.22) at 1 sat/vB |
| A 15.5 KB release, calm | 0.0068 ERG ($0.002), of which 0.0057 ERG is box value that any spender recovers, so 0.0011 ERG ($0.0004) net ([measured](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node)) | The same, plus the log append | About 900 utia ($0.0005); an 18.6 KB blob paid 981 | About 15,600 sats ($13) in OP_RETURN, or about 4,100 ($3.4) in the witness |
| Congested | Not observed (judgment: blocks run far below their limit) | Contention on the subject's log (below) | Not measured | At 13 sat/vB, the busiest block median since 2025: $2.8 and $169. At 491–1,178 sat/vB, the medians at the 2024-04-20 halving: up to $256 and $15,300 |

Prices are CoinGecko's on 2026-10-12: BTC $83,505, ERG $0.329, TIA $0.596. mempool.space recommended 1–2 sat/vB, and its block fee-rate history gives the congested rows. Celestia blob transactions paid 0.004 utia per gas.

The per-subject columns multiply by the holder's subject count. Exhaustion's column does not, because one scan answers every subject.

**Celestia is no phone venue.**
- *Per-block cost:* its blocks come every 2.87 s, 30,127 a day. One namespace's absence in a block costs a 404-byte header plus 0.7–1.9 KB of proof. That is estimated from the namespaced tree's layout at the measured square widths (median 8, p90 32): the row path with its neighbouring leaf, the row root and its path to the data root, and twice that, slightly overcounted, when the namespace falls between two rows. That is 5–9 times Ergo's exhaustion for one subject, and more for three.
- *Trust:* finality is a validator vote with a 7-day trusting period. Independent verification from the anchor fails for any holder offline longer than that.
- *Retention:* nodes keep data for a week, so reads from index zero depend on archival suppliers.
- *Cost:* a 136 B record costs less than Ergo's fee alone. A 15.5 KB release costs less than Ergo's gross cost, but not less than Ergo's net cost once box value is recovered.
- *Other chains:* other data-availability chains share the per-block shape (judgment; not measured).

**Bitcoin is no phone venue under any design available today.**
- Its blocks commit nothing by subject.
- Compact block filters (BIP158) are not committed by consensus, so using them would rest on a supplier's word.
- Utreexo is not committed by consensus either, and its clients still process every block (judgment).

It keeps the strongest order for desktop and backer readers.

**Splitting ordering records from bulk publications helps no reader.** Exhaustion follows the ordering venue's whole carriage, so moving kind 4 elsewhere leaves that cost unchanged. It would also give one scope two venue clocks, against C2.10.2 ("One clock per scope"). It lowers only a publisher's cost on an expensive venue.

**An Ergo state-root log follows the subject, at a trust change.** It is a sketch, not built.
- *The log:* a guard script keeps one log head per subject: `h_n = H(h_{n−1} || HEIGHT || H(record))`. Only a transaction that carries the record at its location can append to it.
  - A script cannot see a transaction's position in its block. A kind-4 entry's ordinal (venue-ergo §6) therefore comes from a transaction inclusion proof against that block's transaction root. Each such entry costs that block's header and about log₂(n)·32 B.
- *The registry:* an `AvlTree` in one box, with each subject inserted once. It proves which box holds a subject's log, or that the subject has none.
- *What a phone checks:*
  1. its header chain, or a NiPoPoW suffix proof. The probe measured 195 KB from genesis to the tip: 149 headers with m = 6 and k = 10. Counted at the wire's 221 B a header rather than with the JSON's derived ids, that is about 173 KB. A suffix proof leaves the difficulty rule unchecked and needs one honest prover among the suppliers consulted;
  2. a UTXO lookup proof against the state root of a header at the finality depth. The probe measured 900 B for one box and 3.8 KB for four, against the current state; a stock node serves no proof against an older state root;
  3. the registry lookup;
  4. the subject's records, from any supplier, checked against the head.

It has these costs:
- **A trust change, and Ergo's concentration makes it concrete.**
  - *The trust:* the phone would accept the log head because the most-work chain applied the script, without reading the blocks.
  - *The attack:* one payout address mined 51% of recent blocks, at about $28/h on crypto51's model ([§3](#3-comparison)). That pool alone could extend a chain that leaves a revocation or replacement out of a subject's log. Full readers reject that chain; phones follow it, so the pool forges absence for them.
  - *Today's limit:* a majority miner can only reorder or drop records past the depth, and every reader sees it.
  - *No remedy reaches the phone:* AD proofs (31 MB a day) plus the block's transactions let a full reader check a block's state change, but no fault channel reaches a phone, and withheld block bodies defeat such a check.
- **Contention.** Only one transaction can spend a UTXO box, and open publication lets anyone append to any subject's log.
  - *Cost to the attacker:* a stranger can race each honest append. At the minimum fee that costs at least 0.0011 ERG per contested block, about $0.26 a day. Against fee replacement it becomes a fee war.
  - *The registry is one box,* so every new subject's first append competes globally, including a key's first revocation.
  - *Motivated attackers:* a thief of K can race K's revocation, which keeps the thief's issuance standing (C2b.1). A competitor can race an operator's commitments so that the operator looks silent.
  - *Mitigations:* several lanes per subject raise the attacker's cost linearly. Owner lanes, where a subject-bound spend key is required for kinds 1–3, defeat strangers. Whether they also defeat a thief holding K is a design choice: if K binds each lane's key once and no later binding can disable an earlier lane, a thief can add lanes but cannot spend the honest one. Kind 4 stays open to every holder.
  - *Log growth:* strangers' appends lengthen a subject's log, bounded by their fees.
- **Storage rent.** Ergo lets anyone spend a box older than 1,051,200 blocks (about four years) whose value does not cover its storage fee, by default 1.25·10⁶ nanoERG a byte (protocol rule; not re-verified against source).
  - *The risk:* an idle log, such as an obligor key that is never revoked, could then be taken and its head rewritten.
  - *The fix:* the guard must require a rent reserve on every append.
- **A specification change.** §13.2 requires that "absence is proven by exhaustion rather than reported". Relaxing that is a pool-v4 question under C0a. It would come with a new Ergo venue identity whose attribution is by log rather than by location, and scripts would enter the record path, which venue-ergo keeps free of them.

**The succinct proof of exhaustion keeps exhaustion's trust in the venue.**
- *How it works:* a prover runs §13.2's scan over a range's headers and sections, and proves in the declared proof system that the scan matches the roots. One proof per period can commit to a map from each kind and subject to its objects. A phone then checks one proof per period and a lookup per subject.
- *What it avoids:* the contended box, the rent and a new attribution rule.
- *Trust:* the phone still chooses the most-work chain among the suppliers' proofs.
  - *The proof system:* the phone also relies on the proof system's soundness and its setup. These are a primitive E already declares.
  - *The difficulty rule:* exhaustion's trust holds only if the circuit checks the difficulty rule from the anchor, as venue-ergo §3 does. Otherwise the proof inherits the suffix proof's honest-prover assumption. The probe's scope includes that check.
- *Cost:* Ergo hashes with Blake2b-256 over 64-bit words, which is costly in a BN254 circuit. Measured in [slice 21](#the-succinct-proof-of-exhaustions-prover-cost-slice-21): a day's sections take a 4-vCPU prover about 7 hours; its headers' Autolykos checks would take 195, so the phone checks them itself.
- *Specification:* it too needs §13.2 to admit a verified proof in place of retained evidence, a pool-v4 question.
- *Fit:* it shares machinery with the succinct relation that a phone already needs for the kind-4 trail.

**The venue is one of a phone's two costs.** A backing's kind-4 publications are its pool's trail: 15.6 GB at the design point, the larger part. A route above makes the venue part proportional, but reading the trail still needs the succinct relation (WORK Next 9).

**Recommendation (judgment).**
- *Release venue:* Ergo stays the release's venue.
- *Next probe:* the succinct proof of exhaustion. It is the cheapest decisive probe and can run in the cloud. It measures the declared proof system's proving cost for Blake2b-256 per byte and for an Autolykos header check, scaled to a day of Ergo sections, against what a volunteer or operator prover could carry. Done in [slice 21](#the-succinct-proof-of-exhaustions-prover-cost-slice-21): it passes.
- *The state-root log is the fallback,* if that cost fails (it did not, [slice 21](#the-succinct-proof-of-exhaustions-prover-cost-slice-21)). Its testnet probe must pass three gates:
  1. the attacker's cost per block of delay, against a demand's C3.3 window and a key thief's gain;
  2. rent reserves;
  3. no single miner holds a majority of recent blocks when the log is adopted, re-measured then. Today this gate fails: one address mined 51% of recent blocks.
- *If neither route passes,* a phone's absence stays at Ergo's exhaustion: about 2 GB a year from the anchor, workable in steady state on Wi-Fi but heavy for a first sync.
- *Not pursued as venues:* Celestia and other namespaced data-availability chains.
- *Bitcoin:* its mainnet publication (real funds; Open questions) stays held. A Bitcoin-venue backing cannot reach phone holders, so it serves only desktop-held backings that want its security budget. That case is weighed after the phone path is decided.

**Limits.**
- *Windows and snapshots:* four days of Ergo, one day of Celestia, and one snapshot of fees and prices.
- *Celestia estimates:* proof sizes come from the tree layout, not from fetched proofs. The stock light node figure assumes about 110 B per commit signature and 80 B per validator entry.
- *NiPoPoW size:* the probe counted the node's JSON fields, so the wire size is estimated.
- *Ergo's 6.0 MB:* it includes input proofs that venue-ergo §4 does not need, so the true minimum is lower.
- *Not measured or not re-verified:* the log's costs and the succinct prover's cost are not measured (the prover's since measured, [slice 21](#the-succinct-proof-of-exhaustions-prover-cost-slice-21)), Ergo's rent and mempool-replacement rules are not re-verified, and Ergo congestion was not observed.

### The succinct proof of exhaustion's prover cost (slice 21)

Measured 2026-10-12, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/9c7fc6f/scripts/venue/succinct-probe); [decision](../decisions/2026-10.md#2026-10-12--prove-ergos-sections-not-its-headers-a-day-of-exhaustion-costs-a-4-vcpu-prover-about-7-hours-slice-21)). The question: can a prover carry §13.2's exhaustion over a day of Ergo in the declared proof system (pool-v3 §4: UltraHonk over BN254, Barretenberg 5.2.0, Noir 1.0.0-beta.26), so that a phone checks a proof instead of reading every section?

**The headers stay with the phone.** One Autolykos v2 check is 2,152 Blake2b-256 compressions: 33 of its hashes each cover the 8,192-byte constant `M` (65 compressions apiece). A day's headers need 1.55 million compressions, 29 times the 53,391 that a day's sections need. A reader checks them natively in 11.2 ms a header: 8 s per day of chain, or 49 minutes per year of a deployment's age, on one core of the probe host in JavaScript. Today's reader already makes this check, and the headers are the 0.16 MB a day that every route in the [slice 20 table](#absence-for-one-subject-slice-20) keeps. So the proof covers only the sections against their headers' transactions roots and the scan over them. The phone still checks every header's work and the difficulty rule from the anchor, as venue-ergo §3 requires, so exhaustion's trust holds without proving the headers.

| Measured (one 4-vCPU Xeon at 2.10 GHz, 15 GB) | Value |
|---|---|
| Blake2b-256 in Noir over 64-bit words, per 128-byte compression | 32,941 gates (257 a byte); every digest matched `@noble/hashes` |
| Barretenberg's Blake2s black box, for comparison | 50 gates a byte |
| UltraHonk proving with a precomputed key, 4 threads | 2^20 rows 13.2 s; 2^21 rows 24.3 s; 2^22 rows 46.6 s at 3.8 GB peak: 11.1 µs per row, linear |
| One recursive verification of a `noir-recursive` proof | 0.77 million gates (two in one circuit: 1.47 million, proved in 28.4 s); a tampered inner proof fails |
| A day of Ergo mainnet (1,440 blocks to height 1,892,905) | 721 blocks, 4,832 transactions, 3.81 MB unsigned (4.34 MB signed); 32,659 compressions for transaction ids, 19,290 for the transactions-root trees over ids and witness ids, 1,442 for header ids |
| A proof | 14,656 bytes; native verification 16 ms |

**A day costs a 4-vCPU prover about 7 hours.** A chain of proofs, each of 2^22 rows verifying its predecessor, leaves room for 103 compressions apiece. A day's sections then take 519 proofs and 6.7 hours, so one such machine keeps up with Ergo 3.6 times over. Proving the headers too would take 15,069 proofs and 195 hours a day, about eight such machines, for a check the phone makes in seconds. Two figures bound the estimate:
- *Room to improve:* Barretenberg's own Blake2s gadget costs a fifth of the Noir Blake2b's gates per byte. A Blake2b gadget of the same efficiency, which neither Noir nor Barretenberg offers today, would bring a day to about 1.3 hours (estimate).
- *Margin:* the attribution scan, which parses every transaction's outputs and was not measured, doubles the cost only if it needs 461 gates per unsigned byte. Parsing in a circuit normally costs tens of gates a byte (judgment).

**A phone's reads become headers and one proof.** A day costs 0.16 MB of headers, a 14.7 KB proof for each period and a lookup for each subject in the map the proof commits to (estimate: under 1 KB). Today it costs 6.0 MB of sections, about 30 MB as node JSON. A year of age costs 58 MB of headers and the period proofs, against 2.2 GB today; folding past periods into one proof leaves the headers. That matches the state-root log's phone cost without its trust change, contention, rent or new attribution rule.

**Trust and roles.**
- *Who proves:* anyone with the blocks, such as an operator, whose reader already reads them. Proofs carry no authority.
- *Withholding:* a prover that withholds only delays a phone, which can fall back to reading the sections itself, as today.
- *Forging:* forging absence needs a false proof, so it relies on the proof system's soundness and its Ignition setup. E already declares both for every statement.

**Not measured here; the next steps.**
- *The exhaustion relation itself:* venue-ergo's attribution of outputs to a kind and subject over the unsigned bytes, the map by kind and subject with its lookups, the link from each header id to its child, and the folding of periods.
- *The specification:* §13.2 asks the verifier to establish the answer "from retained venue evidence" so that "absence is proven by exhaustion rather than reported". A proof of the same attribution rule over the same chain changes no verdict. Whether a pinned relation's proof meets that contract as a later venue-ergo version, or needs pool-v4, is the C0a slice's question.

**Limits.**
- *Host:* one host and one run of each size; timings compare only on this host.
- *Gadget:* the Noir Blake2b is straightforward, not tuned.
- *Not measured:* the attribution scan, the map and the period fold.
- *Window:* two days of Ergo. The cost grows with Ergo's use, linearly in unsigned bytes and transactions.

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
