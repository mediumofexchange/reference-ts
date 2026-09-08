# Whole-project design review, 2026-09-08

**What this is.** A review round, not a decision. The maintainer asked whether
the project's design choices are the best possible ones for its intent, with
past choices open to revision, radical changes included. This file is written
so that a second instance can check each finding against the cited passages
and decide whether it is right. Nothing here changes a specification, a byte
layout or code. Where a finding contradicts a recorded decision, the decision
is named so it is reopened knowingly, as `DECISIONS.md` asks.

**Revisions reviewed.** Specification `money-from-first-principles` at
`3676757` (paper, Construction, Extensions, pool-authority, pool-recovery,
pool-v2). Reference `reference-ts` at `5b10653` (AGENTS.md, WORK.md, the
decision log through 2026-09-07, `docs/`, `src/`, `model/`, `test/`,
`experiments/private-payment/`). Measured figures are taken from
`docs/pool-v2-verification.json`, `docs/PRODUCTION_REQUIREMENTS.md` and the
2026-09-05 decision entry; nothing was re-run for this review.

**How to read it.** §0 states the yardstick. §1 lists what is right and should
not be reopened. §2 holds the findings, most important first; each names the
choice as it stands with its citation, why it was made, what it costs against
the intent, the alternative, a recommendation, a confidence, and a check the
verifying instance can run by reading. §3 lists what this review assumed or
could not verify. §4 says which findings must be settled before `pool-v3.md`
fixes bytes. §5 is the verifier's checklist.

---

## 0. The yardstick

The intent is the paper's §2 sentence, which the specification's AGENTS.md
holds onto: *"The system should work for ordinary people where public
infrastructure and institutions cannot be relied on: where courts are
captured, where the currency is dying, where the bank will not open an
account."* The same file turns it into a decision rule. Where two designs are
both correct, prefer the one that:

1. still works when the institutions do not;
2. needs permission from nobody, and can be entered by a stranger;
3. can be checked by the person being asked to accept the money, on their
   own device, from the published record;
4. fails in compartments, so one backer's collapse is not everyone's.

Construction §C0a adds the bar a mechanism must clear: one mechanism per
property, no patch on a patch, name what it replaces, derive it from the
object and the law, state the cost, put deployment-specific needs in
Extensions, say it plainly. This review asks of every choice two questions:
does it serve rules 1–4, and is there a simpler mechanism that serves them as
well.

---

## 1. What is right, and should not be reopened

These choices are well derived, their costs are stated, and this review found
no alternative that serves the intent better. The verifying instance can skip
them unless it disagrees.

- **The object and the law.** `B = (K, P, R, E)`, hash-named with `K` inside,
  existing only with `K`'s signature over its own name; the two-line law over
  the backer's written maximum and the holder's holdings. The Appendix's
  "fewer than four fields" argument holds.
- **Reliance as a fixed conjunction of whole unit counts, one level, with the
  closure macro.** The decidability argument (paper §8) and the fractional-
  coefficient argument (Construction Appendix) are correct and complete.
- **Time-only payouts in the core, state-reading payouts in Extensions.**
  This is the largest simplification in the design and it is right.
- **Witnessed time as the only clock**, with the venue's finality rule and lag
  inside its name (C2.3.2, C2.3.5).
- **Supply enforcement as a declared construction inside E** (invariant 11),
  and the shielded pool as the core claim layer with the per-operator
  anonymity set (decision 2026-09-05). Right for the finished protocol; see
  F6 for the cold-start text that disagrees with it.
- **The immutable nullifier** `(domain, commitment, secret)`, independent of
  operator, segment, anchor and path (C1.2.1). This is the one move that
  makes replacement possible at all; keep it whatever else changes.
- **The receiver generates the secret; randomness is derived; admission is
  idempotent** (invariants 25, 26; pool-v2 §3, §8).
- **Two-signature settlement with unilateral withdrawal**, a demand that
  outlives its locks, and dishonour as the branch where no acceptance stood
  (§C3, invariant 27).
- **A commitment authenticates a sorted directory** with absence proofs; the
  record rises in sequence; a receipt names the commitment it stood on, not
  an index (C2.3.3–4, C2.4.2, C2b.4). The retirement of the whole-served-
  state exhibit and the signed opening claim was correct.
- **Finality means witnessed**, and the shielded core has no spend-based
  redirection (C2b.3a–c). The 2026-09-07 recovery boundary is right.
- **The return as a new segment, the adoption index, force once** (C2b.4.1–2,
  C2b.3.1–2). The alternatives listed in pool-recovery §8 were rightly
  refused.
- **Executable adversarial models with departures** as the test of a rule
  before code. This is the project's best methodological choice and it has
  found real holes repeatedly (decision log, 2026-09-01 through 09-07).
- **Engineering hygiene:** strict Ed25519 with small-order rejection,
  prefix-free domain tags asserted at load, framed bytes everywhere, `bigint`
  quantities, verifiers that return `false`.

---

## 2. Findings

Ranked by impact on the intent. F1–F5 change what `moe/pool/v3` must carry,
so they come first.

### F1. The verifier configuration is inside every backing's name and every note

**The choice as it stands.** pool-v2 §2: `E` carries `configuration`, the
SHA-256 over the bytecode and verification-key hashes of the issue, spend and
burn circuits, the Poseidon2 helper source and four bounds. That hash is the
construction domain. pool-v2 §3: `cm = H(T_NOTE, domain, …)` and
`nf = H(T_NULLIFIER, domain, cm, secret)`. Construction §C1.3: *"Changing the
construction or configuration is a new E, hence a new backing."* pool-v2 §15:
*"A change to anything below is `moe/pool/v3`, and a backing moves to it by
successor."* The toolchain is `nargo 1.0.0-beta.26` and Barretenberg `5.2.0`
(pool-v2 §12; `package.json`).

**Why it was made.** One immutable domain so that a note keeps its commitment
and nullifier across operators (C1.2.1); a wallet pins circuit identities and
*"never accepts a verification key supplied with a statement"* (pool-v2 §2).
Both reasons are good.

**What it costs.** Every recompilation that changes bytecode or a key changes
the configuration hash: a compiler release (the compiler is a beta), a backend
release, a circuit bug fix, a changed bound. Each such change makes every
backing that names the old hash a candidate for a successor, and every
holder must sign a swap. Cover written over the old name does not follow
(paper §9; Construction C5 step 5: *"cover will not follow the swap"*). The
paper prices successors for changed *terms*; here a compiler release is a
changed term. An undated root that anchors a local economy (C5 step 2) would
be re-issued at every toolchain change, and the guarantees written over it
would strand each time. That fails rule 4 by construction, and it is the
operator's own supplier, not any adversary, that triggers it.

**Alternative.** Split what the hash binds into two objects:

- a **claim domain**, immutable and inside `E`: the field, the hash `H` and
  its tags, the note, commitment and nullifier formulas, the value bound.
  This is what a note's identity needs (C1.2.1) and it never changes for a
  living backing;
- a **verifier configuration**: circuit bytecode, keys, proof system,
  statement shapes and tree depths. `E` names the *initial* one. The
  witnessed replacement chain (C2.5) gains a second link kind, a verifier
  link, signed by the same rule-holder with the same lead floor. A statement
  is checked under the configuration in force at its segment's opening; a
  configuration change is a new segment, as a scope change already is. A
  wallet accepts only configurations whose identities the construction's
  published registry pins, exactly as it accepts `moe/pool/v2` today.

Notes then keep `cm` and `nf` across a verifier change, because the domain in
the formulas is the claim domain and not the configuration. The mechanism is
the existing chain generalised to a second role (§C0a.1), and it retires the
successor-and-swap as the upgrade path for compatible verifier changes
(§C0a.3). What it costs: a segment header field naming its configuration; a
replayer that holds every pinned configuration a history used; and the
rule-holder can move a backing to any pinned configuration, which is the same
trust the holder already extends to the initial choice.

**Recommendation.** Adopt in v3. v3 changes the note domain anyway, because
its circuits differ, so this is the last cheap moment to decouple.

**Confidence.** High that the cost is real. Medium-high on the alternative's
shape; the verifier link needs its own adversarial model case (a rule-holder
downgrading to a pinned configuration with a known weakness is the case to
write).

**Check.** Read pool-v2 §2 (the `configHash` preimage), §3 (the note
formulas), §15 (the last table's "reviewed setup… build provenance" row).
Then answer: if Barretenberg `5.3.0` emits different bytecode for the same
Noir source, what happens to a backing whose `E` names the `5.2.0`
configuration hash, and to the cover written over it?

### F2. A provably invalid checkpoint bricks every backing its operator serves

**The choice as it stands.** pool-recovery C2b.3.1: *"A carrying checkpoint by
the party then in force that the reader finds invalid blocks the read, as it
blocks C2.7's descent (C2.10.3): it is neither a snapshot nor a licence to
read an older one."* C2b.5.2 blocks the count the same way. pool-authority
C2.10.4: *"A wrong proof or inconsistent history under otherwise live terms is
invalid data, not this public lapse condition or a license to choose an older
state."* WORK.md records as open: *"What remedy a backing has against an
operator whose last carrying checkpoint is provably invalid: it blocks
recovery, the count and any successor's descent alike."*

**Why it was made.** A reader's claim that a checkpoint is invalid is not, as
the bytes stand, something another reader can check: pool-v2 §9 puts the
proof hash into the *receipt* precisely so that *"a stranger served bad bytes
can tell an operator's fault from a replica's corruption"*, but the history
hash does not bind it. `historyHash_i` binds `statementHash_i`, the roots and
`i` only. So "invalid" cannot be told from "corrupted in transit", two honest
readers can disagree, and the safe rule is to block.

**What it costs.** One checkpoint whose served trail fails to verify makes
every backing in that operator's scope unrecoverable, uncountable and
un-takeover-able, with no path out. The trigger is the operator's own act,
hostile or merely buggy (a bit flip in a stored proof does it). This is the
exact opposite of rule 4, and it is the largest single hole this review found
relative to the intent, because it is a griefing attack any operator can run
against all its clients at once.

**Alternative.** Bind `proofHash_i` and `signatureHash_i` into
`historyHash_i` (they are already computed for the receipt). Then the served
trail is content-addressed by the checkpoint: bytes that hash to what the
history binds are the admitted bytes, and bytes that do not are not evidence.
A proof that fails under the pinned key, whose hash matches, is a compact
fault proof: one verification, checkable by anyone. A digest that does not
match replay is a fault every reader of the same bytes decides alike. With
that, C2.7's descent and C2b.3.1's snapshot read can *pass* a proven-invalid
checkpoint as they pass a whole-scope lapse, carrying the fault proof as the
evidence of the step, and the snapshot becomes the last *valid* carrying
checkpoint. Unavailable evidence stays unavailable and still waits; nothing
about that changes.

Under §C0a this is one mechanism generalised (the receipt's evidence binding
moves to the history), and the receipt's own `proofHash` and `signatureHash`
fields can then go, since the history binds them.

**Recommendation.** Adopt in v3, where the history frame changes anyway. This
closes WORK.md's open question with an existing mechanism.

**Confidence.** High.

**Check.** pool-v2 §9: compare the `historyHash_i` preimage with
`receiptBytes`. pool-recovery C2b.3.1, last two sentences. Ask: with the
proof hash in the history, is there any remaining case where two readers
holding bytes that match the checkpoint disagree about its validity? (The
review's answer: none for proof failure or digest mismatch; import-conflict
invalidity needs the ancestry, which is the same availability question as
today.)

### F3. A lost opening is a lost note, and nothing rebuilds holdings from a seed

**The choice as it stands.** Construction §C4, holder key loss row: *"a lost
opening is a lost note."* §C1.2 and pool-v2 §3: the payer *"delivers the
opening to the receiver privately"*; the transport is unspecified. The
specification contains no encrypted note, no viewing key and no recovery
scan (grep `encrypt` across the six documents returns nothing).
`docs/PRODUCTION_REQUIREMENTS.md` and WORK.md list note delivery and backups
as unbuilt release requirements.

**Why it was made.** The paper accepts *"key loss as total loss"* (§4) as a
cost of bearer money, and the pool's minimal note keeps the circuit small.

**What it costs.** Opening loss is a weaker event than key loss, and the
design makes it equally fatal. For the population the intent names, phones
are lost, broken and reset; a wallet whose holdings cannot be rebuilt from a
seed phrase is not safe for them. Zcash-family designs solved this fifteen
years ago with a note ciphertext beside each commitment, decryptable by a
long-term viewing key, so that seed plus public trail recovers everything.
A second cost sits beside it: because the receiver hands the payer a fresh
`owner` per payment, receiving needs a live round trip, and a static `owner`
reused across payers is linkable by those payers (pool-v2 §3). The paper
prices online uniqueness for the payer (§4) and not this liveness cost for
the payee.

**Alternative.** Each output carries an encrypted opening in the served
trail, outside the circuit, roughly 100 bytes, and the receiver's `secret`
for each note derives from its seed and a counter. Two ways to key the
ciphertext:

- (a) **hash only, no new primitive:** the receiver hands the payer
  `{owner, k}` with `k` derived from the seed; the payer encrypts under `k`
  with a hash-derived keystream; recovery re-derives `k` for each counter and
  trial-decrypts. Still interactive.
- (b) **a static receiving key with ECDH** (X25519 is in `@noble/curves`,
  already a dependency): non-interactive receiving, seed recovery, and
  payer-side unlinkability with a payer-chosen diversifier. Costs one new
  primitive, which AGENTS.md rightly makes a decision.

**Recommendation.** (b) for v3 unless the maintainer refuses the primitive,
in which case (a). Either way the trail format gains a ciphertext per output
and the wallet gains a scan; both belong in `pool-v3.md`.

**Confidence.** High on the problem. Medium on preferring (b).

**Check.** Construction §C4 holder-loss row; pool-v2 §3 "delivers the
opening"; `docs/WALLET_DIRECTION.md`, which discusses key loss for a fixed-
creditor promise and not note recovery for circulating claims.

### F4. The 2-input, 2-output shape cannot carry the core's own objects

**The choice as it stands.** pool-v2 §7.2 and §13: a spend has two inputs and
two outputs, a burn two inputs and one change output; *"a different shape is
a different construction."* pool-recovery C3.2–3: a demand names at most
`inputs` claims, all of one backing. pool-recovery §8 excludes reliance sets
and payouts paying in claims.

**What it costs.**

1. **Fees.** Invariant 9: *"Fees are ordinary transfers alongside a swap,
   never a shaved reissue."* C2.1.1 sells the sequencer as *"per-transfer
   fees"* among other models. A payment with change plus an operator fee is
   three outputs. Under 2×2 a fee cannot be paid inside the statement it pays
   for; it must be a second statement, which the operator cannot make atomic
   with the service it renders.
2. **Reliance.** A demand over a backing whose `R` has two members needs
   three inputs across three backings; the paper's worked closure
   `{x:1, y:1, z:2}` needs four. The core's headline feature, cover, is not
   presentable under the core construction's shape, and the recovery contract
   excludes it. This is a shape bound, not a missing rule: it cannot be
   specified later without a new construction.
3. **Padding.** *"A padding input's nullifier enters the spent set like any
   other"* (§7.2). Every single-input spend inserts one junk nullifier into
   the 256-high sparse tree, at 256 SHA-256 evaluations each, forever. Minor,
   but it is a cost nobody priced.

**Alternative.** Choose v3's shape from the objects the core must carry:
inputs of at least four (a claim with two reliance legs, or a small template
closure), outputs of at least three (payee, change, fee). Proving cost grows
about linearly with inputs, roughly 48 Poseidon2 evaluations per input for
the two paths. If one shape is too costly for plain payments, allow several
pinned circuits under one claim domain (which F1's split makes natural) and
let the statement kind select the shape. For padding, either accept the
junk, or add a public real-input count and skip insertion for padding; the
count leaks only what the anchors already half-reveal.

**Recommendation.** Decide the shape against fees and reliance before
`pool-v3.md`, with F9's device measurement as the bound.

**Confidence.** High on (1) and (2). Low impact on (3).

**Check.** pool-v2 §7.2 public-input list and §13's inputs/outputs row;
Construction invariant 9 and C2.1.1; pool-recovery §8 "It excludes".

### F5. The venue-side recovery leg does not fit the venue

**The choice as it stands.** pool-recovery C2b.3.2: a release published at the
venue has force only where, among other things, *"the proof verifies"*, and
C3.6 says it is *"served with the acceptance and the settlement statement,
and with the non-membership proofs"*. C2b.3.3: *"The venue holds bytes it does
not interpret; it is a reader that decides force, and every reader decides it
alike from the same record."* pool-v2 §12 bounds a proof at 131,072 bytes;
the measured UltraHonk proof is 14,656 bytes (`docs/pool-v2-verification.json`).
The venue direction is Ergo, then Bitcoin (decision 2026-08-27). Ergo's box
limit is 4 KB (Ergo reference, box data model; EIP-29: *"A box cannot be more
than 4 kbytes of serialized bytes"*). Bitcoin's data capacity is policy-
limited and priced per byte.

**What it costs.** As written, a release cannot be published in one Ergo box.
Splitting it across several boxes or transactions needs a reassembly frame
and a rule for the index at which force is read; the contract has neither.
Publishing only a hash on chain and serving the bytes off chain would make
force depend on off-chain availability, which C2b.3.3's "every reader decides
alike from the same record" then does not hold. The non-membership proof adds
up to 8 KB per nullifier before the empty-sibling compression. The remedy the
core promises for a dark operator (C2b.3) is therefore not yet publishable on
the venue the project intends to use, and this is not an implementation
detail: the byte size of a proof is a property of the proof system `E`
declares.

**Alternative.** One of:

- (a) a proof system with small proofs for the recovery relations only:
  Groth16 proofs are about 128–256 bytes, at the price of a per-circuit
  setup; the settle and holding circuits are fixed, so the ceremony is the
  same trust class as the universal string already assumed;
- (b) a chunked publication frame: `n` boxes each naming the demand identity,
  the chunk index and `n`, with force read at the index the last chunk lands
  and reassembly defined bit for bit;
- (c) a venue class that carries data beside the chain (a data-availability
  layer), declared in the venue's name, with force read from that layer.

**Recommendation.** `pool-v3.md` must state a byte budget per publication kind
for the venue class it targets, and choose (a) or (b). The choice interacts
with F9.

**Confidence.** High that the mismatch exists. Medium on the remedy.

**Check.** Compare pool-recovery C2b.3.2's release bullet with the measured
`proofBytes` in `docs/pool-v2-verification.json` and the Ergo box limit. Then
answer: where do the 14,656 bytes go?

### F6. The cold start is contradicted between the paper and the build

**The choice as it stands.** Paper §13 on the transparent setting: *"the
honest choice where the crowd to hide in is too small for the pool to buy
anything, which is where §20 starts."* Paper §14: *"This begins in a village,
where the crowd to hide in is so small that everyone is identifiable, and no
construction helps."* Construction C5 step 5: *"One shared sequencer, serving
every backing, with one shielded pool."* `docs/PRODUCTION_REQUIREMENTS.md`:
*"A release that runs the transparent profile instead does not satisfy this
contract."* AGENTS.md: the transparent code is *"deleted when superseded."*
Decision 2026-09-05 made the pool the core and the transparent ledger a
profile; the memory of that session records the maintainer's instruction not
to propose a transparent product.

**What it costs.** The paper's own argument says the first deployments, the
population the intent names, get no privacy from the pool and pay its full
price: a proof on a phone, resync before every spend, 14 KB proofs, a
reference-string trust assumption, a beta toolchain. And the only
implementation that runs end to end today is the one scheduled for deletion.
The pool-as-core decision is right for the finished protocol. Deleting the
transparent profile's implementation is a separate choice, and it removes
exactly the Extension the paper recommends for the cold start.

**Alternative.** Either keep the transparent profile implemented as a
maintained Extensions profile (sharing the object, venue, commitments,
directory, replacement and presentation code; differing only in the claim
layer), or amend the paper to say the pool is the cold-start construction too
and state why the village pays for it. What cannot stand is both texts at
once.

**Recommendation.** The maintainer's call, made knowingly against the
2026-09-05 decision and the instruction recorded with it. This review's view:
a profile the paper prescribes for the cold start should remain implemented,
and "one production path" should mean one *core*, not one profile. At minimum
fix the text: the glossary still calls transparent *"the core setting"* and
shielded *"the core setting hiding histories"* (rows for `shielded`,
`transparent`, `checkable supply`), and §8 says *"issuance is logged in both
core settings"*.

**Confidence.** High that the texts conflict. The remedy is a value judgement.

**Check.** Read the four quoted passages side by side.

### F7. Independent per-backing replacement inside a shared opaque scope is the complexity maximum

**The choice as it stands.** pool-authority C2.10.1–9 with 9a and 9b;
Construction C2.4–C2.8; the five receipt verdicts (final, contradicted,
abandoned, lapsed, pending); `src/pool/{authority,descent,checkpoint,opening,
receipt-record,receipt-repair,receipt-status,receipt-walk}.ts`, about 1,400
lines, plus the two models. Decision 2026-09-06 rejected whole-pool
replacement because it *"removes independent operator choice."*

**What it costs.** All of the above exists so that one backing can leave a
live shared scope against the operator's will while the tail is opaque. Every
auditor of every implementation must follow whole-scope lapse, repair
boundaries, adoption indices and abandonment verdicts (§C0a: *"Every mechanism
added is a permanent charge on both readers"*). The benefit is that a backer
can move its backing without a successor, so cover follows. How often that
case arises is the question: C2.1.2 makes backer-run sequencing the cold-start
default, where rule-holder and operator are one party and "hostile operator
replacement" means a backer moving its own pool.

**Alternatives.**

- **A. A scope is one rule-holder's.** Every backing in a scope shares the
  replacement rule-holder key (default `K`). Replacement is whole-scope by
  construction; per-backing descent, partial lapse, repair and abandonment
  collapse to whole-segment succession; the anonymity set becomes the
  rule-holder's clientele. For backer-run pools nothing is lost. An
  independent operator serving many backers runs one scope per backer unless
  they delegate the rule to one key, so cross-backer privacy is what this
  costs.
- **B. Departure is elective only.** A backing leaves a scope only at a
  committed boundary the operator signs (C2.10.9's first paragraph). A live
  but hostile operator is answered by the silence clause and the non-service
  count, and the backing recovers at the venue, rather than by descent past
  the operator. No receipt is ever "abandoned"; the price is that a hostile
  operator holds a backing until a grade fires.

**Recommendation.** Put A and B beside the current design with their costs
and let the maintainer choose; this is a trust-model choice under AGENTS.md's
stop rule. The review leans A for the cold start and B as the general rule,
and notes that the current design is *coherent* and its complexity is
*intrinsic* to the requirements it chose; the question is whether those
requirements are worth their audit tax.

**Confidence.** Medium.

**Check.** Count the rules in pool-authority §2–4 and the lines in the eight
`src/pool` readers above. Read decision 2026-09-06's rejection sentence. Ask
which deployment in C5's build order has a backing leaving a live shared
scope against the operator's will.

### F8. C2.2 belongs in Extensions

**The choice as it stands.** Construction C2.2.2 is *"a term written under the
state-reading extension"*; C2.2.3's refusal aggregate `(m′, W′)` is on the
card as part of `E`. pool-v2 §8: a refused statement *"leaves no trace"*, so
no signed refusal object exists in the core construction; decision
2026-08-25 already deferred `(m′, W′)` to Extensions; pool-recovery §7 does
not carry it.

**What it costs.** The card promises a term every core backing carries and
no construction implements. §C0a.6: *"If only some deployments need it, it is
an Extension."* It also needs dated cover and reliance, which the core's
recovery contract excludes.

**Recommendation.** Move C2.2.2–C2.2.3 and `(m′, W′)` to Extensions beside
the state-reading payouts; keep C2.2.1's statement of the veto with a
pointer. Text only.

**Confidence.** High.

**Check.** Construction card, `E` line; C2.2.2 first sentence; pool-v2 §8
last paragraph.

### F9. Proving on the spender's device is unmeasured, and the toolchain is beta

**The choice as it stands.** Noir `1.0.0-beta.26`, Barretenberg `5.2.0`,
UltraHonk over BN254 in ZK mode, a universal reference string as *"a trust
assumption of this version"* (pool-v2 §12). Measured once, on a 2015 laptop
in a single WASM thread: 1.1–1.7 s per proof, 96 ms warm verification,
about 560 MiB peak RSS (decision 2026-09-05). `docs/PRODUCTION_REQUIREMENTS.md`:
*"No phone or browser measurement."*

**What it costs.** Construction C5 step 5 prices the pool as *"a proof on the
spender's device"*; the device the intent names is a low-end phone, and that
price is unknown. 560 MiB is above what many Android WebViews allow a page.
v3's spend will be larger than v2's (F4), and every rule above assumes the
holder can prove.

**Alternatives, if the measurement fails.** Groth16 with a per-circuit
ceremony (small, fast, also answers F5); delegated proving with a blinded
witness at the operator (privacy loss toward the operator, contradicting
§C1.4's table); or discrete-log proofs without a circuit toolchain
(Spark/Lelantus-class one-out-of-many with range proofs: no setup, no
compiler, auditable in TypeScript, verification linear in the anonymity set).
Each is a construction decision; none is recommended here without a number.

**Recommendation.** One measured spend on a target phone before `pool-v3.md`,
with the result feeding F4 and F5.

**Confidence.** High on the gap. No recommendation on the system.

**Check.** `docs/PRODUCTION_REQUIREMENTS.md` practical-deployment row;
pool-v2 §15's last table.

### F10. Availability of the trail is the weakest link for the intent

**The choice as it stands.** §C0b: *"Content-addressed storage gives
integrity, not availability. No institution is needed."* §C4 data-withholding
row: *"the remedy is replication."* pool-recovery C2b.3.3: to redeem in a gap
a holder needs *"the snapshot's trail and ancestry, from replicas"*; *"A note
whose history nobody replicated waits."* pool-v2 §4: wallets sync full leaf
lists.

**What it costs.** Recovery, the count, descent and takeover all need bytes
that only the operator or a replica holds, and the operator that went dark is
the party least likely to serve them. In a village with one operator and no
replica infrastructure, "waits" is a total loss with a gentler name. Rule 3
(checkable on one's own device from the published record) is not met when
the record's content lives off the venue.

**Alternative.** A venue class that carries each statement's public inputs
beside the commitment (a spend's eleven field elements are 352 bytes; the
proof stays off chain). The ordered log is then reconstructible from the
chain alone: the spent set, the note roots and the totals follow, and the
proofs are fetched only by a reader who wants soundness rather than
existence. On Ergo at village scale this is a few kilobytes per interval,
priced like the interval. Declared in the venue's name as "trail on venue".

**Recommendation.** Specify it as a venue option in `pool-v3.md`, on by
default for Ergo-class venues.

**Confidence.** Medium.

**Check.** §C0b published-means-retrievable paragraph; C2b.3.3; pool-v2 §4.

### F11. The normative text is fragmenting

**The choice as it stands.** Normative rules for one object now live in four
files: Construction, pool-authority (C1.2.1–2, C2.10.1–9, 9a, 9b),
pool-recovery (C3.1–8, C2b.3.1–3, C2b.4.1–2, C2b.5.1–2, C2b.6.1) and
pool-v2. A reader of Construction §C3 must also read pool-recovery C3.1–8 to
know what a demand is.

**What it costs.** §C0a.7 asks for rules two readers cannot disagree about;
two normative texts for one rule is the documentary form of two mechanisms
for one property.

**Recommendation.** At v3, fold the two contracts into Construction (they are
normative and have been reviewed), keep `pool-vN.md` as the byte layout only,
retire `pool-v1.md` to an archive, and fix the stale glossary rows named in
F6. Text only.

**Confidence.** High.

### F12. Path risk: no end-to-end pool payment exists

**The state.** The sequencing corner cases (lead floor, blind window, cold
walk, receipt verdicts) are deep, modelled and reviewed. The happy path on the
pool, issue → pay → receive → witness → redeem with real proofs on a real
venue, does not exist: no wallet, no note delivery, no venue write side, no
device measurement (`docs/PRODUCTION_REQUIREMENTS.md`, every gate).

**What it costs.** F1, F3, F4, F5 and F9 all change v3's bytes, and each
would have surfaced from a running path sooner than from another contract.
Writing `pool-v3.md` before one exists risks a v4.

**Recommendation.** One end-to-end slice on the pool path, with measurements,
before v3's byte layouts. This is a build-order choice and the maintainer set
the order on 2026-09-05; the review asks for one reordering, not a new order.

### F13. Minor: the law should say it governs finalized holdings

C2.10.9 discards a receipted, unwitnessed tail as a unit, so a payee's
receipted holding can vanish without the payee's signature. The card's
second line, *"No act reduces what a holder holds except one signed by that
holder"*, reads over holdings without qualification. Add "witnessed" or a
pointer to C2b.4's "finality means witnessed". Text only.

### F14. Minor: a venue bridge would move every dated payout's clock

C2.10.2 defers the bridge between venues. Since every payout reads witnessed
time and the clock is the venue's, a bridge must define an index map or is
impossible; the paper's dated instruments assume one clock for their life.
Record that `P` reads the venue named at signing, and that a bridge is a
successor unless the map is declared. Text only.

---

## 3. Assumptions, and what this review did not verify

- No code was executed. Test and line counts come from a read-only
  inventory; the models and the proof checks were not re-run.
- The Ergo 4 KB box limit is from the Ergo developer knowledge base (box data
  model reference and EIP-29), not from node source.
- The mobile cost in F9 is an inference from the desktop figure; nothing was
  measured on a phone.
- The decision log was read from a digest of every entry plus the two
  2026-09-05 entries in full. Decisions before 2026-08-27 were not re-derived.
- The paper's economic claims (§16–§19) were read for consistency with the
  build, not re-argued; this review took the intent as given.
- F1's verifier link and F2's history binding were reasoned about, not
  modelled. Each deserves a `model/` case before it is written into a spec.

## 4. What must be settled before `pool-v3.md` fixes bytes

| Finding | Changes v3 bytes | Changes Construction | Text only | Needs a measurement |
|---|---|---|---|---|
| F1 claim domain / verifier link | yes | C1.3, C2.5 | | |
| F2 proof hash in the history | yes | C2.7, C2b.3 | | |
| F3 encrypted openings | yes | C1.2, C4 | | |
| F4 statement shape | yes | | | F9 |
| F5 venue byte budget | yes | C2b.3 | | F9 |
| F6 cold start | | C5, paper §13/§14, glossary | partly | |
| F7 scope = rule-holder | | C2.10 | | |
| F8 C2.2 to Extensions | | C2.2, card | yes | |
| F9 device proving | | | | yes |
| F10 trail on venue | venue name | C0b | | |
| F11 fold the contracts | | structure | yes | |
| F12 e2e before v3 | | | | yes |
| F13, F14 | | card, C2.10.2 | yes | |

Suggested order: F9 measure; F12 run one path; then decide F1–F5 together,
since they share the v3 frames; F7 as its own design round; F6, F8, F11, F13,
F14 as one text slice.

## 5. Checklist for the verifying instance

For each finding, the question to answer is yes or no. A "no" means the
finding is wrong or overstated and should be struck with a reason.

- **F1.** Does `configHash` contain circuit bytecode and key hashes, and does
  the note's `domain` equal `configHash`? Would a compiler release that
  changes bytecode therefore change every note's nullifier under a new
  configuration? (pool-v2 §2, §3.)
- **F2.** Is `proofHash` absent from `historyHash_i` and present in
  `receiptBytes`? Does C2b.3.1 block on any invalid live carrying checkpoint
  without a fault-proof exception? (pool-v2 §9; pool-recovery C2b.3.1.)
- **F3.** Is there any object in the six specification documents by which a
  receiver recovers a note's opening from the trail and a seed?
- **F4.** Is a spend fixed at two outputs, and does invariant 9 require fees
  to be ordinary transfers? Can a demand name notes of two backings?
  (pool-v2 §7.2, §13; pool-recovery C3.2.)
- **F5.** Is the measured proof 14,656 bytes, is Ergo's box limit 4 KB, and
  does C2b.3.2 require the proof to verify for a release to have force?
- **F6.** Do paper §13 and §14 say the cold start gains nothing from the pool,
  and does Construction C5 step 5 prescribe the pool for it?
- **F7.** Does decision 2026-09-06 reject whole-pool replacement on the one
  ground quoted, and is there a recorded deployment case for per-backing
  departure against a live operator?
- **F8.** Does pool-v2 §8 produce any signed object on refusal? Does any
  construction carry `(m′, W′)`?
- **F9.** Is there any phone or browser measurement in the repository?
- **F10.** Does C2b.3.3 make recovery depend on replicas the protocol does
  not assign?
- **F11.** Count the files a reader of "what is a demand" must open.
- **F12.** Does any test, script or pilot run issue → pay → receive →
  witness → redeem on the pool path?
