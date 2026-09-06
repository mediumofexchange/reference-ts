# Pool sequencing: the replacement boundary

Status: unresolved protocol choice, independently confirmed on 2026-09-06.
Implementation inspected: `53c9719`; specification inspected: `81516ba`.
This note is diagnostic, not a normative amendment or an accepted decision.

## The conflict

Construction [C1.3](https://github.com/mediumofexchange/money-from-first-principles/blob/81516ba/construction.md#c13-what-e-declares-for-the-construction)
puts the operator in the immutable configuration and says:

> A change to any of it is a new E, hence a new backing

The construction layout [pool-v1 §2](https://github.com/mediumofexchange/money-from-first-principles/blob/81516ba/pool-v1.md#2-what-e-declares-and-what-the-configuration-fixes)
states:

> A backing whose **E** names an operator and a configuration is served in that operator's pool under that configuration and no other.

Section 6.3 applies that binding when admitting an issue or burn. The pool
identity also includes the operator, and every note commits to that identity.

Yet [pool-v1 §5.4](https://github.com/mediumofexchange/money-from-first-principles/blob/81516ba/pool-v1.md#54-redemption-and-what-this-version-does-not-carry)
expressly includes replacement and takeover (C2.5–C2.8), and calls replacement
the only remedy against a dark operator. Construction C2.5.6 requires wallets
to follow the replacement chain and stops counting the old operator's
signatures at the effective index. C2.7 determines an opening state for each
backing; C5 says each backing can name a different operator later.

A successor cannot both use the unchanged configuration as its own signing
authority and satisfy its original operator binding. Changing the configuration
instead changes E and the backing name. Reissuing under a successor backing is
a different operation from replacing the operator of existing claims.

## Why changing the key check is insufficient

Take two backings, X and Y, originally in P's shared pool. Replace P with Q
for X, leaving Y with P. Pool-v1 §5.2 exposes only:

```text
[poolHi, poolLo, anchor, nf_1, nf_2, cm_1, cm_2]
```

The backing names are private witnesses. A statement may spend notes from
both X and Y, with per-backing conservation. Section 7 gives the pool a
shared history, note tree and spent set, with that history's hash in every
carried backing's snapshot.

Copying the old pool to both operators does not define which operator may
accept an opaque spend, or how their subsequent histories, accepted anchors
and spent sets remain authoritative for the backings each serves. The current
proof contains no assertion binding its hidden backings to the operator's
current authority. Having both operators accept every spend would not enforce
the independent replacements. Refusing all spends would stop Y as well as X.

Reading the configuration's operator as a founding key could be part of a
repair, but that interpretation alone supplies neither the missing authority
relation nor the history-continuation rules. The record, receipt, admission
and proof relations must agree on them.

## What was reproduced

A disposable Node 24.6.0 host-boundary probe ran against the built `53c9719`
modules. P, Q and K were distinct Ed25519 keys. K signed a pool backing
declaring P, the original configuration hash, and K as its replacement rule.
It then signed a replacement naming Q, effective at index 1; Q co-signed it.
The local venue witnessed it at index 0 and advanced to index 1 (lag 0).

The probe asserted all four results:

1. The existing C2 chain reader `successionOf(backing, venue)` names Q.
   This uses the frozen path only as a replacement-record case to port.
2. `new Pool({ ...configuration, operator: Q }, verifier).register(backing,
   signature)` throws `PoolError` with code `BACKING`.
3. Keeping the original configuration makes `signPoolReceipt` refuse Q's
   secret. A manually signed, correctly framed Q receipt also fails
   `verifyPoolReceipt` under that configuration.
4. `parsePublicInputs(SPEND, inputs)` returns no backing name with which a
   sequencer could select a backing's operator.

The verifier was set to throw if called: these are authority and framing
checks, not a circuit-proof experiment. The synthetic accepted record used
to exercise the receipt envelope is not evidence of a lawful issuance.
All four assertions passed. The probe was removed after capturing its result
here; no production guard was relaxed.

## What the existing model establishes

[`model/sequencing.ts`](../model/sequencing.ts) models scheduling, commitment
inclusion/drop, replacement, restart and withheld state. Its statement has a
public `backing` label, `submit` uses that label to choose service, and each
operator stores a separate history per backing. That is useful for the C2
timing rules, but does not model opaque, mixed-backing spends or the shared
pool history. Its passing tests do not establish that pool-v1 can implement
independent replacements. This gap must be represented before claiming that
the claim layer and sequencing model agree.

The recorded [finished-protocol decision](../decisions/2026-09.md#2026-09-05--the-finished-protocol-the-shielded-pool-is-the-core-the-lit-settings-are-profiles-and-c2-is-re-derived-against-the-directory)
explicitly retained operator replacement. The [pool-v1 decision](../decisions/2026-09.md#2026-09-05--pool-v1-pins-the-shielded-pool-and-the-sequencing-model-earns-two-rules)
pinned the operator-bearing configuration and hidden two-backing spends.
Neither supplies the missing relation.

## Options requiring a maintainer decision

| Direction | Required change | Cost |
|---|---|---|
| Preserve independent backing replacement and private spends | Redesign the boundary between immutable note/configuration identity and current operator authority; specify the proof, history and takeover rules together, then extend the model. | More protocol and circuit work before the sequencer; changed layouts require version/successor treatment under the current specification. |
| Replace the whole pool together | Define one pool replacement authority, preserve its identity/history and distinguish the founding key from the current signer. | Gives up independent operator choice; a shared authority adds trust, while unanimous backing consent gives each one a veto. |
| Make v1 a fixed-operator stage | Withdraw v1's replacement promise and explicitly limit it to the original operator, including restart. | Reverses the recorded replacement decision; existing claims have no specified escape from a dark operator. Successor reissuance does not itself rescue them. |

Recommendation: preserve independent backing replacement and private spends,
consistent with the recorded project objective, and repair the specification
and model before building `PoolSequencer`. This recommends a design task,
not an already-proven mechanism. Its acceptance criteria are:

- Current signing authority is derived from witnessed records without changing
  an existing claim's terms or granting the original operator an exit veto.
- A spend proves it is authorized where accepted without revealing its backing
  as an implementation convenience.
- Splitting and subsequently transferring service preserves spentness, accepted
  roots and history continuity, including mixed-backing statements.
- Receipts, commitments and replay agree with those rules through delayed
  witnessing, replacement, restart and unavailable data.
- The model expresses those objects and fails on departures from those rules;
  a reviewed specification lands before the code and circuit changes.

No option has been selected by this note. Independent source review confirmed
the contradiction and these tradeoffs; it did not run the host probe or prove
a proposed redesign. Normative files and implementation behavior are unchanged.
