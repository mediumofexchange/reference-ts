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
identity = SHA256(lp("moe/venue/ergo/v2") || genesis[32] || u64 depth ||
                  lp(script_1) || lp(script_2) || lp(script_3) || lp(script_4))
```

`lp` is a u32 length prefix. `genesis` is the id of the chain's first header,
which Ergo places at height 1 with a zero parent id: for mainnet
`b0244dfc267baca974a4caee06120321562784303a8a688976ae56170e4d175b`, pinned
as a fixture in the experiment. `depth` is the finality depth; `script_k` is
the exact ErgoTree that is the location of record kind `k` (§13.1's kinds: 1
commitment, 2 replacement, 3 revocation, 4 publication). Naming the venue is
agreeing the chain, the depth and the attribution rule; a different depth or
a different location is a different venue. The four trees are the
deployment's choice and must be distinct; the checked candidate uses four
pay-to-public-key trees of throwaway keys. The profile is read once and
owned, so the identity is hashed over the same bytes every output is
attributed by. The runtime's `ergoVenueId` binds a chain string, the depth
and one publication script and leaves the other locations injected; a
backing that declares this profile declares this identity, and existing v2
backings keep theirs.

## Index, finality and lag

The witnessed index of an object is the height of the block whose
transaction created it, never a box's own creation height (decision
2026-08-20, slice 17). Height 1 is the genesis; index 0 is below it and holds
nothing. An index `t` is witnessed once the chain's tip is at `t + depth` or
beyond, so the venue's current witnessed index is the tip less the depth,
and the lag is `depth + 1` (C2.3.5): a transaction submitted at clock `c` is
included at height `c + depth + 1` at the earliest. These are the v2
adapter's rules unchanged.

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

The ordinal of an object at a height is its transaction's position in the
block's transaction section, then its first output's index, packed as
`position · 2^32 + index` so that ordinals compare as the chain orders them
and as §13.1 requires for a chain: transaction order, then output order. A
reassembled object takes its first piece's position. The answer carries the
ordinal for kind 4 and zero for kinds 1–3, whose entries at one height stand
in ascending record-byte order.

## What the verifier consumes and establishes

The reader supplies, from its own retained evidence:

- **Headers** from its authenticated header source, one contiguous chain
  linked by parent id from at or below the range's first height through a
  tip at or beyond `toIndex + depth`, each with its id, parent id, height,
  version and transaction root. A chain starting at height 1 must start at
  the profile's genesis with a zero parent. Proof of work and chain selection
  are the header source's; this verifier checks linkage, contiguity and the
  genesis anchor only, and a set of headers that is not one such chain gives
  no verifier.
- **Blocks**: for every height in the range, the block's transaction section
  as exact bytes, decoded by the reader's own decoder after an exact
  reserialization, giving each transaction's id, its 31-byte witness id
  (Blake2b-256 of the concatenated input proofs, first byte dropped) and each
  output's ErgoTree and register constants.

A block supplies the section of a height only where it belongs to a header
of the chain and reproduces that header's transaction root, recomputed from
the decoder's ids (block version 1 commits to the ids alone; later versions
to all ids followed by all witness ids, over scrypto's tree with leaf prefix
0, internal prefix 1, an absent right sibling contributing no bytes and a
lone leaf keeping its parent). A block of another chain, a second block for
an established height or a block failing its root is passed over, so no
supplier of venue evidence can deny every read by adding a block; a height
without a section leaves only the ranges through it unresolved. A request is
answered by scanning every output of every transaction of every block in
its range, so an empty answer is proven by exhaustion (§13.2). There is no
answer where `toIndex` is above the tip less the depth, where a height in the
range has no section, where the range starts below the first header of a
chain not anchored at the genesis, where the request names another venue, or
where the reader's answer budget is exceeded. Each request is read once into
the reader's own copy before it is judged. Answers are the reader's own
output over its retained evidence and can be reproduced from it.

## Costs and limits

- A transaction the reader's decoder refuses is unsupported evidence: its
  height has no section and every range through it stays unresolved until
  the decoder is repaired. This is the cost of exhaustion, and it is a
  denial one node-valid transaction can trigger for the price of publishing
  it: the decoder's node equivalence, not only its containment, is a
  prerequisite of selection. Fleet's decoder fails 13 of the 24 real fixture
  transactions ([the block probe](POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility));
  sigma-rust decodes all 24 but carries no equivalence proof ([the decoder
  probe](POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility)).
- An Ergo box holds at most 4,096 bytes and the pinned node's mempool policy
  relays transactions of at most 98,304 bytes ([the offline size probe](POOL_DEPLOYMENT_PROBES.md#venue-publication-sizes-offline)),
  so one run of one transaction carries a publication of roughly 94 KB.
  §13's kind-4 bound is 131,914 bytes, the framing over the largest kind-6
  record: under this rule and that policy the largest settle record has no
  location on Ergo. Either the profile must reassemble across transactions
  or the record must shrink; this is open and recorded in the decision.
- Exhaustion costs the range's block bytes. The replacement chain and a
  revocation are read from index zero (§13.3), which on a real chain is a
  scan from the genesis unless a rule bounds the start; the reader may keep
  its own answers while the finality rule stands, so the cost is paid once
  per venue and then per new block. Measuring it on a real chain is P4 in
  [the recovery map](POOL_V3_RECOVERY_MAP.md#9-probe-plan).
- The header source and the decoder are trust boundaries of the reader:
  the header chain's authenticity and the decoder's containment are not
  established here.

## Evidence

`npm run check:ergo:range` runs `experiments/ergo-range/profile-check.mjs`
after the block-root and decoder experiments. It compiles the model, anchors
a chain on the pinned real genesis header, builds a twelve-height synthetic
chain whose transactions Fleet serializes and sigma-rust decodes after an
exact round trip, with real signed commitments, a replacement, revocations
and single- and multi-piece publications in register constants, and checks
the answers, the reader's rules over them, refusals for unwitnessed, gapped,
unlinked, substituted and truncated evidence, tolerance of stray, duplicate
and root-failing blocks, and the three mainnet fixture blocks through the
same verifier, whose roots it reproduces for block versions 1 and 3 and
whose 57 real register constants it decodes beside sigma-rust's own constant
decoder. The [retained report](ergo-range-profile-verification.json) records
the sizes. `test/pool-v3-ergo-profile.test.ts` covers the identity, register
decoding, the tree, attribution and reassembly cases, ordering, ownership of
the profile, evidence and request, and every refusal without an Ergo library.

## Before selection

A specification decision selects a venue profile and pins its identity;
before that: P4's measurements against a real chain, an authenticated header
source a reader can run, a node-equivalent contained decoder, publication and
reassembly on a node (P2), the kind-4 bound question above, and the
runtime's adoption in place of the v2 materialized view.
