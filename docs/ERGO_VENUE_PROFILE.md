# Ergo venue profile candidate

A candidate profile for reading [pool-v3 §13](https://github.com/mediumofexchange/money-from-first-principles/blob/6272040/pool-v3.md#13-record-range-evidence)
record-range answers from an Ergo chain. Section 13 fixes the request, the
answer and the reader's rules and leaves to the venue profile which venue
evidence establishes an answer and how; Construction C2.3.2 and C2.3.5 name a
venue with its finality rule and lag, and §13.1 adds the attribution rule to
that name. This document fixes all of them for Ergo, as a candidate: no
specification selects it, no backing may declare it, and no runtime path
reads it. The v2 runtime's `src/ergo.ts` keeps its own identity and
materialized view. Implementation: `model/pool-v3-ergo-profile.ts`; evidence:
[the experiment](#evidence).

## Identity

```text
identity = SHA256(lp("moe/venue/ergo/v3") || anchor[32] || u64 depth ||
                  lp(script_1) || lp(script_2) || lp(script_3) || lp(script_4))
```

`lp` is a u32 length prefix. `anchor` is the id of one header of the chain,
the last block before the venue's index space: index 0 is the anchor's child.
A header id commits to its whole ancestry through parent ids, so the anchor
names the chain up to itself as tightly as a genesis would; the all-zero id
names no header and is refused. A deployment anchors at a block before its
first record that is already final under its declared depth, so a read from
index zero begins there rather than at the chain's genesis; an anchor the
chain later orphans is in no chain, and every read under that identity is
unresolved for good. The mainnet genesis header, pinned as a fixture in the
experiment, is one possible anchor, under which index 0 is height 2. `depth`
is the finality depth; `script_k` is the exact ErgoTree that is the location
of record kind `k` (§13.1's kinds: 1 commitment, 2 replacement, 3 revocation,
4 publication). Naming the venue is agreeing the chain from its anchor, the
depth and the attribution rule; a different anchor, depth or location is a
different venue. The four trees are the deployment's choice and must be
distinct; the checked candidate uses four pay-to-public-key trees of
throwaway keys. The profile is read once and owned, so the identity is hashed
over the same bytes every output is attributed by. The runtime's
`ergoVenueId` binds a chain string, the depth and one publication script and
leaves the other locations injected; a backing that declares this profile
declares this identity, and existing v2 backings keep theirs and their
height-as-index convention.

## Index, finality and lag

The witnessed index of an object is derived from the height of the block
whose transaction created it, never a box's own creation height (decision
2026-08-20, slice 17): index `i` is the block `i + 1` heights above the
anchor, so with the anchor at height `A` the origin height `A + 1` is index 0
and height `h` is index `h − A − 1`. An index `t` is witnessed once the
chain's tip is at `A + 1 + t + depth` or beyond, so the venue's current
witnessed index is the tip less the depth less the origin, and nothing is
witnessed until the tip reaches the origin plus the depth. The lag is
`depth + 1` (C2.3.5): a transaction submitted at clock `c` is included at
index `c + depth + 1` at the earliest. The depth and lag rules are the v2
adapter's; the index is relative to the anchor rather than to the chain.

## Attribution and reassembly

An output is attributed by its location and shape (§13.1): its ErgoTree
equals `script_k` exactly, its own register `R4` is a `Coll[Byte]` constant
of exactly 32 bytes, the subject, and its own `R5` is a `Coll[Byte]`
constant, the bytes. A register constant is the type code `0x0e`, a minimal
unsigned VLQ length and the bytes, ending exactly, as sigma-rust's constant
decoder reads the fixtures' 42 real `Coll[Byte]` constants; any other
register value is not the shape. Registers other than `R4` and `R5` are not
read. An output at no location, or at a location without that shape, is not
an object here.

- Kinds 1–3: the object is one output; its record is `R5`'s bytes, and it is
  omitted unless its length is the kind's exact length (136, 233, 96).
- Kind 4: the object is the maximal run of adjacent outputs of one
  transaction at the kind-4 location with one subject, in output order; its
  record is the concatenation of their `R5` bytes, and it is omitted where
  that exceeds 131914 bytes. A publisher separates two publications of one
  subject in one transaction with any other output or uses two transactions;
  a run that merges two publications does not decode under §6 and has no
  force, which is the publisher's cost.

The verifier applies no signature, sequence or content rule: a 136-byte
object nobody signed is carried under its `R4` subject and §13.3 disregards
it. Identical objects at two positions are two witnessings of one object.

## The venue's order

The ordinal of an object at an index is its transaction's position in the
block's transaction section, then its first output's index, packed as
`position · 2^32 + index` so that ordinals compare as the chain orders them
and as §13.1 requires for a chain: transaction order, then output order. A
reassembled object takes its first piece's position. The answer carries the
ordinal for kind 4 and zero for kinds 1–3, whose entries at one index stand
in ascending record-byte order. Ordinals of different subjects at one index
are positions in one section, so the union of several backings' answers
(C2b.4.2's adopted block) is the section's order.

## What the verifier consumes and establishes

The reader supplies, from its own retained evidence:

- **Headers** from its authenticated header source, one contiguous chain
  linked by parent id that contains the anchor's child (the header whose
  parent id is the anchor) and reaches a tip at or beyond the origin plus
  `toIndex + depth`, each with its id, parent id, height, version and
  transaction root. Headers at or below the anchor are linkage only. Proof of
  work and chain selection are the header source's; this verifier checks
  linkage, contiguity and the anchor only, and a set of headers that is not
  one such chain, that does not contain the anchor's child, or that names
  the anchor as a parent twice, gives no verifier. Every read therefore
  presents the chain from the anchor's child, not a suffix: the header
  retention cost is the venue's age in headers, the price of a bounded
  index space and of an identity every read is linked to.
- **Blocks**: for every index in the range, the block's transaction section
  as exact bytes, decoded by the reader's own decoder after an exact
  reserialization, giving each transaction's id, its 31-byte witness id
  (Blake2b-256 of the concatenated input proofs, first byte dropped) and each
  output's ErgoTree and register constants.

A block supplies the section of an index only where it belongs to an indexed
header of the chain and reproduces that header's transaction root, recomputed
from the decoder's ids (block version 1 commits to the ids alone; later
versions to all ids followed by all witness ids, over scrypto's tree with
leaf prefix 0, internal prefix 1, an absent right sibling contributing no
bytes and a lone leaf keeping its parent). The root binds every unsigned
byte and the concatenated proofs, not the proofs' split among inputs;
attribution reads outputs only, so that gap reaches no answer. A block that is not a well-formed
section view, belongs to another chain or a height at or below the anchor,
duplicates an established index or fails its root is passed over at the
model boundary; an index without a section leaves only the ranges through it
unresolved. A request is answered by scanning every output of every
transaction of every block in its range, so an empty answer is proven by
exhaustion (§13.2). There is no answer where `toIndex` is above the witnessed
index, where an index in the range has no section, where the request names
another venue, or where the reader's answer budget is exceeded. Every field
of the profile, the headers, the blocks and each request is read once into
the reader's own copy before it is judged, so no accessor can pass one value
to a check and another to a use. Answers are the reader's own output over
its retained evidence and can be reproduced from it.

## Costs and limits

- A transaction the reader's decoder refuses is unsupported evidence: its
  index has no section and every range through it stays unresolved until
  the decoder is repaired. This is the cost of exhaustion, and it is a
  denial one node-valid transaction can trigger for the price of publishing
  it: the decoder's node equivalence, not only its containment, is a
  prerequisite of selection. Fleet's decoder fails 16 of the 29 real fixture
  transactions ([the block probe](POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility));
  sigma-rust decodes all 29 but carries no equivalence proof ([the decoder
  probe](POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility)). On
  mainnet the denial was live under the previous pin: sigma-rust 0.28.0
  refuses every transaction carrying an ErgoTree of header version 3, the
  Ergo 6.0 script version, at the header byte, and 125 such transactions in
  58 of seven days' 5,040 blocks left those indices without a section
  ([P4](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor)).
  The experiment pins a release build of sigma-rust `2f840d3`, vendored and
  reproducible from source ([decided 2026-09-23](../decisions/2026-09.md#2026-09-23--pin-a-reproducible-release-build-of-sigma-rust-2f840d3)), which reads
  all of them after exact round trips and keeps any sized tree it cannot
  parse, of any header version, as its exact bytes, so an unknown script
  version or opcode cannot refuse a transaction; an unsized version-0 tree or
  a register constant it cannot parse still can. The npm alpha of the same
  commit, pinned the day before, is a debug build that overflows Node's
  default stack on a node-valid mainnet transaction and traps on expression
  nesting of 50, within the node's cap of 110 by the node's source, so a
  node-valid output could have denied every range through its block; the
  release build parses expression nesting to 2,513 levels on the default
  stack ([probe](POOL_DEPLOYMENT_PROBES.md#decoder-stack-budget)). An overflow or trap is fatal to the decoder,
  never a refusal. No specification pins a decoder.
- The public node API serves transactions as JSON. sigma-rust's serializer
  reproduced every header root of the measured week from the node's exact
  text, but only because that text keeps the spending-proof extension's key
  order, which a JSON object model sorts: re-serializing parsed objects gives
  12 of the week's transactions a different id and would leave their blocks
  without a section. The header root, not the serializer, authenticates the
  bytes, within the limit above: unsigned bytes and concatenated proofs.
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
  them in a few milliseconds; building it, where every output is scanned,
  took 1.3 s, and decoding the week's transactions 253 s under the pinned
  alpha (39 s under the 0.28.0 control), on one desktop.
- The header source and the decoder are trust boundaries of the reader.
  A node the reader runs can be the header source: the reader's own
  mainnet node validated the header chain from genesis in under two hours,
  and the fixtures and the measured week stand on its best chain
  ([own node](POOL_DEPLOYMENT_PROBES.md#own-node-as-the-header-source)). The decoder's containment is not established
  here. Objects at the locations before the anchor are not in the record.

## Evidence

`npm run check:ergo:range` runs `experiments/ergo-range/profile-check.mjs`
after the block-root and decoder experiments. It compiles the model, reads
the pinned real mainnet genesis header as an anchor, builds a twelve-height
synthetic chain anchored at its first header whose transactions Fleet
serializes and sigma-rust decodes after an exact round trip, with real signed
commitments, a replacement, revocations and single- and multi-piece
publications in register constants, and checks the answers, the reader's
rules over them, refusals for unwitnessed, gapped, unlinked, substituted and
truncated evidence, tolerance of stray, duplicate and root-failing blocks,
and the four mainnet fixture blocks through the same verifier as index 0
under their parents as anchors, whose roots it reproduces for block versions
1, 3 and 4 and whose 65 real register constants it decodes beside sigma-rust's
own constant decoder. The [retained report](ergo-range-profile-verification.json)
records the sizes. `test/pool-v3-ergo-profile.test.ts` covers the identity,
register decoding, the tree, attribution and reassembly cases, ordering, the
anchor and origin rules, ownership of the profile, evidence and request, and
every refusal without an Ergo library.

## Local replay adapter

`npm run check:pool:ergo-replay` runs every local replay group of
`scripts/pool/v3/local-check.mjs` a second time through this candidate: the
single-backing import, payment and burn traces with and without silence, the
two-backing scope and scope-recovery histories, receipts, non-service counts,
compact fault evidence and returning segments with their adopted blocks. The
optional dependencies and commands are in the
[harness guide](../scripts/pool/v3/README.md). The
[retained replay report](pool-v3-local-replay-verification.json) records the
groups, the kind-4 subjects and the cross-backing union positions that agree,
and the refusals: fresh seedless audit and receiver restoration, missing
sections, decodable root mismatches, decoder refusals, wrong profile/headers
and resource refusal. The fixture converter constructs exact transaction
bytes and expected roots independently of the sigma-rust decoder and profile
verifier: the fixed synthetic genesis is the anchor, fixture index `i` is
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
provides raw block sections, not transaction ids, decoded outputs, clocks or
answers. The synchronous factory owns all evidence before returning or awaiting
proof work. Each byte view is charged before its immediate copy, using intrinsic
typed-array length and storage checks; shadowed properties cannot hide shared
storage or an oversized view, and later getters cannot resize or detach an
already owned view. Detached, out-of-bounds and shared views refuse. The adapter
caps source bytes at 8 MiB, headers and supplied blocks at 256 each, and total
transactions at 1024, before invoking the decoder. These are local experiment
limits, not consensus bounds or WASM allocation limits. Budget or storage refusal
rejects the whole read, even if the offending block would otherwise be ignored.
The worker's separate V8 IPC envelope remains capped at 2 MiB.

The adapter reuses the strict round-trip decoder in `decoder.mjs`; an
undecodable transaction withholds its entire block. The model then checks roots
and range completeness. Successful replay reports
`rangeEvidence: "candidate-ergo-profile-synthetic-headers"`; currency and
authority flags describe only checks under that explicit trusted fixture.
Full replay, complete-certificate and spendability flags remain false. This
integration introduces no production path, profile selection or normative rule.

## Before selection

A specification decision selects a venue profile and pins its identity;
before that: an authenticated header source a reader can run (a node the
reader runs is demonstrated, [own node](POOL_DEPLOYMENT_PROBES.md#own-node-as-the-header-source); whether the profile
requires one or names a lighter source is the selection's choice), a contained
decoder with node-equivalence evidence beyond the fixtures and one week (the
pinned alpha reads the chain's current script versions and keeps unknown
sized trees as bytes; its containment is not established), an exact-byte
block source or the JSON-text discipline above, publication and reassembly
on a node (P2: the [experiment](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node)
accepted every case on the public testnet and the verifier read each back
from block sections after the boxes were spent), the adoption condition above checked
against the selected configuration, and the runtime's adoption in place of
the v2 materialized view. P4's cost measurement and P2's testnet run are
done; inclusion latency has two correlated testnet observations, and a
distribution needs repeated independent submissions.
