# Ergo venue profile

The specification selects the Ergo venue profile for
[pool-v3 §13](https://github.com/mediumofexchange/money-from-first-principles/blob/13e5b66/pool-v3.md#13-record-range-evidence)
record-range answers, and its rules are normative in
[venue-ergo.md](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md)
([decision](../decisions/2026-09.md#2026-09-25--select-the-ergo-venue-profile-for-pool-v3-record-ranges)).
This guide maps those rules to the runtime, the experiments and their
evidence, and records the measured costs and limits. The runtime reads Ergo
only under the profile: `ErgoVenue` in `src/ergo.ts` is the
[runtime venue](#runtime-venue), and the earlier view over a node's box index
(`moe/venue/ergo/v1`), which trusted that node for completeness, is retired
([decision](../decisions/2026-09.md#2026-09-25--read-ergo-in-the-runtime-only-under-the-selected-profile)).

## Where each rule is implemented

| Rule (venue-ergo.md) | Implementation | Tests and evidence |
|---|---|---|
| §1 identity and parameters | `ergoProfileIdentity`, `ownErgoProfile` in `src/ergo-profile.ts`; `ergoProfile` (default depth) in `src/ergo.ts` | `test/ergo-profile.test.ts`, `test/ergo-venue.test.ts` |
| §2 index, finality, lag | `ErgoVenue.sync`/`witnessedIndex`/`lag` | same; [latency](POOL_DEPLOYMENT_PROBES.md#inclusion-latency-on-the-mainnet) |
| §3 header chain | `ergoHeaderStore`, `parseErgoHeader`, `eip37Difficulty`, `autolykosHit` in `src/ergo-headers.ts` | `test/ergo-headers.test.ts`; [reader-verified headers](POOL_DEPLOYMENT_PROBES.md#reader-verified-headers) |
| §4 block sections | `attributeSection`, `sectionMatchesRoot`, `transactionsRoot`, `merkleRoot` | `test/ergo-profile.test.ts`, `test/ergo-supplier.test.ts`; [P4](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor) |
| §5 transaction grammar | `frameTransaction`, `frameTree`, `frameCollBytes` | [hostile framer probe](POOL_DEPLOYMENT_PROBES.md#hostile-input-node-equivalence) |
| §6 attribution, reassembly, ordinal | `attributeOutput`, `attributeOwned`, `ergoOrdinal`, `collBytes` | `test/ergo-profile.test.ts`; [P2](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node) |
| §7 answers | `rangeEntries` over `src/record-range.ts`, from `ErgoVenue.range` (a `RecordVenue`, `src/record-venue.ts`) | `test/ergo-profile.test.ts`, `test/ergo-venue.test.ts`; [local replay](#local-replay-through-the-venue) |
| §8 publishing | [kind-4 capacity](ergo-range-profile-verification.json) | [decision](../decisions/2026-09.md#2026-09-15--a-configurations-publications-fit-one-ergo-transaction) |

`ErgoVenue` is the one Ergo reader: it answers only from headers its own store
accepted and sections that reproduce their roots, including in the harnesses,
which serve it the synthetic reference chain
([decision](../decisions/2026-09.md#2026-09-25--promote-the-v3-state-machine-and-single-segment-reader-and-read-ergo-only-through-ergovenue)).

**Reference contexts.** venue-ergo's identity hashes its own context,
`moe/venue/ergo/v3`, and names the mainnet chain under the mainnet header
rules. A profile may instead name one of a closed set of reference-only
contexts, which are not deployment profiles; each hashes to another identity
and selects its header rules, so which chain an identity names is read from
its preimage, never from its 32 bytes
([plan](../decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2),
decision 8). `moe/venue/ergo-synthetic/reference` (`ERGO_SYNTHETIC_REFERENCE`)
names the synthetic chain (`src/ergo-synthetic.ts`, reference tooling for
the tests and the local replay) under the mainnet rules, and `ErgoVenue`
reads it only above an anchor of difficulty 1: no mainnet header has it, and
a header id commits to its ancestry, so a profile naming the synthetic
context cannot follow the mainnet. `moe/venue/ergo-testnet/reference`
(`ERGO_TESTNET_REFERENCE`) selects the pinned testnet rules below;
`ownErgoProfile` refuses every other context. Beside them,
`moe/venue/local/reference` (`LOCAL_REFERENCE`, `src/record-venue.ts`) names
a `FixtureVenue` by a 32-byte label and its lag, with no header rules. The
pool-v3 candidate runs only on a venue whose identity its guard recomputes
from one of these preimages (`src/pool/v3/guard.ts`); venue-ergo's own
context is refused there.

The reference testnet context selects v6.0.6's legacy predictor: 45-second
target, epochs of 128, eight-epoch lookback, fallback difficulty 1, compact
normalization, without EIP-37's average or clamps. The header store requires
the same 1,024 predecessors plus anchor, with testnet anchor height at least
1,025. It preserves the pinned source's signed-Int prediction point at the
terminal epoch and difficulty reset to 32 at child height 2,147,483,647.
Version 1 still uses Autolykos v1 and every other version v2. Mainnet defaults
and identities remain as specified in venue-ergo.

The testnet anchor is an independently selected trust input. Its context
binds the selected chain and rules; a hash cannot prove an arbitrary anchor's
network. The explicit live checks use the controlled own testnet node, check
its release/network and current-chain anchor readback, and choose depth 2.
That depth carries no production-finality or mainnet-latency claim. Pre-anchor
ancestry, full block validity and the heaviest chain the supplier withholds
remain light-client trust limits. See the
[decision and reviewed alternatives](../decisions/2026-09.md#2026-09-27--read-the-reference-testnet-through-its-pinned-header-rules).

## Header source

`src/ergo-headers.ts` is the reader's own header source (§3 of the
profile): `ergoHeaderStore(anchorId, context)` takes the anchor's context,
`add(bytes)` accepts one header from any supplier or names its refusal
(`malformed`, `unknown-parent`, `below-anchor`, `height`, `timestamp`,
`difficulty`, `pow`), and `best()` returns the heaviest chain's headers from
the anchor's child, which `ErgoVenue` reads sections by. The node checks a block's
version against the voted parameters only at a voting epoch's first block,
so a miner can carry any version byte mid-epoch; the store therefore reads
every version in the node's layout for it (a new-fields length for 2–127,
read above 4, and an Autolykos v1 solution for version 1), and
`ErgoVenue` reads every block's section. The node takes a section's
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
supplier choice and per-supplier budgets reader policy; the runtime venue's
policy is [below](#runtime-venue). NiPoPoW
proofs add nothing here: the verifier needs every header from the anchor's
child, and the anchor already fixes the ancestry a proof would summarize.

## Costs and limits

The reference-testnet header check is
[`testnet-header-check.mjs`](../experiments/ergo-range/testnet-header-check.mjs).
Its [source-bound report](ergo-testnet-header-verification.json) records a
contiguous real window, every recalculation in that window and fresh own-node
tip agreement. It takes an independently pinned anchor and applies the runtime
store to every descendant. Terminal signed-Int arithmetic and activation reset
are covered by hostile unit fixtures, rather than the current-height window.
This is header evidence only; the [live journal report](pool-v3-testnet-verification.json)
separately records publication and public supply verification.

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
  extension constants) or an integer, so `src/ergo-supplier.ts` writes them by copying,
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

`test/ergo-supplier.test.ts` supplies every fixture transaction and header
under its id, reproduces the fixture roots and leaves each shape the copy
cannot reproduce unsupplied. `test/ergo-profile.test.ts` covers the
identity, the framer's grammar and refusals, register reading, the tree,
attribution and reassembly cases, ordering, the anchor and origin rules, the
block versions, ownership of the profile, evidence and request, and every
refusal without an Ergo library. The
[hostile framer probe](POOL_DEPLOYMENT_PROBES.md#hostile-input-node-equivalence)
checks the framer's outputs against the pinned node's own parser.

The range-profile experiment (`profile-check.mjs` under `npm run
check:ergo:range`) drove the profile over a synthetic chain whose bytes Fleet
wrote and over the four mainnet fixture blocks, reading register constants
beside sigma-rust's decoder. It retired on 2026-09-25: the unit tests above
and the node's own parser cover what it checked. Its
[report](ergo-range-profile-verification.json), with sources at
[1b4857a](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/experiments/ergo-range),
keeps the kind-4 capacity measurement.

## Local replay through the venue

`npm run check:pool:ergo-replay` runs every local replay group of
`scripts/pool/v3/local-check.mjs` a second time through `ErgoVenue`: the
single-backing import, payment and burn traces with and without silence, the
two-backing scope and scope-recovery histories, receipts, non-service counts,
compact fault evidence and returning segments with their adopted blocks. The
commands are in the [harness guide](../scripts/pool/v3/README.md), and the
[retained replay report](pool-v3-local-replay-verification.json) records the
groups, the kind-4 subjects and the cross-backing union positions that agree.

The reader chooses the profile (the synthetic reference context at depth 1)
and the anchor's context, both from `src/ergo-synthetic.ts`, identical in every
process. The package's venue data is a chain of blocks: `ErgoVenue` syncs from
a supplier serving it, verifies every header under the mainnet rules at
difficulty 1 from the reader's anchor, and reads every section that
reproduces its header's root. At difficulty 1 anyone can mine a heavier
branch from the anchor, so the reader also pins the id of the block its clock
must stand on, held beside its keys as it once held the headers themselves:
a venue whose clock stands elsewhere gives no answer. The converter (`scripts/pool/v3/ergo-check.mjs`)
writes the fixture's records into that chain under the same indices: index `i`
is the block `i + 1` above the anchor, a fixture venue of lag `l` is read under
depth `l − 1`, and each fixture record is a separate transaction in the
fixture's insertion order, its unsigned bytes written in the node's layout
independently of the profile's framer, a kind-4 record split into outputs of
at most 3,981 bytes. So a kind-4 ordinal is the fixture's ordinal shifted by 32
bits and every other field of a result is identical. Because of that layout the
replay never places two records in one transaction; adjacency, run boundaries
and over-bound runs are exercised by the unit tests only.

The refusals on the primary group: missing, root-failing and malformed
sections stop the clock before them; a chain that does not descend from the
reader's anchor adds no header; a heavier branch re-mined from the anchor
without a record is refused by the pin, alone or beside the pinned chain; a profile at another depth names another
venue; a judging index past or before the witnessed one; a retained-bytes
budget below the records; an answer past the reader's budget (a resource
refusal); and fresh seedless and receiver processes that verify the package's
blocks themselves. An honest supplier's section is read beside a tampering
one's. Successful replay reports `rangeEvidence: "ergo-venue-synthetic-chain"`;
currency and authority flags describe only checks under that synthetic chain,
whose headers no node has accepted. Full replay, complete-certificate and
spendability flags remain false.

## Runtime venue

`new ErgoVenue(profile, anchorContext, policy?, publisher?)` implements the
runtime's `Venue`, neutral `RecordVenue` and `RecordPublisher` interfaces for
any backing whose **E** declares the profile's identity;
`ergoProfile` applies the reference default depth of 10
([decision](../decisions/2026-09.md#2026-09-25--select-the-ergo-venue-profile-for-pool-v3-record-ranges)),
and `ergoAnchorContext` takes the anchor's 1,024-header context from any
supplier, authenticated by linkage alone. `sync(suppliers)` is asynchronous
and incremental; every read is synchronous, from the last complete snapshot,
which a running or failed sync leaves in place.

- **Suppliers** (`src/ergo-supplier.ts`): `ErgoSupplier` is header bytes by
  height and a block's section by header id; `ergoNodeSupplier(url)` copies
  them from a node's REST JSON (GET only, bounded responses, answers cut to
  what was asked). A supplier that throws, rejects, does not settle within
  `supplierTimeoutMs` (60 s) or answers with anything else, hostile getters
  included, does not supply; only supplier calls and the reading of their
  answers are guarded, so the reader's own failures stay visible.
- **Headers**: each supplier is asked from the depth below the lower of the
  best tip and its own (so a heavier shorter chain is seen), in requests of
  `headersPerRequest` (500), steps back while its chain does not connect,
  and adds at most `headersPerSupplier` (2,000, about 42 s of work checks)
  per sync; accepted headers are kept, so a longer heavier chain arrives
  over several syncs and one supplier's side branches never spend another's
  budget. A refused header stops that supplier for the sync. Every new
  header a supplier added that is off the best chain at the end of that
  sync counts against its `sideHeadersPerSupplier` (20,000 over the view's
  life, per supplier object, so callers reuse their suppliers); past it the
  supplier is not read and is withholding, which bounds what a cheap
  future-timestamp side branch can cost in work and memory, while a branch
  that briefly leads charges an honest supplier only its headers past the
  fork.
- **Clock**: the snapshot's index is the lowest of the best chain's final
  index, the last index whose section and every earlier one are held, and,
  for a supplier its header budget stopped before its tip at or above the
  clock, the index where its last header meets the best chain: the reader's
  own budget can never make it witness a block that a heavier chain it has
  not finished reading would unwitness. A fork below the clock bounds
  nothing, since that chain, were it heavier, fails the venue either way.
  Only the header budget's stop bounds the clock: it takes a budget of
  headers with their work, while failing, or claiming a tip never served,
  costs nothing and is withholding. A withheld or root-failing section
  stops the clock before its block: the view is stale, as every earlier
  snapshot was, never empty. A supplier that misses one section is not
  asked again in that sync. `sectionBytesPerSync` (256 MiB) ends a sync's
  section reading once that many bytes were received, matching or not;
  `retainedBytes` (256 MiB, each object's record, subject and a fixed
  overhead) stops the clock where it would be exceeded, reported as
  `unresolvedReason: "retained budget"`, until the budget is raised.
- **Failure**: if the best chain leaves the block the clock stands on, the
  reorganization passed the depth (§13.2): every read and later sync
  refuses with `VenueError`, and the reader needs a new view.
- **Reads**: commitments are pool-v3 §13.3's held commitments (a sequence
  held only above zero, so `nextSequenceFor` starts at one, as pool
  commitment sequences do); replacements are every kind-2 object that
  decodes and names the backing, for the walk to judge; revocations are the
  kind-3 objects that decode, name the key and verify. Every subject is
  answered by exhaustion, so no subject is registered before a sync.
  `range(request, limits)` is the §13 answer from the same sections, a
  `RecordVenue` answer: undefined where the view cannot answer, and a
  `RangeLimitError` past the caller's budget. The profile carries no
  transparent operation or commit records, and the view refuses those reads
  rather than answering empty, so the frozen transparent path has no Ergo
  venue.
- **Publishing** (`src/ergo-publisher.ts`): a view given an `ErgoPublisher`
  exposes neutral `publishRecord(kind, subject, bytes)` for kinds 1–4.
  Kind 4 uses a maximal adjacent same-subject output run in one transaction;
  each complete box fits 4096 bytes, and the complete signed transaction must
  fit the pinned v6.0.6 node's 98,304-byte limit (`application.conf`). The larger
  §13 record limit is a reading bound, not a promise that every such record can
  be published. Oversized transactions refuse before signing or submission.
  Raw publication checks kind, subject and record dimensions;
  signatures and force are the reader's checks under §6. The older typed
  commitment and revocation helpers additionally refuse invalid signatures.
  It publishes one transaction per record, with
  every output created at the tip of the chain the view verified. The
  publisher holds one funding key, a secp256k1 scalar that pays fees and box
  minimums and nothing else, and builds the transaction in §5's grammar:
  plain boxes of the key as inputs, output 0 the record (or its first piece) at its location with
  `R4` the subject and `R5` the record at the network minimum (360 nanoERG a
  byte of the full box), change to the key where it reaches its own minimum
  (otherwise it joins the fee), and the fee (1.1 mERG by default) at the
  miner-fee tree. It signs every input with Ergo's proveDlog Schnorr proof
  over the unsigned bytes on `@noble/curves` (the hedged nonce mixes the key,
  the message, the input position and fresh randomness), verifies each
  proof before it leaves, and broadcasts through `ErgoPublishingSupplier`s:
  `ergoNodePublisher` reads the key's boxes from the node's index
  (`extraIndex`, oldest first over ten pages of 100, so dust sent later
  cannot hide the funding), shows boxes through its UTXO set with the
  mempool, and submits bytes. A box counts only as bytes hashing to its id,
  and one a supplier offers is skipped where any supplier answers that it
  lacks it; a supplier that lies costs a publication, never funds (Ergo
  balances values exactly), and one that denies every box stops publication
  visibly. **One transaction per record:** it is built once and remembered
  before it is first sent; a retry after a lost answer, an outage or a drop
  sends the same bytes, after any unsettled transaction whose change it
  spends, so no second, non-conflicting transaction for the record exists.
  A transaction a supplier holds (mempool or blocks) or whose record box it
  shows counts as sent, so a landed one whose record box was swept is not
  mistaken for one whose inputs vanished. One that can never land (no
  supplier holds it, every one refuses it and one answers that an input is
  gone: an invented box, a dropped parent) is dropped with its change and
  rebuilt spending every input still shown, and one refused for anything
  else is rebuilt on the same inputs at the caller's new height, so the old
  and new conflict wherever they can. Later publications spend the publisher's own change,
  landed or not, before any index shows it, and calls are serialized. The
  view settles its publisher after each sync, in the publisher's queue: a
  publication is forgotten once the snapshot holds its record, and its
  inputs once a supplier shows that it landed; a record the view already
  holds is not sent. The view's `publish` throws
  its refusals at once and resolves on acceptance, which is not holding;
  a `PoolStore` awaits it inside its existing lag window. After a restart
  the memory is gone, so a retry may publish a second, identical object,
  which readers take as one at the cost of a fee; the funding key must be
  the publisher's alone.
- **Not here**: persistence of the headers and objects across restarts (the
  store keeps every header it accepted, and the retained objects stay in
  memory), pruning of side branches, and cancelling an
  abandoned publication by spending its input.

[`runtime-sync.mjs`](../experiments/ergo-range/runtime-sync.mjs) runs the
view on real mainnet headers and sections. The
[report](ergo-runtime-venue-verification.json) owns the anchor, ranges and
measurements. It compares a view synced from the own node with an independent
view synced from a public node, including their witnessed block and exact
range answers. It also checks that a substituted section stops the clock,
an honest supplier supplies the missing valid section, and altered difficulty
bits stop the offending supplier's header pass.

[`publisher-check.mjs`](../experiments/ergo-range/publisher-check.mjs) runs
the publisher on the own testnet node under the reference-testnet identity.
Its historical [report](ergo-publisher-verification.json) at
[`2c6b20c`](https://github.com/mediumofexchange/reference-ts/tree/2c6b20c) records signed commitment,
replacement and revocation transactions, verified inclusion and depth, and
exact record bytes, subjects and ordinals in their carrying sections.
The node refuses an altered proof; lost-answer and exact retries submit no
additional transaction. The report owns the anchor, transaction ids and sizes.
In tests
(`test/ergo-publisher.test.ts`) recorded proofs signed by sigma-rust
verify and every variation is refused, a mempool written independently of
the publisher admits only balanced, fully signed transactions, a lost
answer, an outage and a dropped parent each leave one transaction per
record, an invented box is refused beside a node that lacks it, and a
`PoolStore` on an `ErgoVenue` over the synthetic chain publishes its opening
and finds it held after the depth.

The candidate v3 journal also uses this neutral publishing interface on the
synthetic reference chain (`store-check.mjs --ergo`). Its issue/pay/burn flow
serves packages and mined block evidence to a fresh seedless reader, whose
witnessed block pin is held independently beside its candidate keys. Both
journal and reader require the caller's reference identity preimage. See the
[journal acceptance](POOL_DEPLOYMENT_PROBES.md#reference-operator-journal)
for the synthetic report and limits. The explicit `--testnet` path uses the same
journal on the live reference testnet, with throwaway tERG funding and a fresh
reader fetching its own headers and sections ([live report](pool-v3-testnet-verification.json)).

What remains before an Ergo deployment: persistence, the one-transaction
condition checked against an adopted configuration, publication on the
mainnet (real funds), and a latency distribution of kind-4 publications at
their size and fee (A10 timed the mainnet's own transactions; P2 made two
correlated testnet observations).
