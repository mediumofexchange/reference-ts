# Ergo venue profile

The specification selects the Ergo venue profile for
[pool-v3 §13](https://github.com/mediumofexchange/money-from-first-principles/blob/13e5b66/pool-v3.md#13-record-range-evidence)
record-range answers, and its rules are normative in
[venue-ergo.md](https://github.com/mediumofexchange/money-from-first-principles/blob/13e5b66/venue-ergo.md)
([decision](../decisions/2026-09.md#2026-09-25--select-the-ergo-venue-profile-for-pool-v3-record-ranges)).
This guide maps those rules to the model, the experiments and their
evidence, and records the measured costs and limits. The model implements the
profile, but no runtime path reads it yet: the v2 runtime's `src/ergo.ts`
keeps its own identity (`moe/venue/ergo/v1`), its height-as-index convention
and its materialized view, and v2 backings keep them.

## Where each rule is implemented

| Rule (venue-ergo.md) | Model | Tests and evidence |
|---|---|---|
| §1 identity and parameters | `ergoProfileIdentity`, `ownProfile` in `model/pool-v3-ergo-profile.ts` | `test/pool-v3-ergo-profile.test.ts` |
| §2 index, finality, lag | `ergoRangeVerifier` (origin, `witnessedIndex`), `ergoLag` | same; [latency](POOL_DEPLOYMENT_PROBES.md#inclusion-latency-on-the-mainnet) |
| §3 header chain | `ergoHeaderStore`, `parseErgoHeader`, `eip37Difficulty`, `autolykosHit` in `model/pool-v3-ergo-headers.ts` | `test/pool-v3-ergo-headers.test.ts`; [reader-verified headers](POOL_DEPLOYMENT_PROBES.md#reader-verified-headers) |
| §4 block sections | `sectionMatchesRoot`, `transactionsRoot`, `merkleRoot`; section acceptance in `ergoRangeVerifier` | profile experiment; [P4](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor) |
| §5 transaction grammar | `frameTransaction`, `frameTree`, `frameCollBytes` | [hostile framer probe](POOL_DEPLOYMENT_PROBES.md#hostile-input-node-equivalence) |
| §6 attribution, reassembly, ordinal | `attributeOutput`, `attributeOwned`, `ergoOrdinal`, `collBytes` | profile experiment; [P2](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node) |
| §7 answers | `ergoRangeVerifier(...).range` over `model/pool-v3-range.ts` | local replay adapter |
| §8 publishing | [kind-4 capacity](ergo-range-profile-verification.json) | [decision](../decisions/2026-09.md#2026-09-15--a-configurations-publications-fit-one-ergo-transaction) |

The range verifier takes any linked header chain, so the harnesses can feed
it synthetic headers; under the profile the chain is the header store's best
chain.

## Header source

`model/pool-v3-ergo-headers.ts` is the reader's own header source (§3 of the
profile): `ergoHeaderStore(anchorId, context)` takes the anchor's context,
`add(bytes)` accepts one header from any supplier or names its refusal
(`malformed`, `unknown-parent`, `below-anchor`, `height`, `timestamp`,
`difficulty`, `pow`), and `best()` returns the heaviest chain's headers from
the anchor's child for `ergoRangeVerifier`. The node checks a block's
version against the voted parameters only at a voting epoch's first block,
so a miner can carry any version byte mid-epoch; the store therefore reads
every version in the node's layout for it (a new-fields length for 2–127,
read above 4, and an Autolykos v1 solution for version 1), and
`ergoRangeVerifier` reads every block's section. The node takes a section's
root rule (ids alone, or ids then witness ids) from the section's own
serialization, not the header, so `sectionMatchesRoot` accepts either. No
version byte or root rule a miner chooses can strand the reader or deny a
range. A node the reader runs is a
supplier like any other ([own node](POOL_DEPLOYMENT_PROBES.md#own-node-as-the-header-source)).
The node's upstream v6.0.6 sources are the reference for the difficulty and
work arithmetic, checked on real mainnet headers from three nodes and every
EIP-37 recalculation of the window
([reader-verified headers](POOL_DEPLOYMENT_PROBES.md#reader-verified-headers)).

Without the node's clock bound a supplier can lower the required difficulty
on a side branch by stating future timestamps: after about 256 blocks of work
at the starting difficulty it halves each epoch. Such a branch never outscores
the best chain's work, but the store accepts and keeps its headers, one work
check each (about 21 ms a header in pure JavaScript). The profile makes
supplier choice and per-supplier budgets reader policy; the runtime adoption
fixes that policy (for instance, reading a supplier only while it extends
the best chain or competes within a bounded distance of its tip). NiPoPoW
proofs add nothing here: the verifier needs every header from the anchor's
child, and the anchor already fixes the ancestry a proof would summarize.

## Costs and limits

- The reader runs no decoder, so no decoder's refusal denies a range. Until
  2026-09-24 it decoded with sigma-rust, first unpinned and then as a
  [contained](POOL_DEPLOYMENT_PROBES.md#contained-decoder) release build, and
  every transaction the library refused left its block without a section: 125
  mainnet transactions in 58 blocks of one week under the 0.28.0 control,
  and on hostile bytes the node reads, refusals by type checks, opcodes and
  value bounds the node does not apply
  ([decision](../decisions/2026-09.md#2026-09-24--read-venue-transactions-as-unsigned-bytes-through-the-profiles-own-framer)).
  The framer's price is the grammar: a record outside it is not read.
- A supplier derives the unsigned bytes, and runs no decoder either. The
  public node API serves transactions as JSON, and every field the unsigned
  bytes carry is there as exact hex (box and token ids, trees, register and
  extension constants) or an integer, so `supply.mjs` writes them by copying,
  parsing no constant; the witness id hashes the stated proofs. Two
  properties of the text matter: integers above 2^53, read from their source
  text, and each spending-proof extension's key order, which the node writes
  in its map's order and a JSON object model sorts (2,272 inputs of the
  measured week carry several entries), so the text is read by a small
  order-keeping parser. A copy that does not hash to the stated id is
  unsupplied, never misread; every transaction of the measured week, and of
  the testnet publication run, is supplied
  ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)).
  The header root, not the supplier, authenticates the unsigned bytes and
  the witness id.
- A kind-4 object is one transaction's run, so a publication must fit one
  transaction. Under this layout a box carries a 3,981-byte piece within
  Ergo's 4,096-byte box limit, and one transaction under the pinned node's
  98,304-byte mempool policy carries 24 pieces, 95,544 bytes of
  publication ([measured](ergo-range-profile-verification.json)). §13's
  kind-4 ceiling of 131,914 bytes is the frame's parser bound over pool-v2
  §12's generic 131,072-byte proof limit; a configuration fixes its proof
  size through its pinned keys (pool-v3 §11.1), and every retained relation
  proves in 14,656 bytes, so the largest publication is a release of 15,498
  bytes in four pieces. A configuration is publishable here only where its
  largest publication fits one transaction, which holds for any proof up to
  94,702 bytes; that is an adoption condition of the profile, not a change
  to the frame ([decision](../decisions/2026-09.md#2026-09-15--a-configurations-publications-fit-one-ergo-transaction)).
  Signed under this layout with the pinned build, a full piece box is 4,095
  bytes and a four-piece release transaction about 16,077 bytes; under the node's
  dust rule (its votable `minValuePerByte` over the full box bytes, 360 on
  the testnet) a full piece box needs 1,474,200 nanoERG and a release
  5,743,440 plus the fee, which sigma-rust's candidate-only estimate
  understates by 33 bytes a box. The public testnet node accepted a release,
  its reassembly cases and their sweep at exactly those values
  ([P2](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node)).
- Exhaustion costs the range's block bytes. The replacement chain and a
  revocation are read from index zero (§13.3), which is the anchor's child:
  the cost is bounded by the deployment's age rather than the chain's
  ([decision](../decisions/2026-09.md#2026-09-21--index-the-ergo-venue-from-a-pinned-anchor-header)),
  and the reader may keep its own answers while the finality rule stands, so
  it is paid once per venue and then per new block. The reader retains every
  header from the anchor's child onward. Measured on mainnet
  ([P4](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor)):
  seven days from a real anchor are 5,040 blocks at 716 a day carrying
  28,196 transactions in 26.6 MB of sections, a mean of 5,286 bytes
  a block with a median of 424 and a largest of 193,531; each header is
  220 or 221 wire bytes (mean 220.9), 105 in the verifier's view, so a year
  of headers is about 58 MB and a year of sections about 1.4 GB at that
  rate. Built from a week's sections the verifier answers a range over all of
  them in a few milliseconds; building it, where every transaction is hashed
  and framed and every framed output scanned, is the reader's whole work
  over the bytes, measured in [P4](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor).
  The framer is one pass linear in the bytes and allocates nothing a count
  claims.
- The header source is the reader's trust boundary, and the reader can hold
  it itself: its [header store](#header-source) verifies each header's work
  from the anchor, one Autolykos v2 check a header in pure JavaScript, and
  keeps the header bytes beside the verifier's view
  ([measured](POOL_DEPLOYMENT_PROBES.md#reader-verified-headers)); what
  remains trusted is that the heaviest chain it is shown is the network's.
  Objects at the locations before the anchor are not in the record.

## Evidence

`npm run check:ergo:range` runs `experiments/ergo-range/profile-check.mjs`
after the block-root experiment and the supplier check (`supply-check.mjs`:
every fixture transaction supplied under its id, the roots reproduced, and
each shape the copy cannot reproduce unsupplied). It compiles the model, reads
the pinned real mainnet genesis header as an anchor, builds a twelve-height
synthetic chain anchored at its first header whose unsigned bytes Fleet
writes and whose outputs the framer reads exactly as written, with real signed
commitments, a replacement, revocations and single- and multi-piece
publications in register constants, and checks the answers, the reader's
rules over them, refusals for unwitnessed, gapped, unlinked and substituted
evidence, tolerance of stray, duplicate and root-failing blocks, a
transaction outside the grammar that keeps its block's section, and the four
mainnet fixture blocks through the same verifier as index 0 under their
parents as anchors: Fleet's unsigned bytes hash to the node's ids, the roots
reproduce for block versions 1, 3 and 4, the framed real transactions read
the node's outputs, the later blocks' fee outputs use the framer's fee tree,
and the real register constants read beside sigma-rust's constant decoder.
The [retained report](ergo-range-profile-verification.json) records the
sizes. `test/pool-v3-ergo-profile.test.ts` covers the identity, the framer's
grammar and refusals, register reading, the tree, attribution and reassembly
cases, ordering, the anchor and origin rules, the block versions, ownership
of the profile, evidence and request, and every refusal without an Ergo
library.

## Local replay adapter

`npm run check:pool:ergo-replay` runs every local replay group of
`scripts/pool/v3/local-check.mjs` a second time through the profile's model: the
single-backing import, payment and burn traces with and without silence, the
two-backing scope and scope-recovery histories, receipts, non-service counts,
compact fault evidence and returning segments with their adopted blocks. The
optional dependencies and commands are in the
[harness guide](../scripts/pool/v3/README.md). The
[retained replay report](pool-v3-local-replay-verification.json) records the
groups, the kind-4 subjects and the cross-backing union positions that agree,
and the refusals: fresh seedless audit and receiver restoration, missing
sections, framable root mismatches, malformed transactions, wrong profile/headers
and resource refusal. The fixture converter constructs exact unsigned
transaction bytes, witness ids and expected roots with Fleet, independently
of the profile verifier: the fixed synthetic genesis is the anchor, fixture index `i` is
height `i + 2`, a fixture venue of lag `l` is read under depth `l − 1`, and
each fixture record is a separate transaction in the fixture's insertion
order, so a kind-4 ordinal is the fixture's ordinal shifted by 32 bits and
every other field of a result is identical. Because of that layout the
replay never places two records in one transaction; adjacency, run
boundaries and over-bound runs are exercised by the unit tests and the
profile experiment only. Synthetic headers are selected separately by the
reader; they have never been accepted by a node.

`experiments/ergo-range/replay-venue.mjs` binds a reader-selected profile,
header source and answer budget to the existing range interface. The supplier
provides block sections, each transaction as one byte string (its 31-byte
witness id, then its unsigned bytes), not transaction ids, decoded outputs,
clocks or answers. The synchronous factory owns all evidence before returning or awaiting
proof work. Each byte view is charged before its immediate copy, using intrinsic
typed-array length and storage checks; shadowed properties cannot hide shared
storage or an oversized view, and later getters cannot resize or detach an
already owned view. Detached, out-of-bounds and shared views refuse. The adapter
caps source bytes at 8 MiB, headers and supplied blocks at 256 each, and total
transactions at 1024, before the model reads any of it. These are local
experiment limits, not consensus bounds; since the model hashes and frames
each transaction once in time linear in its length, they also bound a
read's work. Budget or storage refusal
rejects the whole read, even if the offending block would otherwise be ignored.
The worker's separate V8 IPC envelope remains capped at 2 MiB.

A transaction too short to hold a witness id and a transaction makes its
block malformed, passed over like any other; a transaction outside the
framer's grammar carries no record. The model then checks roots
and range completeness. Successful replay reports
`rangeEvidence: "candidate-ergo-profile-synthetic-headers"`; currency and
authority flags describe only checks under that explicit trusted fixture.
Full replay, complete-certificate and spendability flags remain false. This
integration introduces no production path or normative rule.

## Before runtime adoption

The profile is selected; what remains is the runtime's reading of it in
place of the v2 materialized view: the header store and range verifier moved
behind the runtime's venue interface, the supplier policy above, the
reference default depth of 10
([decision](../decisions/2026-09.md#2026-09-25--select-the-ergo-venue-profile-for-pool-v3-record-ranges)),
the framer's grammar checked against the deployment's own publishing
transactions, and the one-transaction condition checked against the adopted
configuration. Publication on the mainnet, and a latency distribution of
kind-4 publications at their size and fee, are not yet measured: A10 timed
the mainnet's own transactions, and P2 made two correlated testnet
observations.
