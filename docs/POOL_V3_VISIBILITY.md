# Who sees what: pool-v3 on Ergo

This is the visibility and collusion matrix the [production requirements](PRODUCTION_REQUIREMENTS.md#trust-and-visibility)
ask the release to publish for its construction: pool-v3 under its one adopted configuration
([§11.4](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/pool-v3.md#114-the-adopted-configuration)),
witnessed at a venue under the [Ergo venue profile](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/venue-ergo.md),
and operated through this repository's wallet, service, reader and publisher as they are. Construction
[§C1.4](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/construction.md#c14-who-sees-what)
gives the construction-wide table and asks each profile for its own; §C1.5 names the four leaks that remain. This
document applies both to the adopted bytes. It adds no rule: every claim follows from a cited rule or from the code
named beside it, and where the reference does less than a rule asks, that is said.

Specification links are at `e7f7f24`; "the wallet", "the service", "the reader" and "the publisher" are
[`wallet-store.ts`](../src/pool/v3/wallet-store.ts), [`service-http.ts`](../src/pool/v3/service-http.ts),
[`package-reader.ts`](../src/pool/v3/package-reader.ts) over `ErgoVenue`, and [`ergo-publisher.ts`](../src/ergo-publisher.ts).

## What the record shows everyone

Histories are served by operators and replicas; the venue carries commitments, replacements, revocations and
publications (pool-v3 §13.1). Every admitted statement's prefix names the configuration, the segment and the
scope root (pool-v3 §2, `P`), so it names the operator's segment and the backings its scope carries, which the
signed directory lists. Proofs
are 14,656 bytes for every relation and authorizations and capsule counts are fixed per kind (pool-v3 §5), so a
record's size tells only its kind, which it states anyway.

| Record | Public | What that discloses |
|---|---|---|
| Issue (kind 1) | backing, quantity, output commitment, one 89-byte capsule, the delivery digest, **K**'s signature | that **K** issued that quantity to an unnamed note; not the recipient (pool-delivery C4.3: no stable key or scan tag) |
| Spend (kind 2) | two anchors, two nullifiers, four output commitments, four capsules | that a transfer happened in this scope at this position; nothing about which notes it consumed, the amounts, the recipients or which output is payment, change, fee or padding (pool-fees C1.2.3). The backing is hidden only among the scope's backings: a one-backing scope names it. Each anchor bounds its input's age (below) |
| Burn (kind 3) | backing, quantity, anchors, nullifiers, change commitment and capsule | the destroyed quantity of that backing; not the change |
| Demand (kind 4) | backing, quantity, anchors, the notes' tags, presenter key, instant, deadline | that someone holding exactly that quantity in one or two notes presented them (C3.3); the tags link the notes to their eventual spend (C3.1) |
| Withdrawal (kind 5) | the demand's identity, the presenter's signature | that the demand ended unpaid by its holder's choice |
| Settlement (kind 6) | backing, quantity, owner, `rho_out`, the output commitment, anchors, nullifiers, the demand, the acceptance deadline, **K**'s and the presenter's signatures | the demanded notes' nullifiers, hence that those notes were the demand's; the output's whole opening (C3.5: redemption is lit at the backer) |
| Request (kind 7, published only) | backing, one anchor, one tag, refresh value | that a real note of that backing waits for service, not its size (C2b.5.1) |
| Acceptance (publication kind 2) | demand, owner, deadline, **K**'s signature | that **K** answered that demand |
| Commitment (venue kind 1) and served directory | operator key, sequence, directory root; each scoped backing's snapshot with `issued` and `burned` | each backing's supply at each checkpoint (pool-v3 §7), which is the public supply verification the protocol exists for |
| Replacement, revocation (venue kinds 2, 3) | backing or **K**, the parties, the effective index, signatures | the authority chain |

On Ergo every venue record is an output at the kind's location whose `R4` is its subject: the operator key for a
commitment, the backing for a replacement or a publication, **K** for a revocation (pool-v3 §13.1, venue-ergo §6).
The transaction that carries it spends its publisher's boxes. So each publication is also linked, by the chain's
own transaction graph, to the key that funded it, to that key's other publications and to wherever its coins came
from. For the operator's commitments, which its key signs anyway, this adds nothing; for a holder's gap acts it
is the largest metadata leak in the profile (see [traffic](#what-traffic-discloses)).

## What each party learns alone

| Party | Learns | Does not learn |
|---|---|---|
| Holder (its own wallet) | its seed and everything derived from it: its notes, change, requests, presenter keys, settlement owners | anything about another seed's notes except what the record shows everyone |
| Payer | the payee's requested opening (backing, value, owner, `rho`) and commitment, from the request frame (pool-delivery C4.1) | the payee's spend secret, hence the note's nullifier and tag, so it cannot tell when or whether the payee spends it; the payee's other holdings |
| Payee | the backing, quantity and opening of its own output, and so which public statement paid it: that statement's anchors, nullifiers, other commitments and timing | which notes the payer spent, the other outputs' openings (change, padding, a fee), the payer's history |
| Issuer (**K**) at issuance | the recipient's requested opening and capsule, quantity and time; the recipient's identity only if the request channel or a separate arrangement discloses it | the note's nullifier and tag (it lacks the secret), so not when or by whom the note is spent or presented; later holders |
| Issuer (**K**) at redemption | the demand's quantity and tags, at settlement the notes' nullifiers, the anchors; its own owner and output; whatever the payout channel discloses | how the notes travelled; whether two demands are one holder's (presenter keys are fresh per demand, derived by the wallet from the seed and the notice) |
| Operator (sequencer) | every record above as it is submitted, before the public, with its arrival time and the submitting connection; each evidence sync's backing and the sequence it resumes from; the order and batching of its own checkpoints | the opening of any output it did not request, which note a spend consumed, a spend's backing within its scope; a holder's identity except through connection metadata |
| Operator receiving a direct fee | in addition, its fee output's backing, value and opening and so the statement it was paid in; in a same-backing payment that reveals the payment's backing (pool-fees C1.2.7) | the payment amount, the payer's inputs, the other outputs' openings. Sponsored service (no fee output) avoids this |
| Witness (Ergo miners and nodes) | the venue records above as transactions, each with its funding inputs; the network address a transaction is first broadcast from, to the node that receives it; for a node the publisher asks for boxes, the funding key (`/blockchain/box/unspent/byErgoTree`) | the histories' statements, which are not at the venue, beyond what a gap publication carries; who reads the record (below) |
| Header and section supplier | the heights and block ids a reader asks for: every block from the anchor's child, which names the anchor and so the venue, not any backing or note | the reader's subjects, notes or keys: a range is answered by exhaustion from the sections (venue-ergo §7) |
| Evidence supplier (operator, replica) | the backing a wallet syncs, how far behind it was, when it syncs | which outputs are the wallet's: the wallet scans every capsule and settlement locally (pool-delivery C4.6) and never fetches one output or path |
| Backup or storage provider | an encrypted handoff (AES-256-GCM under a holder key); a wallet's evidence file, which is public data | without the key, nothing. The wallet's database and its `.replay` file must not reach it in the clear: the replay file shows which outputs are the seed's ([wallet guide](POOL_V3_WALLET.md#evidence-and-kept-state)) |
| Public | the record above | holdings, transfers, the link between a note and the notes a spend created from it |

The payee also learns the payer's anchors, which bound how old the payer's notes are; a payer that spends against
the latest anchor (the wallet does: each held note's path is to the latest root of the segment holding it,
`holdings.ts`) gives away only that its notes predate that root, or, for an imported note, the predecessor
segment's last root.

## Collusion

The three roles a deployment may hand to separate parties are the issuer (**K**), the operator and the witness. A
coalition learns the union of what its members learn, and joins it on identifiers they share: commitments,
nullifiers, tags, statement positions, times, network addresses and funding keys. No coalition among the three
holds a holder's spend secret or seed, so none learns which note a spend consumed or the opening of an output that
none of its members requested. What collusion adds is linkage of metadata to the record, never a cryptographic
trace.

| Coalition | Adds over its members alone | Still cannot |
|---|---|---|
| Issuer + operator | the recipient of an identified issuance joined to the network address that later submits statements, where the holder submits without an anonymizing transport; the redeeming holder's connection joined to its payout identity | link the issued note to the statement that spends it (the operator sees a nullifier, **K** knows only the commitment); see a transfer's amount or recipients |
| Operator + witness | the operator's submission metadata joined to the broadcast address and funding key of a holder's gap publication | the same: everything joined is metadata |
| Issuer + witness | **K**'s redemption knowledge joined to a gap demand's funding key and broadcast address, so a presenter funded from an identified Ergo address is identified | link notes across transfers |
| All three | every party-side observation above, joined: submission and sync addresses and times, funding keys, the payout channel, the identity behind an identified issuance | which note a spend consumed; any output opening none of them requested; a holder's balance |
| A payee + the operator | the payee's knowledge of its statement joined to the submitting connection: the payer's network address, if not hidden | the payer's other statements, except by the same address or timing |
| A payer + the operator | that the payee's later submissions come from an address seen before, if it is not hidden | the payee's note's nullifier, so not which later statement spends it |

These hold under the cryptography the configuration names: the proofs' zero knowledge, which also assumes the
prover's G1 points are the genuine Ignition powers (pool-v3 §4; the runtime loads only parameter copies whose
hashes its manifest names), the hiding of note commitments, nullifiers and tags under the Poseidon2 hashes, and
the capsule's AES-GCM under per-commitment HKDF keys (pool-delivery C4.3). Soundness of supply rests on the key
bytes and at least one honest Ignition participant; privacy rests on the prover's parameters as well.

## What traffic discloses

| Channel | Who observes | Discloses | The reference today |
|---|---|---|---|
| Submitting a statement to the operator | the operator; the network path | the submitter's address and the time, joined to the statement | the service binds `127.0.0.1` and refuses other peers: a deployment's transport is open. An anonymizing transport is assumed, not supplied (§C1.5). One service-wide wallet credential gates local operations; a credential issued per holder would link that holder's submissions, so a deployment's must not identify holders |
| Syncing evidence | the evidence supplier | the backing (`?backing=`), the sequence the wallet was served through (`&after=`), the time and address | whole trails, scanned locally; any source serves the same package. Syncing from a replica instead of the operator moves this to the replica |
| Exchanging a payment request | whoever carries the 246-byte frame | the requested backing, value and commitment, linked to the receiver | the frame travels any private way, its digest over the channel that authenticates the receiver ([request exchange](POOL_V3_WALLET.md#request-exchange)); it carries no endpoint or identity key |
| Reading the venue | header and section suppliers | the venue (by the anchor its reads start from) | `ErgoVenue` fetches every header and every section from the anchor's child from suppliers the reader chooses; it never asks for a subject, an address or a box |
| Publishing at the venue | the witness, every chain reader | the funding key and its coin history, joined to the record; the broadcast address to the receiving node; the funding key to the node asked for its boxes | the operator's publisher holds one funding key, which links its commitments (public and signed anyway). A holder's gap demand, release and withdrawal and a backer's acceptance are published through whatever `RecordPublisher` the caller passes to `publish` or `publishAcceptance` (the wallet files no requests); on Ergo one funding key links every gap act it funds, across demands whose presenter keys are unlinkable. A holder funds each demand from coins with no history it minds, or has a relay publish: a demand carries its proof (C3.3a), a release and a withdrawal the presenter's signature and a request its proof (C2b.5.2), so anyone can publish each unchanged |
| Payout at redemption | **K**, the payout channel | whatever identity the payout needs | outside the record (C3.3a): the protocol neither needs nor proves it |
| Timing | the operator exactly; the public by statement order and checkpoint index | pairing of statements that are alone in an interval (§C1.5) | the operator chooses its checkpoint batching and sees arrival times regardless of it |

## What small pools let an observer infer

The cryptography hides an input among every leaf of the note tree its anchor names, spent or not, of every backing
the scope carries: each issue, burn and settlement adds one leaf and each spend four. The inference below narrows
that set without touching the cryptography (§C1.5), and in a small pool it narrows it to one.

- **The lit boundary.** Issues, burns, demands and settlements show backing and quantity. Where few events
  happen, an issue of `q` and a later demand or burn of `q` pair by amount and order, and the spends between them
  are the candidates for the path. Padding and zero outputs are shape, not cover.
- **Thin intervals.** Statement order is public and the operator chooses how many statements each checkpoint
  holds. Where few statements are admitted between a payment and its payee's next spend, the two pair; the
  operator sees arrival times, so batching hides nothing from it.
- **Presenting whole notes.** A demand names one note of exactly its quantity or two summing to it (C3.3), so
  a holder usually pays itself the exact amount first: a spend followed closely by a demand anchored just after
  it is probably one holder's.
- **Aborted presentations.** A withdrawn, expired or failed demand left its tags public. The note's eventual
  spend reveals its nullifier and so its tag (C3.1): a payment made from it tells everyone, and its payee in
  particular, that its payer presented that quantity at that instant. §C1.5 asks the wallet to spend such a
  note to a fresh one before reuse; **the reference wallet does not yet do so**: once the demand ends, `prepare`
  selects the note like any other.
- **Anchors.** An input's anchor bounds its age; a note imported from a predecessor segment anchors at that
  segment's last root, so spends of old notes stand out after a takeover or a rescoping.
- **Set fingerprinting.** The wallet spends one backing per statement (multi-backing payments are refused), so
  no single statement shows a combination of backings; a holder paying one payee in several backings makes
  several statements, and the combination still identifies it to that payee.

The installable wallet (slice 10) is to explain these to its user before the first payment and at each
redemption: what the payee learns, what the operator learns when it takes a fee, that publication funding
identifies a holder who publishes from an identified address, and that in a small pool timing and amounts can
identify the parties ([production requirements](PRODUCTION_REQUIREMENTS.md#release-contract)).

## What the reference does not do yet

These are wallet and deployment duties the rules above assume; each is listed in [WORK.md](../WORK.md)'s Next.

1. Spend a presented note to a fresh one before using it in a payment (§C1.5, C3.1).
2. Keep gap-publication funding apart from any identified coins: a funding key per demand, or a relay.
3. A network transport for submissions and syncs that does not identify the holder, and a service credential
   that is not per holder.
4. The user-facing explanations above, in the installable wallet (slice 10).
</content>
</invoke>
