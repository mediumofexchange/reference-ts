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

The [deployment probes](POOL_DEPLOYMENT_PROBES.md) hold the device, venue and
recovery measurements behind v3's adopted layouts and the design point.
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
priced choice for deployments that want a lit ledger. The reference builds it
beside the pool as lit notes (`moe/lit/v1`); its earlier account-ledger
implementation is retired.

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
them, including when the issuer, operator and witness collude. For pool-v3 on
Ergo that matrix is [Who sees what](POOL_V3_VISIBILITY.md).

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

## Target scale and budgets

These were declared before testing
([decision](../decisions/2026-09.md#2026-09-29--verify-pool-lifetimes-by-complete-streamed-and-resumed-replay)).
The design point is one scope of a community deployment (paper §20): **10⁶
statements over three years of venue time**, about 900 a day, with peaks of
10⁴ a day. Beyond it costs grow linearly, and no party refuses at a lifetime
ceiling below pool-v3 §14's format bounds. Verification is complete replay,
resumed from state the party replayed itself (pool-v3 §14).

| Party and hardware | Memory | First sync or restore | Steady state | Storage |
|---|---|---|---|---|
| Operator: 4 cores, 8 GiB, SSD | ≤ 1 GiB, independent of history length | Restart resumes from its journal without re-verifying retained history | Admission ≤ 1 s per statement at peak, venue wait excluded | Retains its closure, about 20 GB |
| Independent, supply or backer reader: 8 cores, 16 GiB, 100 Mbit/s | ≤ 1 GiB, independent of history length | ≤ 24 h | ≤ 10 CPU-minutes and ≤ 50 MB transferred a day | Retains the closure it judged, about 20 GB |
| Holder wallet (release command): as the reader | ≤ 1 GiB, independent of history length | ≤ 24 h, seed restore included | As the reader | The closure for its scopes |
| A holder's own recovery evidence | | | | Openings, seed, receipts, own requests and publications, and the last state it was given (C2.7.2). The trail comes from replicas (C2b.3.3) |

The design point's cost, modelled from the [replay](POOL_DEPLOYMENT_PROBES.md#replay-and-retention-cost),
[chain-cost](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor)
and [header](POOL_DEPLOYMENT_PROBES.md#reader-verified-headers) measurements:
- *Bytes:* 15.6 GB of records. Venue ranges from index zero add about 4.2 GB
  of Ergo sections (3.8 GB kept) and 0.17 GB of headers.
- *Compute:* the reader verifies proofs on a pool of verifier instances
  ahead of its replay, so the sequential replay sets the time. The note tree
  is most of the replay's own work; since slice 15 the host hashes through
  Barretenberg's Poseidon2, about five times faster than the JavaScript hash
  the measurements below ran on. The header check takes about 4.5 h once.
- *Result:* a measured first sync of 10⁵ statements with real verification
  load, extrapolated to the design point, takes about 15.5–16 h on a 2-core
  desktop below the declared hardware, or 20.5 h with the header check run
  after it. Its process peaked at 543 MB
  ([first sync](POOL_DEPLOYMENT_PROBES.md#verification-ahead-and-the-first-sync-m5b6)).
  Load can double it. Steady state is about 2.5 CPU-minutes a day, with
  about 33 MB transferred through node JSON and 18 MB kept. The runtime and
  the `moe` commands, measured on the venue to 10⁵ statements, hold the
  budgets and extrapolate within them ([design point](POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3),
  [operator and wallet](POOL_DEPLOYMENT_PROBES.md#the-operator-apart-and-the-wallet-at-depth-m13h)).
  The operator's memory levels off near 600 MB. Slice 15 brought M13h's two
  edges within the budgets ([edges](POOL_DEPLOYMENT_PROBES.md#the-design-points-two-edges-slice-15)):
  admission during the journal's read of its own new checkpoint, and a
  wallet's memory per holding.

A phone wallet is outside the release target, as a scope choice. It
verifies independently only through a reader its holder runs. Its own first
sync would read about 20 GB under complete replay. A succinct history
relation would still leave about 4.4 GB of venue ranges and restoring scans,
and phone rates are unmeasured. A browser wallet is outside it too, as a
scope choice (2026-10-09): the package targets Node, its host hash is
Node-only, and a browser holder would face the phone's sync costs.

## Release gates

Every gate needs a named owner, a pinned artifact and reproducible evidence in
the release record. An unmeasured or undecided item fails the gate. Test count
is not evidence.

| Gate | Acceptance evidence | Standing (Git history dates each change) |
|---|---|---|
| Defined profile | Construction pins the pool's statement layouts, hash functions, proof system and what **E** declares; an explicit visibility/collusion model, witness assumptions and supported failure remedies; no unresolved critical protocol choice | Pool-v2's pinned layouts, circuits and keys are retired to Git history. Historical silence retirement and receipt consequences are [selected](../decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts), as is the [fault contract](POOL_FAULT_RECOVERY.md). The [delivery contract](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md) is selected and its cryptographic seam probed. F4 selects two-input/four-output spend with ordinary fees. The six proof layouts and [canonical v3 records, snapshots, receipts, segment headers, portable fault evidence and served trails](https://github.com/mediumofexchange/money-from-first-principles/blob/7ea0ee8/pool-v3.md) are fixed and tested, with signed terms and portable evidence frames, in `src/pool/v3/`. [Pool-v3 §11.4](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/pool-v3.md#114-the-adopted-configuration) adopts its configuration, and the runtime holds that manifest; it implements the construction with recovery, succession, multi-backing scopes and the wallet, with lifetime evidence bounds decided (§14). The witness venue profile (Ergo) is selected, and its [visibility and collusion matrix](POOL_V3_VISIBILITY.md) is stated, with the wallet and transport duties it finds still open. Deployment choices remain open. |
| Adversarial model | An executable model of §C2, §C2b and §C3 over the pool representation, with two operators, two backings, delayed and dropped publications, replacement, restart and incomplete views; safety and conditional progress checked separately; counterexamples kept as regression vectors | Sequencing, authority and recovery models exist. C2b.4.1/3 retirement prevents the reproduced old-segment double spend; a departure preserves the counterexample. The selected [fault model](POOL_FAULT_RECOVERY.md) uses authenticated exclusion, the snapshot clock and last-valid continuation, with exact evidence-chain, receipt and adoption comparisons. Real hashes bind explicit bytes; proof/authentication oracles remain ideal. Successor byte codecs and bounded real-proof replay of normal multi-backing imports and single-backing recovery now complement the models; complete runtime integration and authenticated availability evidence remain open. |
| Private, sound payments | Implemented prover/verifier and an independently reviewed security argument; adversarial cases for forged issuance, inflation, duplicate spends, malformed proofs, wrong contexts and disclosure channels | The guarded v3 runtime has six adopted proof relations whose integer and boolean inputs are range-checked in the compiled circuits and refuse type-escape witnesses, a runtime prover and shared ordinary/recovery transitions with focused adversarial review and real-proof acceptance. No written security argument exists yet: the release's claims, the assumptions each rests on and why the checks imply them (WORK.md slice 19). Complete deployment assurance remains. |
| Public supply | A separate verifier checks authorized issuance, conservation, spentness and published supply from public evidence without secret keys; rejects altered, incomplete and wrong-state histories against a witnessed commitment | Public replay and canonical checkpoint validation include transitive imports and pre-revocation issuance. The guarded v3 reader verifies supply from public packages and independently retrieved Ergo headers/sections on reference venues; [implementation status](IMPLEMENTATION_STATUS.md#successor-record-conformance) separates current local/synthetic evidence from historical live testnet observations. A supported supply-verification product remains open. |
| Usable payment | A wallet completes issue → pay → receive → fulfill → redeem, including interruption and exact retry; replaying payment evidence cannot fulfill another invoice | The [v3 wallet](POOL_V3_WALLET.md) requests, pays, re-proves and fulfills once from public evidence, with fresh-process crash drills across its commit boundaries, and exchanges requests as digest-authenticated frames with no receiver endpoint; it restores from its seed or from an encrypted handoff that freezes its source. V3 runtime redemption has candidate acceptance. Qualified device custody and a qualified human authentication channel remain open. Cancellation (release with other outputs) and statements spending several backings lie outside the smallest profile; the wallet pays one backing in any scope. |
| Durable operation | Abrupt termination, lost responses, concurrent writers, disk faults, restored backups and obsolete instances cannot cause conflicting exposed signatures or silently lose accepted operations | The v3 journal persists openings, ordinary/recovery admission, original receipts, witnessed return/adoption and the publication outbox under one owner, with restart fencing and a separate-process crash drill; its [loopback service](POOL_V3_SERVICE.md) demonstrates exact retries after lost replies, old-process fencing and restart. Ergo publication supports kinds 1–4 with historical live testnet acceptance, with optional [durable venue and journal-owned publisher state](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher) preserving exact retries in synthetic process-crash checks. An operator directory restored from a copy signs only a return at a skipped sequence once silence is witnessed (M13d), and a wallet's records its restoration before acting: it refuses requests its lost instance may have credited and, for lit, exposes its whole window (M13e, [wallet](POOL_V3_WALLET.md#restoring-a-copy-of-the-directory)); copied replay files are read again and copied views audited. A wallet that reads public evidence of another instance of its seed acting (a held note spent by a statement it never saved, or a lit key paid above its exposure) refuses to act (`FORKED`) until a restoration is recorded, a lit payment refuses a request its seed already paid, and a settlement's `rho_out` reads its acceptance, so a restored wallet settles to no output a lost release disclosed (M13f, [wallet](POOL_V3_WALLET.md#when-another-instance-of-the-seed-acts)); detection follows the venue, so a lost instance's statement still in flight and a note another instance received and spent between two reads are not prevented. A `serve` restarted after an abrupt stop at 1.25·10⁴ statements held its first read about 5 minutes on the PC, long enough for a short silence window to lapse its scope (WORK.md Next 4 (bb), cause to confirm). Full-history memory/checkpoint costs, physical storage qualification, custody procedures and mainnet publication remain open. |
| Available, recoverable state | With the original operator offline, an independent reader retrieves and verifies the promised evidence and executes each supported remedy; selective withholding fails explicitly | The guarded single-backing runtime verifies publication force, exact return/adoption, receipts and non-service counts with real proofs on [local](pool-v3-recovery-store-verification.json) and [synthetic Ergo](pool-v3-recovery-store-ergo-verification.json) reference venues. [Historical live testnet recovery at a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json) includes independent public-bundle readback and authenticated venue retrieval. Complete bounded ancestry is required; missing evidence refuses a verdict. Succession and multi-backing scopes have local and synthetic Ergo real-proof acceptance ([succession](pool-v3-succession-store-ergo-verification.json), [scope](pool-v3-scope-store-ergo-verification.json)), and the two-backing scope drill passed [live on the testnet](https://github.com/mediumofexchange/reference-ts/blob/8ca96cd/docs/pool-v3-scope-store-testnet-verification.json) under the adopted configuration. Readers, wallets and the journal keep evidence and replay state in their own storage, and a [real-proof history past the old one-package ceiling](pool-v3-history-store-verification.json) passes through journal, wallet sync and an offline-operator recovery read from kept files; the target scale has stand-in-proof measurements only. A [replica](POOL_V3_WALLET.md#replicas) (`moe reader serve`) serves kept, verified evidence with no credential, and the lit command drill syncs a holder and reads a fresh reader's supply from it alone with the operator stopped; durable storage qualification remains open. |
| Practical deployment | Repeatable measurements of proof creation, verification, resync, startup, storage growth, bandwidth and finality on declared target devices and network conditions, against budgets agreed before testing | Node proving and verification timings exist for v2 and the six v3 relations. The first [desktop browser baseline](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/pool-browser-verification.json) verifies nine spends: 4.28–9.30 s proving, 91–195 ms verification, 14,656-byte proofs. [Target-scale budgets](#target-scale-and-budgets) are declared, and the `moe` commands and the runtime [hold them to 10⁵ statements](POOL_DEPLOYMENT_PROBES.md#the-operator-apart-and-the-wallet-at-depth-m13h), the operator's memory included, M13h's two edges brought within them by [slice 15](POOL_DEPLOYMENT_PROBES.md#the-design-points-two-edges-slice-15); 10⁶ itself is unmeasured; a phone wallet and a browser target lie outside the release target. On Ergo, testnet publication and reassembly were [accepted on a node](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node), with mainnet [inclusion latency](POOL_DEPLOYMENT_PROBES.md#inclusion-latency-on-the-mainnet), [chain cost](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor) and [replay cost](POOL_DEPLOYMENT_PROBES.md#replay-and-retention-cost) measured. The [Ergo profile](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md) is selected with a runtime default depth of 10, and its reader needs no decoder. |
| Release assurance | Reproducible builds, installed-package interoperability, pinned dependencies and specification, migration by successor, independent security review and documented disposition of every material finding | A [release record](RELEASE.md) rebuilds the package tarball byte-identically on Linux and Windows in CI and installs it from an install lock that pins every runtime dependency by integrity to the tested tree. Both command drills run every party (operator, replica, relays, wallets, reader) from its own install of that release, on one host ([separate installs](RELEASE.md#separate-installs)). The command drills restore an operator, a wallet, a reader and a relay from backups of their directories, and `moe venue audit` re-checks any role's view. Every review finding open before slice 13 is fixed or dispositioned with its reopening trigger, and the [10⁵ rerun](POOL_DEPLOYMENT_PROBES.md#the-operator-apart-and-the-wallet-at-depth-m13h) is recorded. The external security review remains. |

## What carries forward and what is retired

Maintain one production path. The transparent path and its pilot are retired
against a [case map](../decisions/2026-10.md#2026-10-03--retire-the-pilot-and-the-transparent-path-against-a-case-map-of-their-checks-slice-10-m10e1)
of their checks, remaining at [8d207eb](https://github.com/mediumofexchange/reference-ts/tree/8d207eb);
the `moe` commands took over the pilot's integration role. Its cases for rules
the smallest profile leaves out (reliance, payout in claims, cross-operator
presentation) are recovered from there when a later version takes them up.
Two mechanisms it carried are retired by the specification — whole-served-state
exhibits and the signed opening claim (Construction Appendix) — and are never
ported. The private-payment experiment is retired following the active case map in
the [retirement map](PRIVATE_PAYMENT_ARCHITECTURE.md#retained-evidence-and-retirement-conditions).

Reuse encoding, verification and persistence primitives only where they retain
the same security meaning. Never reinterpret old signatures under new rules or
reuse a signing identity with an emptied history; a change of construction or
version is a successor backing with a swap, which is the protocol's own
migration mechanism.
