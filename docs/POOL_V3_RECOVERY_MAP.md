# Pool v3 recovery map

Design map, 2026-09-08. This lays out what a construction `moe/pool/v3`
must carry to instantiate the
[presentation and recovery contract](https://github.com/mediumofexchange/money-from-first-principles/blob/main/pool-recovery.md)
(C3.1–8, C2b.3.1–3, C2b.4.1–3, C2b.5.1–2, C2b.6.1) and the
[fault contract](https://github.com/mediumofexchange/money-from-first-principles/blob/main/pool-fault.md)
(C2.10.9c, C2.10.10–13): the public inputs, witnesses, relations, in-clear
checks, state effects and exact evidence of every new object; one complete
trace through wallet, operator, backer, venue and stranger; the record range
and retention each read needs; the resource assumptions; and the choices
that are still open, each with the probe or decision that closes it.

It is not `pool-v3.md`. Where it proposes a layout, the layout is a
**candidate**: the specification fixes the bytes after the choices in
[§8](#8-unresolved-assumptions-and-choices) are decided and reviewed, and the
runtime follows the specification. Words are pool-v2's and the contracts'.
`frame`, `SHA256`, `H`, limbs, `F`, `u8`/`u32`/`u64` are pool-v2 §1's.

## 1. What v3 carries beyond v2

| Object | v2 | v3 candidate | Rule |
|---|---|---|---|
| In-circuit tags | `T_OWNER`…`T_SCOPE_NODE` (1001–1006) | add `T_TAG = 1007`, `tag = H(T_TAG, nf)` | C3.1 |
| Circuits | issue, spend, burn | add demand, settle, request; six identities in the configuration | C3.2, C3.5, C2b.5.1 |
| Statement kinds | 1 issue, 2 spend, 3 burn | add 4 demand, 5 withdraw, 6 settle in the history; 7 request, never admitted, in the same frame | C3.7, C2b.5.1 |
| Statement record | `statementBytes ‖ proof ‖ obligorSignature` | `statementBytes ‖ proof ‖ authorization`, the authorization fixed per kind ([§2](#2-statements)) | C3.4, C3.6, pool-v2 §7 |
| Replayed state | forest, spent set, outputs, totals | add the standing-demand record, the pending-lock set and the spent-tag set | C3.7 |
| Snapshot digest | `historyHash_n`, totals | add `evidenceHash_n` beside `historyHash_n` | C2.10.10 |
| Evidence chain | none (receipt digests only) | `evidenceHash_i` over `(statementHash_i, proofHash_i, signatureHash_i)` | C2.10.10 |
| Venue publications | commitments, replacements, revocations | add demand, acceptance, release, withdrawal, request | C2b.3.2 |
| Signed objects | commitment, receipt, terms | add acceptance (**K**), release and withdrawal (presenter key) | C3.4, C3.6 |
| **E** | silence clause, non-service terms already encoded, inert | the same fields bind: one no-commitment duration per scope | §7 of the contract |
| Contexts | `moe/pool/v2/…` | `moe/pool/v3/…`, prefix-free | pool-v2 §1 |

Nothing else changes: the field, `H`, the note, its commitment and
nullifier, the note tree, the scope, the segment header, the history chain,
the directory, the receipt fields, the spent set and the proof system are
carried over. The header gains no field: one duration per scope is read from
the scoped backings' terms, and the adoption index is a function of the
record (C2b.3.1).

## 2. Statements

Every admitted kind's public inputs begin with `domainHi, domainLo,
segmentHi, segmentLo, scopeRoot` (pool-v2 §7); the request of §2.4, never
admitted, names no segment. `statementBytes` and `statementHash`
keep their v2 form under the v3 context; the identity excludes proof and
authorization bytes. The **authorization** is the record's second
variable field, generalizing v2's obligor-signature slot; `signatureHash`
is `SHA256` over it, thirty-two zero bytes where it is empty. Admission and
replay read every kind against one committed view (pool-v2 §8) and the
lock index the reader judges at (C3.7).

### 2.1 Demand, kind 4

```text
publicInputs = [domainHi, domainLo, segmentHi, segmentLo, scopeRoot,
                backingHi, backingLo, quantity, anchor_1, anchor_2, tag_1, tag_2,
                presenterHi, presenterLo, instant, deadline]                       n = 16
witness      = for each position i: note_i, secret_i, siblings_i[32], right_i[32];
               link, scopeSiblings[16], scopeRight[16]
authorization = empty
```

Relation (C3.2, segment-bound form): for each position, `secret_i ≠ 0`,
`owner_i = H(T_OWNER, secret_i)`, `nf_i = H(T_NULLIFIER, …)`, `nf_i ≠ 0`;
where `value_i > 0` the path carries `cm_i` to `anchor_i` and
`tag_i = H(T_TAG, nf_i)`; where `value_i = 0`, `tag_i = 0`; every note names
the public `backing`; `quantity = value_1 + value_2` in 128-bit arithmetic
and `quantity > 0`; `nf_1 ≠ nf_2`; one scope path carries
`leaf(backing, link)` to `scopeRoot`; every limb is below `2^128`, `instant`
and `deadline` below `2^64`. The presenter key, instant and deadline are
bound as public inputs and otherwise unread by the circuit, so the notice
of C3.3 is the statement's own public inputs and the **demand identity is
`statementHash`**. Nothing else signs the demand.

In the clear, at the door (C3.7–8): the anchors are in the forest; the
backing is in the scope with held terms; the nonzero tags are distinct and
none is locked or spent; `deadline` is strictly ahead of the horizon and
`instant` within `[horizon − 2·lag, horizon − lag]`. Effect: the demand
enters the standing-demand record with its position; each nonzero tag is
locked to it. No root, nullifier or total moves. Evidence:
`(statementHash, proofHash, 0)`.

### 2.2 Withdraw, kind 5

```text
publicInputs  = [domainHi, domainLo, segmentHi, segmentLo, scopeRoot, demandHi, demandLo]   n = 7
proof         = none
authorization = presenterSignature[64] over withdrawalBytes (§3)
```

No circuit. In the clear: the demand is in the standing-demand record, past
its deadline or not; the signature verifies under that demand's presenter
key. Effect: the demand is discharged and its locks released. Evidence:
`(statementHash, 0, SHA256(authorization))`. The signed bytes name the
withdraw statement, so the signature is for one segment binding: a return
needs a fresh signature, and a withdrawal an operator kept back cannot be
applied under a segment the holder never named (A18).

### 2.3 Settle, kind 6

```text
publicInputs  = [domainHi, domainLo, segmentHi, segmentLo, scopeRoot,
                 backingHi, backingLo, quantity, owner, rho_out,
                 anchor_1, anchor_2, nf_1, nf_2, cm_out, demandHi, demandLo]        n = 17
witness       = for each input i: note_i, secret_i, siblings_i[32], right_i[32];
                link, scopeSiblings[16], scopeRight[16]
authorization = u64 acceptanceDeadline ‖ acceptanceSignature[64] ‖ releaseSignature[64]   (136 bytes)
```

Relation (C3.5): each input as a spend proves it, membership where the
value is positive, padding where it is zero; every input names `backing`;
`nf_1 ≠ nf_2`; `value_1 + value_2 = quantity` in 128-bit arithmetic,
`quantity > 0`; `cm_out = H(T_NOTE, domain, backing, quantity, owner, rho_out)`
with `owner`, `rho_out`, `cm_out` nonzero; one scope path. `rho_out` is a
public input ([§8](#8-unresolved-assumptions-and-choices), A6): the
settlement is lit already, and with it public the backer rebuilds its note
from the record alone.

In the clear (C3.7): the demand is in the standing-demand record, which
only a settle or a withdraw discharges (A16); `backing` and `quantity` are
the demand's; for each position the demand's tag is `0` or
`H(T_TAG, nf_i)`, computed by the host; the acceptance verifies under the
backing's **K** over `acceptanceBytes(demand, owner, acceptanceDeadline)`
with `acceptanceDeadline ≤ demand.deadline` (C3.4) and not behind the
horizon (C3.8); the release verifies under the demand's presenter key over
`releaseBytes(demand, acceptanceId, statementHash)`; anchors in the forest;
nullifiers and output new. Effect: a spend's, plus the demand discharged
and its locks released; totals unchanged. Evidence:
`(statementHash, proofHash, SHA256(authorization))`. The acceptance's
demand and owner are the settle's own public inputs, so the 136 bytes are
the whole authorization.

### 2.4 Request, kind 7, never admitted

```text
publicInputs  = [domainHi, domainLo, backingHi, backingLo, anchor, tag, refresh]   n = 7
witness       = note, secret, siblings[32], right[32]
authorization = empty
```

Relation (C3.2, segment-free form): ownership, the nullifier, membership at
`anchor` with `value > 0`, `tag = H(T_TAG, nf)`, the note names `backing`.
No segment, scope or quantity. It reuses the statement frame for its
identity and record and is a venue publication only (C2b.5.1); the counting
reader places its anchor in the canonical state's forest (C2b.5.2). It is
unsigned, so a copy is the same request and is read at that request's first
index; `refresh` is the holder's own field, constrained but unread, so only
a party that can prove the note can mint another identity for one tag, which
is how a holder refreshes a request an operator is stalling on (A21). P1
compiled and proved this circuit over the six inputs it had before
`refresh` was added; the seventh is unmeasured.

### 2.5 Issue, spend, burn

Unchanged relations under the v3 domain and contexts. Their records carry
the authorization slot: the obligor signature for an issue, empty otherwise.
A spend or burn whose nullifier's tag is under a standing lock is refused
(C3.7); the tag is the host's `H(T_TAG, nf)` over the public nullifier.

## 3. Signed objects and publications

```text
acceptanceBytes = frame("moe/pool/v3/acceptance" ‖ configHash[32] ‖ demandId[32] ‖ owner[F] ‖ u64 deadline)
acceptanceId    = SHA256 over acceptanceBytes;  K signs acceptanceBytes strictly
releaseBytes    = frame("moe/pool/v3/release" ‖ configHash[32] ‖ demandId[32] ‖ acceptanceId[32] ‖ settlementHash[32])
withdrawalBytes = frame("moe/pool/v3/withdrawal" ‖ configHash[32] ‖ withdrawStatementHash[32])     A18
publicationBytes = frame("moe/pool/v3/publication" ‖ configHash[32] ‖ backing[32] ‖ u8 kind ‖ body)
```

The presenter key is an Ed25519 key, fresh per demand (C3.3), carried as
two limbs in the demand. A publication's identity is `SHA256` over
`publicationBytes`; an exact republication is the same publication
(C2b.3.2). Bodies:

| Kind | Body | Estimated bytes | Force |
|---|---|---|---|
| 1 demand | the demand statement record | ≈ 15.3 KB | yes |
| 2 acceptance | `acceptanceBytes ‖ signature[64]` | ≈ 0.3 KB | no, evidence for C3.8 |
| 3 release | the settle statement record | ≈ 15.5 KB | yes |
| 4 withdrawal | the withdraw statement record | ≈ 0.4 KB | yes |
| 5 request | the request statement record | ≈ 15.0 KB | no, counted by C2b.5.2 |

A publication is read for the backing its statement names; one whose
routing name differs from it has no force and is no evidence (C2b.3.2). An
acceptance names no backing of its own and resolves to its demand's, so
its routing name is checkable only with the demand in hand (A19). A
statement in a publication is bound to the snapshot's segment and scope root at the index it is judged; the
reader refuses any other binding. No publication carries a non-membership
proof (A20): every reader that decides force replays the snapshot for its
forest and standing demands, so it holds the spent set and reads absence
from it, and an adopted settle carries only its record
([§4](#4-checkpoint-evidence-chain-receipt-and-trail)).

Estimates assume a 14,656-byte proof and the frames above;
[§9](#9-probe-plan) measures the rest.

## 4. Checkpoint, evidence chain, receipt and trail

```text
evidenceHash_0 = SHA256("moe/pool/v3/evidence-seed" ‖ segmentId[32])
evidenceHash_i = SHA256("moe/pool/v3/evidence-link" ‖ evidenceHash_{i−1}[32] ‖ statementHash_i[32]
                        ‖ proofHash_i[32] ‖ signatureHash_i[32] ‖ u64 i)
snapshot(b)    = SHA256("moe/pool/v3/snapshot" ‖ b[32] ‖ segmentId[32] ‖ historyHash_n[32]
                        ‖ evidenceHash_n[32] ‖ u64 issued(b) ‖ u64 burned(b))
receiptBytes   = frame("moe/pool/v3/receipt" ‖ configHash ‖ segmentId ‖ scopeRoot[F] ‖ u64 i
                        ‖ statementHash_i ‖ historyHash_i ‖ proofHash ‖ signatureHash ‖ u64 after)
```

`proofHash_i = SHA256(proof)` and `signatureHash_i = SHA256(authorization)`
over the bytes exactly as admitted, zero where absent. v2's zero digest
stood only for an absent obligor signature; v3 extends it to the proof
digest of the proofless withdraw. The chain is `SHA256` over frames, not
`H`: no circuit reads it and its inputs are `SHA256` digests. The history chain, roots and
statement identity are unchanged, so re-proof, deduplication and
idempotence stay as in pool-v2 §§7–8. The receipt fields are v2's; for an
adopted statement `after` is the opening checkpoint's sequence and the
digests are the publication's (C2b.4.2, C2.10.10).

The **served trail** is the header, the signed terms of every scoped
entry (a classifier reads every scoped clause for one duration per scope,
C2b.6.1, not only the terms an issue or burn names), and for every
position the statement record as admitted. For an adopted
position it is the statement record exactly as published, whose segment
binding is the opening's source segment; the block itself is a function of
the venue record and is not asserted by the trail (C2b.4.2). A reader
reproduces both chains from the trail; a trail that does not reproduce
the signed digests leaves the checkpoint unresolved, not excluded
(C2.10.11).

Replayed state adds three sets to pool-v2 §10's: standing demands keyed by
identity (backing, quantity, tags, presenter, deadline, position), locks
keyed by tag, and the tags of every spent nullifier, including the imported
closure's, computed at import. A demand leaves the standing record only by
a settle or a withdraw; its deadline expires its lock at the index the
reader judges at and gates the door and the venue, and a replayer never
removes a demand for its deadline (A16). For each adopted position the
replayer also carries the venue index at which the publication had force,
derived from the venue record when it reconstructs the block, and reads
that position's locks at that index (C2b.4.2, A17). Imports apply demand,
withdraw and settle events in ancestry order and refuse two unrelated
prefixes that lock, settle or spend one tag (C3.7).

## 5. One complete trace

Parties: holder **H** with a wallet, backer **K**, operator **O** serving
segment `S1` over one backing `b`, venue **V** (Ergo, depth `d`, lag
`d + 1`), replica **R**, stranger **X**. Indices are V's.

**Service leg.**

1. **K** signs an issue to **H**'s fresh owner; **O** admits it at position 1
   and returns a receipt; **O** commits `c1` at `i1`. **H** verifies the
   receipt and, after `c1`, the checkpoint (v2 path, exists).
2. **H** pays a merchant with change (v2 spend); `c2` at `i2`.
3. **H** presents: syncs `S1`'s leaves, builds paths against an accepted root,
   derives a presenter key, sets `instant` to the latest index it read and
   a `deadline`, proves a demand and submits it. **O** checks the door
   conditions of §2.1, admits at position `p`, locks the tags, receipts.
4. **K** reads the demand, derives an owner secret, signs an acceptance with
   a deadline at or before the demand's, and returns it to **H**; it may
   also publish it at **V** as evidence of an answer (C3.4).
5. **H** proves the settle over the same notes to **K**'s owner, signs the
   release over the demand, acceptance and settle identities, and submits
   the record with its 136-byte authorization. **O** checks §2.3, admits at
   position `q`, spends the nullifiers, appends `cm_out`, discharges the
   demand, receipts. **K** rebuilds its note from `(backing, quantity,
   owner, rho_out)` in the record and later burns or holds it.
6. **O** commits `c3` at `i3`, whose directory binds `historyHash` and
   `evidenceHash` through `q`. **X** replays the trail from **R**, verifies
   every proof and authorization, reproduces both chains, and classifies
   `c3` valid.

**Gap leg.** **O** commits nothing after `c3`.

7. At `t > i3 + duration`, the gap for `b` is open: `c(t) = i3` is the last
   valid carrying checkpoint (C2b.6.1), which a reader establishes from the
   complete set of **O**'s commitments over `(i3, t)` with their directories
   (C2.10.13).
8. **H** holds a note created in `S1`, unspent at `c3`. From **R** it takes
   `S1`'s trail through `c3` and its ancestry, replays to the forest, spent
   set, standing demands and both chains, and checks them against `c3`'s
   directory. It proves a demand bound to `S1`'s identity and scope root,
   anchors from `c3`'s forest, `instant` inside the window at the index it
   expects, and publishes it under `b` in chunks. Witnessed at `w_d`, it has
   force where the gap is open, the binding is the snapshot's, the tags are
   unlocked and unspent in the recovery state, and the window and deadline
   pass (C2b.3.2). A demand already standing in `c3` needs no publication.
9. **K** returns an acceptance to **H**, or publishes it.
10. **H** proves the settle bound to `S1`, signs the release, and publishes
    the release body of §3. Witnessed at `w_r`, it has force where the gap
    is open, the demand stands and is not past its deadline, the acceptance
    deadline is at or after `w_r`, the proofs and signatures verify, the
    anchors are `c3`'s, the nullifiers are absent from the spent set and
    from every earlier forceful settlement since the adoption index, and
    `cm_out` is new. The recovery state now holds **K**'s note.
11. Any receipt **O** gave after `c3` reads under C2b.4.3 at `S1`'s silence
    boundary; earlier inclusion in `c3` stays final.

**Return.**

12. A party in force for `b` (**O** returning, or a successor under **E**'s
    rule) opens `S2` with `b`'s opening `= c3` and every other scoped
    backing's snapshot, commits the empty opening checkpoint `c4` at `r`,
    then reads **V** for each scoped backing from that backing's adoption
    index (`S1`'s opening index for `b`) through `r` for publications with
    force, in venue order: the demand at
    `w_d` and the release at `w_r`. It admits them as positions 1 and 2 of
    `S2` with the published records as their evidence and receipts naming
    `c4` (C2b.4.2), then serves. `c5` binds the block first.
13. **X** classifies `c5`: `c3` valid, `c4` a valid opening whose imports
    pass, the block reconstructed from **V**'s complete range and matched
    position by position, the evidence chain reproducing the published
    bytes, every later statement admitted against the replayed state.

## 6. What each read needs from the record

| Read | Rule | Range the reader must show complete | Evidence per item | Retained by |
|---|---|---|---|---|
| Gap open for `b` at `t` | C2b.6.1, C2.10.13 | the party in force's commitments over `(c(t), t)`, with same-index order | each scoped backing's declared duration; each directory, to read carriage; for carrying ones, classification | venue; operator and replicas for trails |
| Snapshot and recovery state at `t` | C2b.3.1–2 | as above, plus publications under `b` over `(a, t)` in venue order, `a` the adoption index | the snapshot's trail and ancestry; each publication's bytes | replicas, holders |
| Force of one publication at `w` | C2b.3.2 | the two ranges above, through `w` | the same | the same |
| Adopted block of `S2` | C2b.4.2 | publications under every scoped backing over `(a_b, r]` | the same, with each publication's witnessed index and order, which fix the position and the lock index it is read at | the same |
| Receipt verdict | C2.10.9a–c, C2b.4.3 | the operator's commitments from the last valid checkpoint below `after` to the deciding boundary | directories, classification of carrying ones | venue, replicas |
| Count at `t` | C2b.5.2 | requests under `b` over `[t − W, t − d]`; the canonical state at `t` | each request's proof against the state's forest | venue, replicas |
| Classification of one checkpoint | C2.10.11 | its own record prefix | header, scope, terms, trail with exact evidence, imports, passed checkpoints | operator, replicas |

**Ergo today** (`src/ergo.ts`): a materialized view from a node with
`extraIndex`, every box at the operator's commitment address and the
backing's publication address, spent or not, read at indexed height less
`depth`. Completeness of a range and each box's `inclusionHeight` are the
node's word, and order within one height is the order the node returns.
Candidates to authenticate what C2.10.13 requires, none selected:

- verify block headers and download the transactions of every block in the
  range, checking them against each header's transaction root, so absence
  is proven by exhaustion; cost is the range's block bytes;
- chain an operator's commitments by having each commitment box spend its
  predecessor, so the successor is proven by the spending transaction and
  the tip by an unspent proof against the header's state root; this
  authenticates commitment completeness only, and needs a venue spending
  key **E** does not name;
- read several independent nodes and refuse on disagreement, which lowers
  the trust but does not authenticate.

Retention obligations, by party: the operator and its replicas keep every
statement record exactly as admitted, since a re-proof no longer classifies
(C2.10.10); a holder keeps the leaves of every segment it holds notes in
(pool-v2 §4) and, to redeem in a gap, the snapshot's full closure to build
its forest and spent set; the backer keeps its acceptances and owner
secrets; every reader keeps evidence rather than verdicts (C2.10.13).

## 7. Resource assumptions

| Item | Value | Standing |
|---|---|---|
| Proof bytes, any kind | 14,656 (458 fields) | measured for v2's three circuits and the three candidates (P1) |
| Public inputs | demand 16, withdraw 7, settle 17, request 7 | candidate; P1 proves the circuits in exactly §2's order, the request as it stood before its refresh value |
| Proving, desktop Node | 1.4 s for an issue to 10.5 s for a spend under a second segment (v2) | measured; demand and settle expected at burn's scale, request below |
| Proving, candidate circuits, desktop Node, one thread | demand 5.0–5.8 s, settle 6.3 s, request 3.5 s; verification 85–156 ms; key derivation 0.5–1.1 s; verification keys 3,680 bytes | measured (P1, this machine) |
| Proving, desktop browser | 4.3–9.3 s spend | measured; phone unmeasured |
| Verification | 61–174 ms in Node, 91–195 ms in the browser | measured |
| Evidence chain | 32 bytes in the digest; 96 bytes of inputs per later event in a certificate | fixed by the form |
| Non-membership proof, not published (A20) | median `32·(log₂N + 1)` bytes: 352, 480 and 576 bytes at 10³, 10⁴ and 10⁵ random nullifiers, at most three siblings more; the two the release no longer carries are 1,192 bytes at 10⁵ | measured (P3) |
| Spent-set build, reference trie | about 1.4 ms per insert, from 2.1–2.7 ms, once each frame was built once rather than per hash call; a proof 3–5 ms | measured (P3, re-measured after the frame fix); what remains is the accumulator's price, not the code's — about 430 node hashes per insert, and a bare SHA-256 over the 86-byte node frame costs 2.85 µs on this machine against node:crypto's 2.42 µs, so the hash implementation is not the lever (A22) |
| Release publication | ≈ 15.5 KB and four 3,978-byte chunks; about 0.006 ERG at the minimum value per byte plus fee. Two non-membership proofs would have added ≈ 1.2 KB and a fifth chunk (A20) | estimated from the offline probe |
| Demand or request publication | ≈ 15.3 KB and ≈ 15.0 KB, four chunks each | estimated |
| Acceptance, withdrawal | one box each | estimated |
| Replayed state per standing demand | about 184 bytes; 32 bytes per spent tag | fixed by the form |
| Redemption reader | full replay of the snapshot's closure | fixed by C2b.3.3; cost unmeasured |
| Range read | the node's word today | see §6 |

## 8. Unresolved assumptions and choices

Each names the rule, the candidate, the alternative, and what closes it.

- **A1 Evidence chain form.** C2.10.10 writes the chain with `H` and
  `T_EVIDENCE`. Candidate: `SHA256` frames as in §4, two prefix-free contexts.
  Alternative: Poseidon over limbs, useful only if a circuit ever reads the
  chain, which no rule needs. **Decided 2026-09-09** (spec [`64cc529`](https://github.com/mediumofexchange/money-from-first-principles/commit/64cc529)): the
  candidate. C2.10.10 now writes the chain hash-neutrally and records
  `SHA256` over frames, two prefix-free contexts binding the position, as
  pool-v3's form.
- **A2 The notice is the public inputs.** C3.3's identity is "the hash of
  the notice with the proof's public inputs". Candidate: presenter, instant
  and deadline as public inputs; identity `statementHash`. Alternative: a
  notice hash as one public input, which adds a hash in the circuit and a
  second identity. **Decided 2026-09-09**: the candidate. C3.2 lists the
  presenter key, the instant and the deadline among the demand's public
  inputs and C3.3 makes the demand's identity its `statementHash`.
- **A3 The authorization slot.** Candidate: one variable record field per
  kind, `signatureHash` over it. Alternative: separate fields per signature
  kind, which adds frames. The contract now reads `signatureHash` over
  whatever authorization a kind carries, and the zero digest where it
  carries none (C2.10.10, 2026-09-09); the record field is pool-v3's.
- **A4 Six circuits.** Two holding forms and a settle relation cannot share
  one verification key with different public inputs. Closed by P1 on
  2026-09-08: three candidate circuits compile without warnings under the
  pinned toolchain, prove in §2's public-input order, give 14,656-byte
  proofs, and refuse every hostile witness of §9; 47 checks, 5 proofs.
- **A5 Distinct nullifiers in the demand.** C3.2's segment-bound form does
  not require `nf_1 ≠ nf_2`; two positions over one note would double the
  quantity and make the demand unsettleable, a manufactured dishonour.
  Candidate: the constraint in-circuit and distinct nonzero tags in the
  clear. **Decided 2026-09-09**: both. C3.2 requires distinct nullifiers
  across the positions and C3.7's door requires distinct nonzero tags.
- **A6 `rho_out` public.** C3.5 leaves it private. Public, the backer's
  holding is rebuildable from the record and no delivery step exists;
  nothing hidden by C3.5 is revealed, since the settlement is lit and
  `cm_out` is public. **Decided 2026-09-09**: `rho_out` is a public input
  of C3.5, so the backer rebuilds the note's opening from the record alone,
  with no delivery from the party the settlement is a remedy against.
- **A7 Lock index at replay.** C3.7 reads a lock at the checkpoint's index
  in replay and at the horizon at the door, so a spend of a locked tag
  admitted between the deadline and the checkpoint's index replays valid.
  Only the note's holder can sign that spend, and Construction §C3 says
  spending a demanded note voids the demand, so the dishonour reading of
  C3.8 should read a spent tag as the holder's void in whichever segment's
  history the spend is witnessed; a spend has no force at the venue. A
  **Decided 2026-09-09**: C3.8 reads a spent tag as the holder's own void
  whatever index the spend was admitted at, since only the holder can sign
  it. No supply or finality effect.
- **A8 Authenticated range completeness.** C2.10.13's first item has no
  authenticated source on Ergo today ([§6](#6-what-each-read-needs-from-the-record)).
  A withheld box reads as silence or as a repair hole. Closed by P4 and a
  venue decision; until then the node is a trust assumption the release
  record must state.
- **A9 Same-index order.** Publications at one index are read in the
  venue's order (C2b.3.2). `ErgoBoxView` carries no transaction or output
  index, so ties follow the node. Candidate: order by block transaction
  index then output index, authenticated with P4. Closed by the venue
  adapter's specification.
- **A10 The instant window against real inclusion.** The window is one lag
  wide (C3.3); a venue publication must land in `[instant + lag, instant +
  2·lag]` or has no force. With Ergo's lag `d + 1` the holder's margin is
  `d + 1` blocks. Closed by P4's inclusion-latency measurement and the
  venue's declared depth.
- **A11 Chunked publication identity.** One publication across several
  outputs of one transaction: canonical reassembly, duplicates, partial
  publication, retrieval after the boxes are spent. Closed by P2 on a node.
- **A12 Freeze together.** v3 pins all six circuits in one configuration,
  so the fee-capable shape (design review F4) and note delivery and
  restoration (F3) must be decided before `pool-v3.md`; this map depends on
  them only through `inputs = 2`, but either moves `configHash`, the domain
  of every note and nullifier, so nothing here is pinned before they are.
  **Decided 2026-09-09: `pool-v3.md` waits for both.** The alternative,
  freezing v3 now and carrying F3 and F4 into a v4, charges every backing a
  second successor migration across a changed domain, and the domain is
  every note's and nullifier's; an extensible configuration that could
  absorb them later is the mutable verifier authority design review F1
  refused. F3 is the next slice, since restoration may reach the note
  itself and so should precede an arity measurement; F4 follows. This map's
  other items were decided first because they are version-independent: they
  amend the contracts, not the layouts.
- **A13 Retention and replay cost.** The redemption reader replays the
  closure; the operator retains exact bytes; the holder keeps leaves and
  the spent set. P3's first run: the reference spent set costs about 2.7 ms
  per insert, so a closure of 10⁵ nullifiers takes over four minutes to
  rebuild before any proof is verified. Replay time and trail bytes remain
  unmeasured. Closed by P3.
- **A14 Device budgets.** No phone measurement of any circuit. Closed by P5
  against a named device and budget.
- **A15 Runtime pins.** `POOL_CONSTRUCTION` is v2-only; `PoolStore` refuses
  silence clauses; `isWellFormedProof` requires a nonempty proof, so a
  proofless withdraw is unrepresentable; `decodeStatement` caps the second
  field at one 64-byte signature, short of the settle's 136. All are v3
  work after the layouts, not before.
- **A16 The standing record is not pruned by deadline.** C3.7 says a demand
  past its deadline "is discharged from the standing-demand record" and can
  no longer be settled; C2b.3.2 reads standing and deadline as two
  conditions, and the model discharges only on settle or withdraw. A
  replayer that pruned by the checkpoint's index would exclude an honest
  checkpoint: a settle admitted at horizon 100 under a demand with deadline
  101 and an acceptance deadline of 101 is legal at the door (C3.4, C3.8)
  and may be witnessed at 150. Candidate: only settle and withdraw
  discharge; the deadline expires the lock at the judging index and gates
  the door and the venue; a never-withdrawn demand stays in the record at
  about 184 bytes. **Decided 2026-09-09**: the candidate. C3.7 discharges a
  demand only by its settlement or its withdrawal, as Construction §C3
  already said, and the retention price is recorded in the contract's costs.
- **A17 The adopted position's index.** A replayer reads an adopted
  statement's locks at the publication's own index (C2b.4.2); the index is
  derived from the venue record, never asserted by the trail. Fixed by the
  replayed state of §4; no contract change.
- **A18 The withdrawal binds its statement.** C3.6 signs the demand identity
  alone, so a withdrawal an operator kept back could be applied under a
  later segment the holder never named. Candidate: sign the withdraw
  statement's hash, which binds the demand and the segment; a return needs
  a fresh signature, which costs no proof. Alternative: drop the segment
  from kind 5's inputs so identity and authorization coincide, at the price
  of one admitted kind without a segment binding. **Decided 2026-09-09**:
  the candidate. C3.6 makes the withdrawal a `withdraw` statement its
  presenter signs by `statementHash`, and C2b.3.2 requires of it at the
  venue the same snapshot binding a demand's proof carries.
- **A19 The acceptance's routing name.** C2b.3.2 lists five kinds each
  naming a backing, but an acceptance carries only its demand, owner and
  deadline (C3.4); it resolves to its demand's backing, and its routing name
  cannot be checked without the demand. **Decided 2026-09-09**: C2b.3.2
  reads an acceptance beside the demand it names, rather than paying 32
  signed bytes for a routing name no reader can use without that demand.
- **A20 Non-membership proofs in the release.** The snapshot digest binds
  `historyHash_n`, not `spentRoot_n`, and every reader of force replays the
  snapshot's trail for its forest and standing demands (C2b.3.3), so it
  holds the spent set and checks absence directly; a proof at `spentRoot`
  adds no verification power to any reader. Candidate: drop the proofs from
  the release and retire pool-v2 §11's proof encoding in v3, saving about
  1.2 KB and one chunk per release; Construction §C2b.3a's non-membership
  is then the replayed set. Alternative: keep them and bind `spentRoot_n`
  in the digest at 32 bytes, so a reader holding the digest preimage can
  check that one condition alone. C2b.3.2, C2b.3.3 and C3.6 are amended
  either way. **Decided 2026-09-09**: the candidate. No reader decides
  force without replaying the snapshot for its forest and standing demands,
  so a published proof restates what its reader already holds; C3.6,
  C2b.3.2 and C2b.3.3 are amended, pool-v2 §11's forward-looking sentence is
  corrected without changing a byte of v2, and Construction §C1.2's
  requirement that the accumulator support non-membership stands. §3 and §7
  now give one size and the saving.
- **A21 The request is a bearer object.** It is unsigned (C2b.5.1), so
  anyone can republish it. An exact republication is the same publication,
  read at its first index (C2b.3.2), so a copy should extend no count
  window and only the holder can refresh a tag with a new proof; C2b.5.2
  does not say so. **Decided 2026-09-09**: C2b.5.2 reads a request at the
  first index a request of its identity was witnessed at naming the backing.
  Independent review then found that this closed the holder's own renewal
  too: refreshing by re-proving under a later canonical root is impossible
  while the operator stalls and admits nothing, which is exactly when the
  grade must count. C2b.5.1 now frames the request as a statement of its own
  kind over its own public inputs, with a holder-chosen **refresh value**
  the proof binds, so only a party that can prove the note mints another
  identity for one tag; a copy still extends no window, and the count still
  deduplicates by tag.

- **A22 What shape the spent set should be, now that no proof is published.**
  With A20 decided, nothing in the pool publishes a spent-set proof: the
  accumulator's only reader is a replayer that rebuilds it. The reference
  trie's framing cost is gone (about 1.4 ms per insert, from 2.1–2.7 ms) and
  what remains is the shape's, not the code's: about 430 node hashes per
  insert, because a lone key's path at height `h` runs through `h ≈ 239`
  empty levels, and an insert pays that chain for the key it adds and again
  for the key it displaces where it displaces one; about a quarter of inserts
  land in an empty subtree and pay one chain only, which is why the average
  is near 430 rather than 480, and why it is flat in `N`. The hash
  implementation is not the lever — a bare `SHA256` of the 86-byte node frame
  costs 2.85 µs on this machine against `node:crypto`'s 2.42 µs — so
  10⁵ nullifiers cost about 4·10⁷ hashes to accumulate however it is coded.
  The amended Construction (§C1.2, invariant 23) requires that absence be
  *establishable*, and leaves the route to the construction, so the
  structure is now a v3 layout choice rather than a Construction change,
  provided it keeps what pool-v2 §§9–11 rely on: a root that is a function
  of the set alone (so an imported closure inserts in any order, §10) and
  that is recomputable per statement, since `historyHash_i` binds
  `spentRoot_i` at every `i`. That last requirement is why a hash over the
  sorted set is not the answer: it is `O(N)` per statement. Candidate worth
  pricing against the present tree: an indexed Merkle tree over a sorted
  linked list in a dense tree of small height, where absence is a
  neighbouring entry rather than 256 empty levels, at about 32 hashes per
  insert. Closed by that measurement before `pool-v3.md` pins the layout.

## 9. Probe plan

Every probe writes its result under ignored `scratch/` and is summarized
here or in [deployment probes](POOL_DEPLOYMENT_PROBES.md) when captured.
None changes `src/`, the pinned v2 identities or the specification.

- **P1 Circuits, offline.** Write `demand.nr`, `settle.nr`, `request.nr`
  beside copies of `notes.nr` and the helper under `scratch/pool-v3/circuits`,
  with `T_TAG` added to `notes.nr`; compile with `scripts/compile-noir.mjs`
  generalized to a kind list; derive keys with the pinned toolchain; prove
  synthetic fixtures from `scripts/pool/fixtures.mjs`; record public-input
  order and count, proof bytes, execution, proving and verification times.
  Hostile witnesses: the same note in both positions, a positive value with
  a zero tag, a wrong tag, padding with a nonzero tag, a note of another
  backing, a settle to another owner or quantity, a wrong `rho_out`, a
  request with a zero value. Acceptance: A4's proof size and timings, and
  the relations of §2 as executed constraints. **Done 2026-09-08**:
  `node scratch/pool-v3/probe.mjs` (sources under `scratch/pool-v3/circuits`,
  result `scratch/pool-v3/results.json`); the numbers are in §7 and A4. Not
  established: constraint counts, and that these sources are the normative
  ones, which `pool-v3.md` pins.
- **P2 Publication, offline then node.** Encode the §3 bodies over P1's
  proofs and the v2 spent-set proofs at a synthetic set; run the existing
  chunking probe in `scratch/ergo-publication` on the real sizes; then, with
  a testnet node, publish a release, spend its boxes, retrieve, and test
  duplicate, reordered and partial chunks. Acceptance: A11 and the §7 sizes
  measured; a stated same-index order.
- **P3 Replay and retention, offline.** Replay a synthetic closure at
  `10^3`, `10^4` and `10^5` statements with `src/pool` and measure time,
  memory, trail bytes and non-membership proof bytes. Acceptance: A13
  measured; a first retention budget. **Started 2026-09-08**:
  `node scratch/pool-v3/nm-size.mjs` measured proof bytes and the spent-set
  build cost in §7; replay of statements and trail bytes remain.
- **P4 Range reads, network.** Against a public Ergo node, compare the
  indexed read with a header-verified scan over one day and seven days of
  blocks: bytes, time, and the inclusion-latency distribution of recent
  transactions. Acceptance: A8–A10 have numbers and one candidate is
  recommended.
- **P5 Device.** Extend `bench:pool:browser` to the demand and settle
  circuits and run it on the target phone. Acceptance: A14 against a
  declared budget.
- **P6 Cases.** After `pool-v3.md`, port `model/pool-fault-alternatives.test.ts`,
  `model/pool-adopted-evidence.test.ts` and the recovery model's departures
  as runtime tests over the new records.

## 10. Acceptance and what follows

An independent review on 2026-09-08 checked every rule citation, the
candidates of §§2–4, the trace, the Ergo description and the arithmetic;
its seven material findings became A16–A21 and the corrections now in
§§2–6, and it confirmed A5–A7, the settle authorization, the adoption
trace and the sizes. This map is complete when such a review has checked
every rule citation and candidate against the contracts, the trace names
the evidence each party holds at each step, and every open item above has an owner
probe or decision. `pool-v3.md` then fixes: the contexts and `T_TAG`; the
statement record with its authorization slot; the six circuits' sources,
identities and public-input orders; the evidence chain and snapshot digest;
the configuration preimage over the six bytecode and key identities, the
helper and the bounds, whose hash is the v3 domain; the publication frame
and bodies; the acceptance, release and withdrawal bytes; the replayed
state; and the bounds table. A1–A3, A5–A7 and A16–A21 were decided on
2026-09-09 in the contracts, and A4 is measured; A12 keeps the layouts
waiting on the delivery/restoration (F3) and fee-shape (F4) decisions,
which move `configHash`. The runtime follows the specification, with the model as
its oracle.
