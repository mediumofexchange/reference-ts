# Security argument

The [production requirements](PRODUCTION_REQUIREMENTS.md#release-gates) ask for "an independently reviewed security
argument" before release. This is that argument for the reference's release target: what the release claims, what each
claim assumes, and why the checks the code runs imply it. It is written for the external security review (WORK.md
slice 19), which checks it. Errors in it are findings too. It adds no rule. Each step cites the rule it reads and the
code that holds it, and where the reference does less than a rule asks, it says so.

**Scope.** The construction is `moe/pool/v3` under its one adopted configuration
([pool-v3 §11.4](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/pool-v3.md#114-the-adopted-configuration)).
Its venue is declared under the [Ergo venue profile](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/venue-ergo.md).
It runs through this repository's journal, reader, wallet, replica, relay and publisher, built and installed as the
[release record](RELEASE.md) describes. The profile is the smallest supported one: constant-payout roots, no reliance
graph, one pool per operator, public issuance and burn, the failure path and one venue. `moe/lit/v1` (lit notes) is
adopted beside it. It runs on the same state machine and readers, and its claims are listed apart
([lit notes](#lit-notes)). Specification links are at `e7f7f24` for Construction, pool-v3 and venue-ergo; later
commits there change no byte, identity or verdict of theirs. lit-v1 is pinned at
[`80a4ea1`](https://github.com/mediumofexchange/money-from-first-principles/blob/80a4ea1/lit-v1.md), where it was
adopted.

**How to read a claim.** Each claim gives four things:
- the property;
- the assumptions it rests on, from the [list below](#assumptions);
- the argument, from the rules through the code that checks them;
- what remains (the residual), in the words of Construction
  [§C4](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/construction.md#c4-threat-model)
  where it already names it.

The [protocol rules](PROTOCOL_RULES.md) map each rule to its code and to the test that fails if it stops holding. This
document names a rule's code and test only where the argument turns on them.

## Where it runs today

The argument is written for the target: backings declaring venue-ergo's own context, the Ergo mainnet. The release
does not run there yet.
- Its guard (`src/pool/v3/guard.ts`) refuses that context and every identity but three reference venues: the local
  venue, the synthetic Ergo chain and the Ergo testnet ([Ergo venue](ERGO_VENUE_PROFILE.md)).
- Mainnet waits for the slice that enables it, with its anchor's difficulty floor (WORK.md Next 4 (ad)), and for the
  release gates.
- On the reference venues every claim below holds as stated except where it reads A9 and A16:
  - On the testnet, difficulty has collapsed to 1 and its rules predate EIP-37. There "witnessed" means what the
    reader's own nodes show, never work.
  - The synthetic chain runs at difficulty 1, and its context is pinned to a block id.
  - The local venue has no headers.

  On both of the last two, finality holds by construction, not by work.

## Parties and the adversary

The parties are the holders, each backing's obligor **K**, operators, the venue's miners and nodes, header and section
suppliers, replicas, relays and readers. A claim holds for an honest party against an adversary that controls every
other party at once. That includes the operator serving the backing, the backer of any other backing, any number of
holders, every supplier, replica and relay, and the network between them, all colluding. Two parties are outside the
adversary's control:
- the honest party's own device, keys and installed release;
- the venue beyond its declared finality.

Where a claim needs more than that, it names the extra assumption. The usual one is an honest **K** for its own backing's
issuance, or an honest operator for liveness. Two assumptions limit the adversary's control of suppliers:
- A9 needs one supplier showing the heaviest chain;
- A16 needs the venue's anchor to be a header of the real chain.

The construction does not trust the operator for validity. Every party that judges a statement replays it and checks
it, so an operator that admits an invalid statement, or signs a snapshot replay does not reproduce, has produced an
excluded checkpoint, not a new state ([C2.10.11](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/pool-authority.md),
[fault recovery](POOL_FAULT_RECOVERY.md)). The operator is trusted only for service: ordering, liveness and serving
evidence. Each of its failures there has a remedy below.

## Assumptions

Each assumption names what it protects and what follows if it fails.

| # | Assumption | Protects | If it fails |
|---|---|---|---|
| A1 | **UltraHonk is knowledge-sound and zero-knowledge** over KZG on BN254 in the random-oracle model, at BN254's estimated ~100-bit level against discrete logarithms in its target group ([pool-v3 §4](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/pool-v3.md#4-proof-and-conformance-obligations), "Security margin") | Every hidden check: ownership, membership, conservation, nullifier derivation; hiding of witnesses | **Silent** forged statements: inflation, spends of others' notes. One break reaches every backing of the construction, in every pool (§C4 "Hidden issuance"). Zero-knowledge failing exposes witnesses. A quantum computer breaks both |
| A2 | **Barretenberg implements A1**, and the compiled circuits enforce the relations the specification writes: bb.js 5.2.0's verifier and prover under the pinned proof options (`PROOF_OPTIONS`), Noir 1.0.0-beta.26 bytecode whose identities §11.4 pins | Same as A1 | Same as A1. The pinned identities fix which bytecode runs, not that it is right. That rests on the relation audit (area 13), the per-scalar mutation checks of pool-v3 §4 and the conformance report ([conformance](pool-v3-conformance-verification.json)), which are observed rejections, not a proof |
| A3 | **At least one Ignition participant destroyed its contribution** (soundness). For zero-knowledge, the prover's G1 points are the genuine powers. The runtime loads only parameter copies whose SHA-256 its manifest names, and refuses another `[x]_2` (`startBackend`, `src/pool/proof-verifier.ts`; `src/pool/parameters.ts`) | Same as A1 | Whoever knows `x` forges proofs, silently, as under A1 |
| A4 | **Poseidon2** over BN254 (width 4, rate 3) is collision- and preimage-resistant, and with a secret or uniformly random input it behaves as a pseudorandom function. It runs in the circuits and, on the host, in Barretenberg's own implementation (`src/pool/poseidon2.ts`) | Binding of commitments, owners, nullifiers, tags, note-tree and scope-tree roots. Hiding of openings (rho), of the owner's secret, and of the link from a nullifier to its commitment | A collision gives a note two nullifiers (a double spend) or a forged membership. A failure of the pseudorandom function links spends to the notes they consume. The public record is permanent, so a later break exposes past history |
| A5 | **SHA-256** is collision-resistant | Backing names (`terms.ts`), the configuration hash, statement, history, evidence and snapshot digests, the spent-set root, the directory root, request and backup digests, and every lit note derivation (`src/lit/notes.ts`) | Two terms under one name, two histories under one snapshot, a request substituted under one digest |
| A6 | **Ed25519 is unforgeable** under strict verification: RFC 8032's canonical encodings, `s < L`, small-order keys refused (`verifySignatureStrict`, `src/keys.ts`, noble 1.9.7 with `zip215: false`; the cofactored equation) | K's signature over its terms and its issuance, K's acceptance and revocation, the operator's commitment and receipt, a replacement's rule key and successor, the presenter's release and withdrawal, lit owners' signatures | Forged issuance under K's name, forged commitments (equivocation evidence against an honest operator), a forged release or withdrawal |
| A7 | **AES-256-GCM, HKDF-SHA256 and HMAC-SHA256** (Node's crypto). A capsule key is derived per commitment, so its fixed zero nonce is never reused under one key (`src/pool/v3/capsules.ts`). A backup uses a random nonce under a 32-byte key file (`wallet-backup.ts`) | Confidentiality of the delivery capsules (pool-delivery C4.3) and of an encrypted handoff; derivation of every secret from the seed, a note's secret and rho by HMAC rejection sampling (`capsules.ts`) | Outputs' openings exposed from the public capsules; a handoff read by whoever stores it |
| A8 | **The operating system's random generator** (`randomBytes`) is unpredictable. It makes the seed, request identifiers, K, operator and funding keys, and backup keys | Every secret | Predictable secrets, hence theft and tracing |
| A9 | **The venue's heaviest chain does not reorganize past the declared depth** (10 by default), and the reader sees that chain from at least one supplier it selects. On mainnet the reader verifies Ergo headers itself: Autolykos work, EIP-37 difficulty and linkage from the anchor ([venue-ergo §2–3](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/venue-ergo.md#3-the-header-chain), `src/ergo-headers.ts`). On the testnet it rests on the reader's own nodes ([where it runs](#where-it-runs-today)) | Finality of every witnessed act: commitments, revocations, replacements, publications; every clock a backing reads | A majority miner can reorganize past the depth. That is a venue failure for every backing on Ergo (C2.3, §13.2): witnessed payments can be undone, and the order of revocations and publications rewritten. Withheld heavier chains leave a reader behind, not wrong |
| A16 | **The venue's anchor is a header of the real chain.** The anchor is in the venue identity that the operator or backer creates (`venue create`, at its node's height less the depth) and K's terms name. Its 1,024-header context is authenticated by linkage alone, and one supplier provides it (`ergoAnchorContext`, `src/ergo.ts`). The honest party confirms the anchor against its own node when it accepts the terms | Everything A9 protects | A fabricated anchor with a cheap context gives whoever made it the whole venue: order, finality, revocation timing, and different chains to different readers. An honest supplier does not help, since it holds nothing rooted there. A floor on the anchor's difficulty is open for mainnet (WORK.md Next 4 (ad)) |
| A10 | **The evidence is served by someone**: an operator, a replica or a package the reader obtains | Liveness of verdicts only | Missing evidence leaves a read unresolved, never valid, empty or excluded (C2.10.11, §C0b). No claim below becomes false; it becomes unavailable |
| A11 | **The honest party's endpoint is its own**: its device, seed, key files, wallet database and installed release are under its control. One copy of a wallet acts at a time, or a restoration is recorded (wallet [restoration](POOL_V3_WALLET.md#restoring-a-copy-of-the-directory)) | Holder authorization; custody; the reader's verdicts | Theft of everything the device holds (§C4 "Holder key theft or loss"). A reader running altered code believes what it was made to believe |
| A12 | **The payer obtains the request's 32-byte digest over a channel that authenticates the receiver**, and the wallet compares the digest in full by machine ([request exchange](POOL_V3_WALLET.md#request-exchange)) | That a payment pays the intended receiver | The payer pays whoever controls that channel ([below](#the-request-channel)) |
| A13 | **An anonymizing transport** (Tor) carries submissions, syncs and relayed publications; it is assumed, not supplied (§C1.5) | Network-level privacy | Addresses and timing link a holder's acts ([visibility](POOL_V3_VISIBILITY.md#what-traffic-discloses)) |
| A14 | **The release's dependencies are as published**: the registry serves the pinned integrities, and Node 24.21.0 or later runs them ([release record](RELEASE.md)) | That the installed code is the reviewed code | Anything the substituted code chooses |
| A15 | **One operator key, one journal.** The commitment's signed message is `"moe/commitment/v2" ‖ sequence ‖ root` (pool-v3 §13.1); it names no venue, domain or segment. `moe operator init` draws a fresh key per directory and takes none from outside, and a directory declares one venue. Reuse on one venue by two directories is protocol rules party duty 2; reuse across venues is party duty 12 | That the commitments at a venue under a key are the ones its journal made there | Anyone can copy the key's commitments between venues. One copied commitment the journal did not sign ends its service for good (`CONFLICT`, `store.ts`), so the operator goes dark and its backings go to recovery. A copy with a higher sequence makes the venue drop the operator's later, lower ones (C2.3.3), so receipts naming them read as moved past and lapse. Two venues' commitments at one sequence are equivocation evidence whether copied or not (WORK.md Next 4 (bh)) |

## Claims

### 1. Supply

**Property.** Take a backing and a checkpoint that a reader judges valid at a witnessed index. Then that checkpoint's
`issued` and `burned` are what its history did:
- every unit entered by an issuance **K** signed, witnessed before any revocation of **K** at that venue;
- every spend conserved each backing's quantity;
- no nullifier was spent twice;
- every burn destroyed units that existed.

So `outstanding = issued − burned` (invariants 10 and 12). The [release contract](PRODUCTION_REQUIREMENTS.md#release-contract)
calls this public supply verification: a stranger checks it without any secret.

**Rests on:** A1–A6, A9 and A16 for "witnessed", A14 for the reader's own code. It needs no honest operator, no honest
holder and no honest K of any other backing.

**Argument.** The argument is induction over the replayed trail, as
[§C1.2](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/construction.md#c12-the-shielded-pool)
states it: "Supply follows by induction from empty genesis and canonical finalized imports."
1. *The trail is the one the operator signed for.* The reader authenticates the snapshot preimage against the digest
   in the operator's signed directory, witnessed at the venue (pool-v3 §7.1). It then replays the served trail and
   must reproduce that snapshot. The snapshot binds the history hash, a SHA-256 chain over each statement's hash, note
   root, spent root and position (pool-v3 §7). So the commitment binds the order of statements, not only the roots
   (invariant 23).
   - A trail that does not reproduce the snapshot is unresolved evidence, never a valid one (`scope-reader.ts`, the one
     walk; `pool-v3-scope-reader`, `pool-v3-package`).
   - A replica's substitution cannot reproduce the evidence chain (pool-v3 §7.1, A5).
2. *Each event is checked before it counts* (`judgmentOf` in `src/pool/v3/state.ts`; the per-kind view in
   `construction.ts`). Every proof verifies under the key of its own kind. The verifier picks the key by kind and never
   takes a key supplied with a proof (`src/pool/proof-verifier.ts`). Its keys are derived from the shipped bytecode
   and must match the manifest's (`requireConfigurationVerifier`). So spend and burn, both with 15 public inputs,
   cannot pass as each other (pool-v3 §4; `pool-v3-programs`, `pool-v3-configuration`).
3. *Issuance (kind 1).*
   - **K**'s strict signature covers the whole statement (`SIGNATURE`). K's key is derived from the signed terms whose
     hash is the backing name, never supplied apart (pool-v3 §11.3; `terms.ts`).
   - Issuance witnessed at or after K's revocation is void (`REVOKED`, C2b.1).
   - Totals stay below 2⁶⁴ (`SUPPLY`).
   - The circuit proves a positive quantity and an exact note commitment (§3.1).
4. *Spend (kind 2).* The circuit proves knowledge of each input's secret and opening and its membership at an anchor.
   It also proves conservation separately for each input backing, over widened sums, so no field or `u64` wraparound
   can stand for conservation (pool-v3 §2, §3.2; pool-fees C1.2.3). The host requires:
   - the two nullifiers distinct, nonzero and absent from the spent set (`SPENT`);
   - the four output commitments distinct, nonzero and new (`OUTPUT`);
   - both anchors roots of the accepted forest (`ANCHOR`).

   The nullifier is `H(T_NULLIFIER, domain, cm, secret)` with `owner = H(T_OWNER, secret)` inside `cm`. A note
   therefore has one nullifier unless Poseidon2 collides (A4), and a spent note cannot be spent again.
5. *Burn (kind 3)* proves both inputs and the change name the public backing, and that inputs equal quantity plus
   change. The host refuses a burn above `issued − burned` (`SUPPLY`).
6. *Settle (kind 6)* proves its inputs sum to the quantity and that the output carries that quantity. It changes no
   total: redemption is a transfer to the backer (invariant 10).
   - *Demand (kind 4)* creates nothing.
   - *Withdrawal (kind 5)* has no proof and creates nothing.
7. *Imports count once.* A multi-backing or successor segment imports the canonical finalized closure. Each imported
   event identity counts once, and a nullifier repeated across the closure refuses (`SPENT` and `OUTPUT` in
   `scope-reader.ts`; C2.10.5–7).
8. *Adoption re-judges only uniqueness.* A returning or successor segment adopts the gap's publications, its
   adopted block (C2b.4.2). Each adopted record must be the exact bytes of a publication judged with force at its own
   index, where its proof, inputs, locks and signatures were checked (the reader's own force reads, `store.forced` in `scope-reader.ts`). Adoption
   itself skips those checks (`judgmentOf`, mode `adoption`). It re-checks the backing, a repeated statement, the
   nullifiers and the outputs, and an issuance's signature and supply. The block holds only demands, withdrawals and
   settlements. No issue, spend or burn is ever adopted, so adoption moves no total.
9. *Only valid checkpoints count.* A checkpoint whose trail fails a check is **excluded**. It supplies no state,
   import or clock reset, and the reader passes over it to the last valid prefix (C2.10.11–12). Missing evidence is
   **unresolved** and gives no verdict. Neither can raise a total.

Steps 3–9 hold for every replayed event, from empty genesis. So at every valid checkpoint the totals are the sum of
authorized issuances minus valid burns, and every unspent note traces to them.

**Evidence.** `pool-v3-state`, `pool-v3-scope-reader`, `pool-v3-force` and `pool-v3-verifier`, and the
[conformance](pool-v3-conformance-verification.json) and [local replay](pool-v3-local-replay-verification.json) reports,
both with real proofs. The relation boundary was audited (area 13), as were the state machine (area 27) and the readers
(area 31).

**Residual.**
- A proof-system or parameter break (A1–A3) is silent, and it reaches every backing of the construction.
- A stolen **K** issues without bound until its revocation is witnessed (§C4 "Backer over-issuing"). A threshold K is
  the party's defence (protocol rules, party duty 3).
- A revocation signs only K (`"moe/revocation/v1" ‖ K`), so anyone can copy it to another venue, which only does
  what K owes. Until it is witnessed at a venue, a stolen K keeps issuing to backings that declare that venue (C2b.1:
  K publishes to every venue its backings name).
- The check covers accepted claims. It says nothing of the issuer's creditworthiness or of payment outside the
  claim layer.
- The verdict is only as current as the reader's view of the venue (A9).

### 2. Payment soundness

**Property.** Five things hold for an honest holder:
1. A note is spent at most once in the canonical history.
2. Only its owner's secret consumes it.
3. A payee's wallet credits a payment only when the exact output it requested stands in the canonical frontier.
4. Evidence of one payment cannot fulfill another request.
5. A payment is final once the checkpoint holding it is witnessed.

**Rests on:** A1–A6, A9, A11, A16; A12 for "the intended payee"; A15 for finality and liveness.

**Argument.**
- *Once.* This is supply's steps 2, 4 and 7: one nullifier per note, refused when repeated, at admission and at every
  replay.
  - "The canonical history" is one per backing at each index. The term chain names one party in force at a time
    (C2.5, C2.10). A takeover imports only another operator's checkpoints witnessed before its own term began, and a continuation's opening must be held before the checkpoint (`IMPORT_RANK`). A
    segment that intervening silence retired lapses with its unfinished receipts (C2b.4.1/3,
    [decision](../decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts)).
    That last rule prevents the reproduced old-segment double spend, kept as a counterexample ([fault recovery](POOL_FAULT_RECOVERY.md)).
  - A demand reserves a note by its tag without spending it. While the demand stands, until its deadline, the
    pending-lock set refuses the note to any other statement (C3.3, `locked` in `recovery.ts`; `pool-v3-redemption`).
- *Only its owner.* Every statement that consumes a note (spend, burn, settle) proves knowledge of the secret behind
  its owner (A1, A4), and so does every statement that reserves one (demand). No other path consumes a note:
  - no operator debit, clawback or reset exists (invariant 8);
  - fees are ordinary outputs the payer creates (invariant 9);
  - a settlement needs, besides the holder's proof, K's acceptance and the presenter's release (invariant 27; the
    next claim).
- *The receiver makes the secret* (invariant 25; pool-delivery C4.1). The payer receives an opening whose owner is
  the hash of a secret it never learns. It cannot spend the output it creates, and it cannot compute that output's
  nullifier or tag.
- *Fulfillment.* `fulfill` (`wallet-store.ts`) credits a request only when its exact output commitment and capsule
  stand in the canonical frontier the wallet replayed, forced spends and locks included (pool-delivery C4.5).
  - Each request draws a fresh random identifier from which its rho derives (A8), so two requests have two
    commitments.
  - Output commitments are unique in a history (`OUTPUT`), so one statement fulfills at most one request.
  - A payment whose output another statement created fails rather than credits (audit area 29).
- *Finality.* A receipt names the commitment it stood on (§C2b.4). A reader answers final only where the venue
  holds that commitment at depth, and the checkpoint is valid.
  - A receipt alone proves acceptance, not a holding (protocol rules, party duty 7).
  - An operation co-signed after the last witnessed commitment dies with the operator's unpublished tail.

**Evidence.** `pool-v3-payer`, `pool-v3-wallet`, `pool-v3-request`, `pool-v3-redemption` and `pool-v3-store`; the
[journal](pool-v3-store-verification.json) and [history](pool-v3-history-store-verification.json) reports. The command
drill pays and fulfills with real proofs from separate installs ([separate installs](RELEASE.md#separate-installs)).

**Residual.**
- The window since the last witnessing (§C4 "Double-spend"). A payee should treat a payment as pending until its
  checkpoint is witnessed.
- A venue reorganization past the depth (A9) undoes witnessed payments.
- Whoever holds a request frame can pay it first: the payee is paid, by someone else, and the intended payer's
  `prepare` refuses the request as paid.

#### The request channel

This is slice 19's decision (c) ([decision](../decisions/2026-10.md#2026-10-09--state-the-releases-security-argument-take-the-request-digest-as-its-authentication-channel-and-give-every-gates-open-item-an-owner-slice-19-m19a)).

A request travels as a 246-byte frame, any private way. The payer accepts it only when its SHA-256 equals a digest
obtained from the receiver over a channel that authenticates the receiver (A12). Examples are a code the payer scans
from the receiver's own screen, or a string received from a contact the payer already authenticates.

The wallet compares all 32 bytes by machine. A person comparing a prefix or suffix is never asked to: a substituted
request can be ground to match a short comparison. The frame carries no receiver identity key, because a stable key
would link a receiver's requests (C4.3).

The release's channel is therefore the payer's own choice of an authentic carrier for 32 bytes. The protocol does not
supply one, and no format can supply one.
- A text or QR spelling of the frame (Next 9) is a convenience over the same digest. It is not a second mechanism.
- A request signed under a stable receiver key would link every request of that receiver (C4.3).
- A request signed under a key kept per payer relationship links requests only within a relationship the payer
  already knows. It buys continuity after first contact (trust on first use), but the first contact needs the same
  authentic carrier. It adds a signed message and a key per relationship to the wallet's custody. It is left as a
  later candidate beside Next 9's frame, for when a deployment shows repeat payers need it.

The same rule covers an operator's fee request (`--fee-request`, `--fee-digest`), until signed fee quotes exist. The
payer needs an authentic carrier to the operator as well. A substituted fee request diverts the fee to whoever
substituted it, and since the fee is taken in the payment's backing, it shows them that backing.

The limit: where the carrier is not authentic (a substituted code on a counter, a compromised messenger), the payer
pays whoever substituted it, and nothing in the protocol detects that.

### 3. Payment privacy

**Property.** Except through the disclosures listed below, no other party, the operator included, learns which note
a spend consumed. Nor does it learn the opening of an output it neither requested, received nor issued, except a
settlement's lit output. Nor can it link a note to the notes a spend created from it. This holds for any coalition
of issuer, operator and witness (§C1.4).
- A payer knows the opening it pays.
- **K** knows the openings it issues.
- A payee knows the statement that paid it.

**Rests on:** A1's zero-knowledge with A3's genuine powers, A4 (hiding), A7 (capsules), A8; A13 for metadata.

**Argument and residual.** The matrix [Who sees what](POOL_V3_VISIBILITY.md) is this claim's argument, record by
record and party by party, with collusion and traffic. In short:
- A spend publishes two anchors, two nullifiers, four commitments and four capsules.
  - A nullifier is a pseudorandom function of the owner's secret (A4).
  - A commitment hides its opening under a rho drawn by HMAC rejection sampling under a seed-derived key (A4, A7,
    A8).
  - A capsule is AES-GCM under a key only the receiver's seed derives (A7).
  - The proof reveals nothing beyond its public inputs (A1).
- Disclosed by design:
  - the lit boundary: issuance, burn, demand and settlement show backing and quantity, and a settlement's output is
    wholly lit;
  - a demand's or a request's (kind 7) tags. Each links its note, permanently, to the spend that consumes it and so
    to that spend's outputs, and to any other demand or request over it;
  - an anchor's bound on a note's age, for a request too;
  - to a payee, the paying statement and the payer's anchors;
  - a direct fee's backing, to the operator that takes it;
  - a gap act's funding key, unless a third party's relay funds it.
- What remains is inference, without touching the cryptography: small pools and thin intervals pair statements, and
  a set of backings fingerprints its holder (§C1.5).
- Network metadata needs more than A13. An evidence supplier learns which backings an address follows. A command that
  syncs and then submits on one circuit (`pay`, `freshen`, `move-window`) shows the operator which backing the spend
  moves, even over Tor; `sync` and then `pay --package` on separate circuits avoids it. These are the limits of the matrix's
  [duties](POOL_V3_VISIBILITY.md#wallet-and-deployment-duties-and-their-limits), items 2–3.
- The record is permanent, so privacy rests on A1, A4 and A7 holding for as long as anyone cares about the history.
  A later break of Poseidon2's hiding or of AES exposes the past, and nothing in the construction gives forward
  secrecy.

### 4. Holder authorization

**Property.** No party moves, presents, settles or withdraws a holder's note without that holder's act, and
recovery gives no other party that authority.

**Rests on:** A1, A4, A6, A11.

**Argument.**
- *Movement* is claim 2's "only its owner".
- *Presentation.* A demand (kind 4) is authorized by its holding proof. The proof binds the notice: backing,
  quantity, tags, presenter key, instant and deadline (C3.2–C3.3a). No signature is added. The presenter key is
  fresh per demand, derived from the seed and the notice (`redemption.ts`), so demands do not link by key.
- *Settlement* takes two signatures (invariant 27):
  - K's acceptance, naming the demand, its owner and its deadline;
  - the presenter's release over the demand, the acceptance and the settlement's statement hash (C3.6).

  The holder's settle proof consumes exactly the notes the demand tagged (C3.5's tag check). K cannot void a demand
  alone, and the holder cannot be settled to an output it did not release.
- *Withdrawal* is the presenter's strict signature (C3.6). In a gap, every act is published by anyone, unchanged,
  and its proof or signature is its authority (C3.3a), so a relay can delay an act but cannot alter it.
- *Recovery.*
  - Snapshot redemption is the holder's own demand, acceptance and release against the last valid snapshot
    (C2b.3a–b).
  - Return and takeover adopt the gap's demands, withdrawals and settlements, each judged with force at its own
    index (supply's step 8). They create no spend authority and adopt no issuance (C2.7, C2b.4).
  - No recovery path signs for a holder, and no key resets a wallet.
- *The wallet acts only on its holder's command.*
  - The service's credential grants operations, not spending (protocol rules).
  - A reopened wallet fences earlier handles.
  - A wallet that sees another instance of its seed act refuses to act until a restoration is recorded (`FORKED`,
    [wallet](POOL_V3_WALLET.md#when-another-instance-of-the-seed-acts)).
  - A handoff is encrypted under a holder key, and its digest is checked before decryption (`wallet-backup.ts`).

**Evidence.** `pool-v3-redemption`, `pool-v3-force`, `pool-v3-wallet`, `pool-v3-wallet-backup` and
`pool-v3-wallet-kept`; the [redemption](pool-v3-redemption-store-verification.json) reports. Audit area 29 covered the
wallet.

**Residual.**
- Device compromise or seed theft is theft (§C4 "Holder key theft or loss"), and loss of every key, opening and backup
  is unrecoverable.
- The backup key file is raw custody, with no passphrase.
- Detecting another instance of a seed follows the venue. A lost instance's statement in flight, or a note another
  instance received and spent between two reads, is not prevented (M13f limits, WORK.md Next 4).
- *Late-witnessed release* (C3.5, residual since M13f):
  1. A release sent in time is witnessed without force only after the holder has re-proved at the same disclosure
     count.
  2. It has then disclosed the re-proof's output.
  3. The backer can insert that output first and have the settlement refused.
  4. The holder re-proves at the next count. The cost is a delay, not lost claims.

  Cancellation (Next 9) or a v4 binding of the acceptance in `rho_out` closes it.

### 5. Compartmentalized failure and recovery

**Property.** A failing party harms only the backings that declared it, and each declared failure has its stated
remedy. The failing party may be an operator, a K, a replica, a supplier or a relay. The remedies are detection,
exclusion, silence, snapshot redemption, return, replacement or revocation. Durable operation is part of this claim:
an operator that crashes, restarts or is restored from a copy exposes no conflicting signatures and loses no accepted
operation silently.

**Rests on:** A5, A6, A9, A15, A16; A1–A4 for excluding an invalid checkpoint, since the verifier must reject it; A10
for liveness. A backing's own **E** supplies the silence durations, the
non-service aggregate and the replacement rule, which the holder accepted with the terms.

**Argument.**
- *An operator cannot forge state.* Supply's step 9: an invalid checkpoint is excluded and passed over. It does
  not end the segment, reset the clock or grant state (C2.10.11–12, [fault recovery](POOL_FAULT_RECOVERY.md)).
- *Equivocation is evidence, not a remedy.* Two commitments with one sequence and two roots, under one key, are
  fault evidence anyone can check (invariant 22; `isEquivocation`, `venue-records.ts`). No reader acts on it: the
  record keeps one commitment per sequence and key (C2.3.3), and a twin is not read. The journal refuses service for
  good once it sees a commitment of its key that it did not sign (`CONFLICT`, `store.ts`), so a second writer stops
  the first (A15). As §C4 says, evidence of fault "does not restore spendability or compel payment". The remedy is
  the silence clause and replacement below.
- *An invalid statement is evidence too.* A checkpoint whose own evidence fails a deterministic check is excluded,
  and portable fault evidence (pool-v3 §9) lets a reader show it without the whole trail.
- *Withholding is not a verdict.* Missing evidence is unresolved, never an empty balance or a proof of omission
  (§C0b, C2.10.11; A10).
- *Darkness opens redemption.* Past the declared silence, measured from the backing's last valid carrying
  checkpoint (C2b.6.1), a holder redeems against that snapshot without the operator (C2b.3).
  - Eligibility is replayed from the spent set, not asserted (C2b.3.3).
  - A returning operator must open a new segment and adopt the gap's settlements before it serves (C2b.4.1–2).
  - Non-service is counted from proven requests (C2b.5.2).
- *Replacement and revocation are per backing and per K.*
  - A replacement is co-signed by the successor and takes force at a witnessed index (C2.5).
  - A takeover imports the backing's canonical closure (C2.7).
  - A revocation stops K's further issuance at its witnessed index and leaves existing claims standing (C2b.1).
- *Durability.* The journal commits each accepted statement, signed commitment and adoption atomically before
  exposing it (C2.8, [service](POOL_V3_SERVICE.md)).
  - A restarted operator resumes from its latest signed commitment and waits the lag.
  - A directory restored from a copy signs only a return at a skipped sequence, once silence is witnessed (M13d).
  - Exact retries return the original receipt (invariant 26).

**Evidence.** The [recovery](pool-v3-recovery-store-verification.json), [succession](pool-v3-succession-store-verification.json)
and [scope](pool-v3-scope-store-verification.json) reports, each also on the synthetic Ergo venue, with real proofs. The
live testnet scope drill and recovery are historical ([production requirements](PRODUCTION_REQUIREMENTS.md#release-gates)).
`pool-v3-recovery-store`, `pool-v3-succession-store`, `pool-v3-store` and `pool-v3-fault-evidence`; audit areas 27, 28
and 31.

**What does not stay in its compartment.** These failures reach past one backing:
- **The proof system and its parameters** (A1–A3): every backing of the construction.
- **The venue** (A9): every backing that declares it. On Ergo, one address mined 51% of a measured day's blocks, so a
  majority miner can reorganize past depth 10 ([venue research](VENUE_ALTERNATIVES.md)). The research bounds Ergo to
  development, testnet and small-value pilots until a second venue profile or a venue-moving record exists (Next 9,
  12). The release itself runs on reference venues only ([where it runs](#where-it-runs-today)).
  A backing leaves a failed venue only by successor and swap (venue-ergo §9).
- **A shared operator**: every backing in its scope goes illiquid together. Substitutability is not diversity (§C4
  "Sequencer concentration").
- **The release's code and dependencies** (A14): every party running it.

**Residual.**
- A remedy needs the evidence: a holder whose backing nobody replicated waits (§C4 "Data withholding").
- Nothing can be witnessed while the venue is down, and every clock stops with it.
- A restart after a code version that names another kept context, or after a damaged reads file, replays the whole
  history inside an admission. That could lapse a short silence window (WORK.md Next 4 (bg)).

## Lit notes

`moe/lit/v1` is a priced choice for a lit ledger. It makes the supply, soundness and authorization claims and **no
privacy claim**: every statement names its inputs, outputs, backing and quantities.
- Its supply and soundness rest on A5 and A6, not A1–A4. Notes, nullifiers and tags are SHA-256 derivations
  (`src/lit/notes.ts`).
- Each input's owner signs a spend, burn, demand or request. K signs an issue. A settlement takes K's acceptance,
  signed by K and the acceptance's owner key, and the presenter's release (`src/lit/records.ts`, lit-v1 §3).
- Its failure path is the pool's, judged by the one state machine through lit's view.
- Its residual is the pool's without the proof system's. Its lit boundary is the whole record.
- A resumed lit reader rebuilds its kept output and own demand rows from the trail (lit-v1 §10), since a settlement
  derives its output from its demand's row; the other kept rows rest on §14's digest, as the pool's do (A11).

## What this argument does not claim

- The issuer's creditworthiness, or delivery of any payout outside the claim layer.
- Network anonymity (A13), availability of evidence (A10) or of the venue, and resistance to denial of service beyond
  the [declared budgets](PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets) and the services' local limits.
- Side channels on a holder's device, such as proving time, memory or power.
- Qualified device custody, storage, backup or mainnet operation. These are open release gates needing provisioning
  authority (WORK.md, retained boundaries).
- A phone or browser wallet, which lie outside the release target.
- Interoperability across two releases. A release that changes bytes, identities or verdicts is a successor
  construction.

## Open items this argument found

- **(bh)**, Next 4: A15. The commitment frame binds no venue, so one operator key used on two venues lets anyone copy
  commitments between them. The reference never reuses a key: `moe operator init` draws a fresh one and takes none
  from outside. The party duty is now protocol rules item 12. A venue-bound commitment context is a v4 candidate.
