# Production requirements

Status: release contract, revised 2026-09-05; evidence refreshed 2026-09-09. This document defines what a
finished implementation of the protocol must deliver and the evidence each
gate needs. It does not amend the normative protocol; protocol choices land in
Construction first, and the implementation tracks the revision pinned in the
README. There is no release date. A finished, working protocol is the
deliverable. For each mechanism, settle the specification, model its new
semantic risks, and implement it with observable acceptance evidence. Order
slices by dependencies and costly unknowns; bring wallet, service and witness
integration alongside the core to expose constraints before formats are fixed.

The approved [deployment probes](POOL_DEPLOYMENT_PROBES.md) bring provisional
device/venue and recovery evidence forward before v3's layouts are frozen.
They do not change the specification-first rule for production implementation.

## Progress estimate

The target is the smallest supported profile below as a usable end-to-end
product: a holder can install a wallet, receive, verify, pay and redeem; an
operator can run it durably; independent readers can verify supply and execute
the declared failure paths with the original operator offline. One supported
witness must actually accept publications. A mock, ideal model or offline
transaction size does not establish these outcomes. Release gates still apply.

Baseline at 2026-09-08: **about 40% done / 60% remaining**, plausibly
**30–50% done / 50–70% remaining** as roadblocks become clearer. This is a
judgment of engineering effort toward that target, not a measured fraction of
features, code or tests and not a delivery-date prediction. Foundations include
v2 proofs/notes, replay, authority, receipts and durable sequencing; reviewed
recovery/fault models reduce design uncertainty but are not runtime recovery.

Most remaining effort is v3 recovery/evidence formats and circuits, runtime
integration, a pool wallet and service transport, authenticated delivery and
restoration, witness publication, and deployment/security assurance. Device
limits, custody/rollback and evidence availability can force redesign. Update
the estimate when demonstrated outcomes or new evidence change the remaining
work; allow it to move backward and explain why. Workflow/documentation cleanup
alone does not increase it. Keep the current estimate in `WORK.md` and include
done/remaining, uncertainty and the largest blockers in development wrap-ups.

## Release contract

Deliver one payment implementation in which ordinary people can hold, send,
receive, verify and redeem claims under public immutable terms, with **private
payments and publicly verifiable supply both essential.** The claim layer is
Construction's core, the shielded pool (§C1.2). A release that runs the
transparent profile instead does not satisfy this contract; that profile is a
priced choice for deployments that want a lit ledger, and this repository keeps
its transparent path only as a differential oracle until the pool path passes
its cases.

The smallest supported profile: signed roots with a constant payout, no
reliance graph, private transfers in one pool per operator, public issuance and
burn, a complete failure path (silence, snapshot redemption, replacement), and
one witness venue. More payout forms, reliance graphs and optional
constructions wait. The wallet and operator use the same declared profile,
proof rules, witness finality and version, all named in **E**; a change to any
of them is a successor backing.

Privacy means cryptographic protection of ordinary ownership and transfer
history from other holders, the operator and public observers: which note a
spend consumed and the openings of outputs a party does not receive are
hidden. A fee recipient, including an operator, learns its own fee opening
and statement association; a same-backing fee flow reveals the payment
backing by inference. The [fee contract](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md)
states these disclosures and the sponsored-service alternative. Issuance,
burn, redemption's demand and published recourse are lit by design and need
their own disclosure model (Construction §C1.4–C1.5, paper §14). A small pool
still permits inference; wallet explanations must say so.

Supply verification means a stranger can check, for each supported backing at
each witnessed state, that issuance was authorized, transfers conserve value,
spends are unique, and outstanding equals issued minus burned — by replaying
the pool's public statements from genesis under the declared configuration
(§C1.2), against a commitment that binds the order of statements (invariant
23), witnessed at the venue **E** names. Publishing an issuer's totals or an
operator's signatures is insufficient. This checks accepted claims under the
protocol; it does not guarantee an issuer's creditworthiness or delivery of the
external payout.

## Trust and visibility

The release must publish a concrete matrix for its chosen construction,
including collusion and traffic analysis. This is the required baseline:

| Party | Information available | Authority and required limit |
|---|---|---|
| Holder's wallet | Its keys, note openings, own payments and recovery material | Signs only the user's authorized actions; keeps secrets on user-controlled devices or explicitly chosen backups. No operator debit or reset key. |
| Payer and receiver | Agreed backing, amount and the openings for their payment; voluntary counterparty information | Verify the intended payment without receiving unrelated holdings or complete spending histories. |
| Issuer | Public terms and issuance; information needed to perform redemption | May authorize issuance and accept redemption. Cannot move another holder's claims. Ordinary circulation must not reveal ownership history to the issuer. |
| Operator | Public terms, statements, proofs, nullifiers, commitments, timing; metadata explicitly admitted by the threat model | Orders valid transitions and serves evidence. Cannot forge supply, spend claims or cryptographically trace ordinary transfers. Refusal, equivocation and withholding have specified outcomes (Construction §C2b, §C4). |
| Witness | Published commitments and the data required by its declared role | Supplies authenticated order and finality under named assumptions. An operator's private clock cannot establish finality for a receiver. |
| Public verifier or replica | Terms, statements, proofs, nullifiers, commitments and directories | Can check supply and state continuity without spending keys or private ownership history. Public proof and traffic sizes are part of the leakage model. |
| Backup or recovery provider | Only the material needed for its declared role; encrypted private data where used | Cannot silently become custodian. Recovery authority and any disclosures require explicit holder authorization and specification. |

Public issuance, redemption and recourse may disclose amounts, identities or
claim references under the chosen profile. Ordinary-payment privacy does not
erase those disclosures. The release must identify exactly which parties learn
them, including when the issuer, operator and witness collude.

## Essential behavior

- **Wallet:** create and restore keys; display the issuer's signed promise and
  accepted risk; receive a payment request bound to backing, amount, recipient
  and purchase; generate the receiver secret (invariant 25); sign and prove
  locally; persist pending requests before sending; retry safely;
  resynchronize before spending; select and consolidate notes; and durably
  associate fulfillment with one verified payment. Explain pending, final,
  invalid and unavailable evidence separately. A receipt proves acceptance,
  not a current balance.
- **Operator:** validate proofs and canonical statements at admission against
  one committed view (§C1.2); commit durable signing state before exposing
  signatures; serialize competing writers; detect rollback or fence obsolete
  signing instances; hold one commitment in flight (§C2.4.3); and publish
  through a durable outbox when the witness is external. Retries preserve
  command identity and return the same accepted result.
- **Verification and availability:** retrieve public terms, statements,
  proofs, directories and recovery data from independently operated sources;
  verify them locally; authenticate witness order and state continuity. A
  withheld log or proof produces unavailable evidence, never an empty balance,
  valid supply total or proof of omission (§C2.4.2). Define retention,
  checkpoints, bootstrap and resynchronization before pruning.
- **Redemption and recovery:** support demand by `H(nullifier)`, acceptance,
  holder-authorized release and withdrawal (§C3); snapshot redemption, whose
  readers establish unspentness from the spent set they replay rather than
  from a published proof (§C2b.3, C2b.3.3); replacement and takeover (§C2.5–
  C2.7). Exercise operator disappearance, censorship, equivocation, data
  withholding, key compromise and authorized succession. State what can be
  prevented, detected and recovered, and the evidence each remedy needs.
- **Operation:** provide a supported installation, bounded resource use,
  upgrades by successor backing, consistent backups, restore drills and
  diagnostics that do not log wallet secrets or private payment history. No
  account-recovery convenience may introduce a privileged spend path. Loss of
  every key, opening and backup must be explained as unrecoverable.

## Release gates

Every gate needs a named owner, a pinned artifact and reproducible evidence in
the release record. An unmeasured or undecided item fails the gate. Test count
is not evidence.

| Gate | Acceptance evidence | Standing at 2026-09-09 |
|---|---|---|
| Defined profile | Construction pins the pool's statement layouts, hash functions, proof system and what **E** declares; an explicit visibility/collusion model, witness assumptions and supported failure remedies; no unresolved critical protocol choice | v2 layouts, circuits and keys are pinned. Historical silence retirement and receipt consequences are [selected](../decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts), as is the [fault contract](POOL_FAULT_RECOVERY.md). The [delivery contract](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md) is selected and its cryptographic seam probed. F4 selects two-input/four-output spend with ordinary fees. The six proof layouts and [canonical v3 records, snapshots, receipts, segment headers, portable fault evidence and served trails](https://github.com/mediumofexchange/money-from-first-principles/blob/7ea0ee8/pool-v3.md) are fixed and tested outside the runtime; configuration, complete-certificate/replay formats, artifact pins, authenticated interval evidence, wallet integration and deployment choices remain open. V3 adoption is not defined. |
| Adversarial model | An executable model of §C2, §C2b and §C3 over the pool representation, with two operators, two backings, delayed and dropped publications, replacement, restart and incomplete views; safety and conditional progress checked separately; counterexamples kept as regression vectors | Sequencing, authority and recovery models exist. C2b.4.1/3 retirement prevents the reproduced old-segment double spend; a departure preserves the counterexample. The selected [fault model](POOL_FAULT_RECOVERY.md) uses authenticated exclusion, the snapshot clock and last-valid continuation, with exact evidence-chain, receipt and adoption comparisons. Real hashes bind explicit bytes; proof/authentication oracles remain ideal. Production encoding and availability evidence remain open. |
| Private, sound payments | Implemented prover/verifier and an independently reviewed security argument; adversarial cases for forged issuance, inflation, duplicate spends, malformed proofs, wrong contexts and disclosure channels | v2 claim layer in src/pool, pinned circuits and real-proof admission/import/replay checks exist. Focused adversarial review completed; wallet and complete deployment assurance remain. |
| Public supply | A separate verifier checks authorized issuance, conservation, spentness and published supply from public evidence without secret keys; rejects altered, incomplete and wrong-state histories against a witnessed commitment | Public replay and record-derived canonical checkpoint validation exist, including transitive imports and pre-revocation issuance. No complete external-venue supply-verification product yet. |
| Usable payment | A wallet completes issue → pay → receive → fulfill → redeem, including interruption and exact retry; replaying payment evidence cannot fulfill another invoice | The transparent pilot does this for the frozen path across two processes. No pool wallet. |
| Durable operation | Abrupt termination, lost responses, concurrent writers, disk faults, restored backups and obsolete instances cannot cause conflicting exposed signatures or silently lose accepted operations | PoolStore journals openings, admissions, receipts and publication outbox, with restart fencing and crash tests. Coordinated backup rollback, custody procedures and external publication remain open. |
| Available, recoverable state | With the original operator offline, an independent reader retrieves and verifies the promised evidence and executes each supported remedy; selective withholding fails explicitly | Not built for the pool. The frozen path's recovery code is a case library only. |
| Practical deployment | Repeatable measurements of proof creation, verification, resync, startup, storage growth, bandwidth and finality on declared target devices and network conditions, against budgets agreed before testing | Current v2 Node evidence exists. The first [desktop browser baseline](pool-browser-verification.json) verifies nine spends: 4.28–9.30 s proving, 91–195 ms verification, 14,656-byte proofs. Mobile, whole-browser peak memory and wallet resync are unmeasured; venue publication is sized offline only ([probes](POOL_DEPLOYMENT_PROBES.md): a release fits one 6-output transaction). |
| Release assurance | Reproducible builds, installed-package interoperability, pinned dependencies and specification, migration by successor, independent security review and documented disposition of every material finding | Package checks and focused defensive review exist. |

## What carries forward, what is frozen, what is retired

Maintain one production path. The transparent path is **frozen**: no new
features, no review rounds, cases ported to the pool path as each rule lands,
and the code deleted when the pool path passes them. The pilot is a harness for
the durable-command layer; its transport and CLI go with a pool equivalent. The
experiment's circuits and most journal cases have been promoted; it remains
until its receiver and independent-audit cases move to the pool path, as
listed in the [retirement map](PRIVATE_PAYMENT_ARCHITECTURE.md#retained-evidence-and-retirement-conditions).
Two mechanisms in the frozen code are retired by the
specification — whole-served-state exhibits and the signed opening claim
(Construction Appendix) — and are not ported.

Reuse encoding, verification and persistence primitives only where they retain
the same security meaning. Never reinterpret old signatures under new rules or
reuse a signing identity with an emptied history; a change of construction or
version is a successor backing with a swap, which is the protocol's own
migration mechanism.
