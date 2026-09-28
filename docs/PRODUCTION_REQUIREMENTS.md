# Production requirements

Status: release contract, revised 2026-09-05; estimate method clarified 2026-09-12. This document defines what a
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
The [Windows wallet custody boundary](https://github.com/mediumofexchange/reference-ts/blob/a020215/docs/POOL_WALLET_DEVICE.md)
selected for the retired v2 wallet defined a read-only storage preflight and
target failure drills; it closed neither device qualification nor continuous
recovery, which remain separate gates.

## Progress estimate

The target is the smallest supported profile below as a usable end-to-end
product: a holder can install a wallet, receive, verify, pay and redeem; an
operator can run it durably; independent readers can verify supply and execute
the declared failure paths with the original operator offline. One supported
witness must actually accept publications. A mock, ideal model or offline
transaction size does not establish these outcomes. Release gates still apply.

The current estimate lives only in [WORK.md](../WORK.md#open-questions); this
section defines how it is made. It is a judgment of engineering effort toward
that target, not a measured fraction of features, code or tests and not a
delivery-date prediction. Reviewed recovery/fault models and experiments reduce
design uncertainty but are not runtime recovery.

The percentage is a coarse engineering judgment, not an automatic score from
the release-gate table. Conceptually it compares reusable completed engineering
effort with that effort plus the work still expected to satisfy the acceptance
scope. There is no measured hours ledger or fixed set of numerical weights
that calculates the current percentage. An exact-looking calculation would
overstate the available evidence. The gate table is an evidence checklist:
partially implemented gates can represent substantial completed work, while
one unresolved dependency can prevent every usable product path.

After meaningful product progress or a consequential new blocker, make a brief
qualitative reassessment from evidence already gathered for that work. Do not
run extra research, tests, inventories or delegation solely to update a number
unless explicitly asked for a progress audit. Use coarse rounded values (about
five or ten percentage points) with a broad uncertainty range. Credit reusable
implementation and resolved uncertainty even while their release gates remain
open; a gate is not an all-or-nothing unit of engineering effort. Avoid counting
models and their later implementation twice. Allow for integration/redesign and
move the estimate backward when new evidence warrants it. Never infer it from
files, commits, test totals or the fraction of gates passed, or raise it just to
make progress visible.

Keep the current estimate, last reassessment and a short reason in `WORK.md`.
Include it and the main blockers in reports when materially changed or requested;
omit unchanged percentages for routine fixes, documentation and tooling. Those
tasks do not by themselves advance the product estimate. An unchanged number
means no material reassessment, not a fresh confirmation of its accuracy.

Most remaining effort is successor recovery/evidence integration, continuous
wallet restoration, external witness publication and deployment/security
assurance. The configured local wallet already demonstrates private payment,
verified note selection, authenticated delivery and planned offline handoff;
those are reusable product progress despite the remaining device/venue gates.

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

| Gate | Acceptance evidence | Standing (Git history dates each change) |
|---|---|---|
| Defined profile | Construction pins the pool's statement layouts, hash functions, proof system and what **E** declares; an explicit visibility/collusion model, witness assumptions and supported failure remedies; no unresolved critical protocol choice | Pool-v2's pinned layouts, circuits and keys are retired to Git history. Historical silence retirement and receipt consequences are [selected](../decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts), as is the [fault contract](POOL_FAULT_RECOVERY.md). The [delivery contract](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md) is selected and its cryptographic seam probed. F4 selects two-input/four-output spend with ordinary fees. The six proof layouts and [canonical v3 records, snapshots, receipts, segment headers, portable fault evidence and served trails](https://github.com/mediumofexchange/money-from-first-principles/blob/7ea0ee8/pool-v3.md) are fixed and tested, with candidate configuration, signed terms and portable evidence frames, as unadopted candidate code in `src/pool/v3/`. Configuration approval, complete certificates, multi-backing successor recovery, authenticated interval evidence, wallet integration and deployment choices remain open. The witness venue profile (Ergo) is selected. V3 adoption is not defined. |
| Adversarial model | An executable model of §C2, §C2b and §C3 over the pool representation, with two operators, two backings, delayed and dropped publications, replacement, restart and incomplete views; safety and conditional progress checked separately; counterexamples kept as regression vectors | Sequencing, authority and recovery models exist. C2b.4.1/3 retirement prevents the reproduced old-segment double spend; a departure preserves the counterexample. The selected [fault model](POOL_FAULT_RECOVERY.md) uses authenticated exclusion, the snapshot clock and last-valid continuation, with exact evidence-chain, receipt and adoption comparisons. Real hashes bind explicit bytes; proof/authentication oracles remain ideal. Successor byte codecs and bounded real-proof replay of normal multi-backing imports and single-backing recovery now complement the models; complete runtime integration and authenticated availability evidence remain open. |
| Private, sound payments | Implemented prover/verifier and an independently reviewed security argument; adversarial cases for forged issuance, inflation, duplicate spends, malformed proofs, wrong contexts and disclosure channels | The guarded v3 candidate has six proof relations whose integer and boolean inputs are range-checked in the compiled circuits and refuse type-escape witnesses, a runtime prover and shared ordinary/recovery transitions with focused adversarial review and real-proof acceptance. Configuration adoption and complete deployment assurance remain. |
| Public supply | A separate verifier checks authorized issuance, conservation, spentness and published supply from public evidence without secret keys; rejects altered, incomplete and wrong-state histories against a witnessed commitment | Public replay and canonical checkpoint validation include transitive imports and pre-revocation issuance. The guarded v3 reader verifies supply from public packages and independently retrieved Ergo headers/sections on reference venues; [implementation status](IMPLEMENTATION_STATUS.md#successor-record-conformance) separates current local/synthetic evidence from historical live testnet observations. An adopted configuration and a supported supply-verification product remain open. |
| Usable payment | A wallet completes issue → pay → receive → fulfill → redeem, including interruption and exact retry; replaying payment evidence cannot fulfill another invoice | The [v3 wallet](POOL_V3_WALLET.md) requests, pays, re-proves and fulfills once from public evidence, with fresh-process crash drills across its commit boundaries, and exchanges requests as digest-authenticated frames with no receiver endpoint; it restores from its seed or from an encrypted handoff that freezes its source. V3 runtime redemption has candidate acceptance. Qualified device custody, a qualified human authentication channel, cancellation and multi-backing payment remain open. |
| Durable operation | Abrupt termination, lost responses, concurrent writers, disk faults, restored backups and obsolete instances cannot cause conflicting exposed signatures or silently lose accepted operations | The v3 candidate journal persists openings, ordinary/recovery admission, original receipts, witnessed return/adoption and the publication outbox under one owner, with restart fencing and a separate-process crash drill; its [loopback service](POOL_V3_SERVICE.md) demonstrates exact retries after lost replies, old-process fencing and restart. Ergo publication supports kinds 1–4 with historical live testnet acceptance, with optional [durable venue and journal-owned publisher state](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher) preserving exact retries in synthetic process-crash checks. Full-history memory/checkpoint costs, coordinated backup rollback, physical storage qualification, custody procedures and mainnet publication remain open. |
| Available, recoverable state | With the original operator offline, an independent reader retrieves and verifies the promised evidence and executes each supported remedy; selective withholding fails explicitly | The guarded single-backing runtime verifies publication force, exact return/adoption, receipts and non-service counts with real proofs on [local](pool-v3-recovery-store-verification.json) and [synthetic Ergo](pool-v3-recovery-store-ergo-verification.json) reference venues. [Historical live testnet recovery at a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json) includes independent public-bundle readback and authenticated venue retrieval. Complete bounded ancestry is required; missing evidence refuses a verdict. Replacement service, multi-backing recovery, durable evidence availability, wallet recovery and an adopted configuration remain open. |
| Practical deployment | Repeatable measurements of proof creation, verification, resync, startup, storage growth, bandwidth and finality on declared target devices and network conditions, against budgets agreed before testing | Node proving and verification timings exist for v2 and the six v3 relations. The first [desktop browser baseline](pool-browser-verification.json) verifies nine spends: 4.28–9.30 s proving, 91–195 ms verification, 14,656-byte proofs. Mobile, whole-browser peak memory and wallet resync are unmeasured. On Ergo, testnet publication and reassembly were [accepted on a node](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node), with mainnet [inclusion latency](POOL_DEPLOYMENT_PROBES.md#inclusion-latency-on-the-mainnet), [chain cost](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor) and [replay cost](POOL_DEPLOYMENT_PROBES.md#replay-and-retention-cost) measured. The [Ergo profile](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md) is selected with a runtime default depth of 10, and its reader needs no decoder. |
| Release assurance | Reproducible builds, installed-package interoperability, pinned dependencies and specification, migration by successor, independent security review and documented disposition of every material finding | Package checks and focused defensive review exist. |

## What carries forward, what is frozen, what is retired

Maintain one production path. The transparent path is **frozen**: no new
features, no review rounds, cases ported to the pool path as each rule lands,
and the code deleted when the pool path passes them. The pilot is a harness for
the durable-command layer; its transport and CLI go with a pool equivalent. The
private-payment experiment is retired following the active case map in
the [retirement map](PRIVATE_PAYMENT_ARCHITECTURE.md#retained-evidence-and-retirement-conditions).
Two mechanisms in the frozen code are retired by the
specification — whole-served-state exhibits and the signed opening claim
(Construction Appendix) — and are not ported.

Reuse encoding, verification and persistence primitives only where they retain
the same security meaning. Never reinterpret old signatures under new rules or
reuse a signing identity with an emptied history; a change of construction or
version is a successor backing with a swap, which is the protocol's own
migration mechanism.
