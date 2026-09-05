# Production requirements

Status: release contract draft, 2026-09-05. This document defines the intended
product and its acceptance evidence. It does not amend the normative protocol
or select a cryptographic construction. Protocol choices must land in
Construction first, with the implementation tracking a pinned revision.

## Release contract

Deliver one usable payment product in which ordinary people can hold, send,
receive, verify and redeem claims under public immutable terms. **Private
payments and publicly verifiable supply are both essential.** A release that
omits either does not satisfy this contract.

Start with the smallest useful supported profile: signed roots with a constant
payout, private transfers, public supply evidence and a complete failure path.
More payout forms, reliance graphs and optional constructions may wait. The
wallet and operator must use the same declared profile, proof rules, witness
finality and version. Users should not have to assemble several experimental
products to make one payment.

Privacy means cryptographic protection of ordinary ownership and transfer
history from other holders, the operator and public observers. Network traffic,
issuance, redemption and published recourse need a separate disclosure model.
Amount hiding versus denomination leakage must be explicitly decided in that
model before selecting the construction; neither the word “shielded” nor
encrypted transport settles this requirement. A small participant set may
still permit inference. Marketing and wallet explanations must respect that
limit.

Supply verification means a stranger can check, for each supported backing at
each witnessed state, that issuance was authorized, transfers conserve value,
spends are unique, and outstanding equals issued minus burned. Publishing only
an issuer's totals or an operator's signatures is insufficient. Public evidence
must bind the issued claims, state transitions and spent set, including hidden
amount range constraints where applicable. This checks accepted claims under
the protocol; it does not guarantee an issuer's creditworthiness or delivery of
the external payout. Redemption returns claims to the issuer; burn reduces
outstanding.

These requirements follow Construction's [invariants](https://github.com/mediumofexchange/money-from-first-principles/blob/c3f4b0f/construction.md#c0-invariants),
[claim layer](https://github.com/mediumofexchange/money-from-first-principles/blob/c3f4b0f/construction.md#c1-claims-and-wallets)
and [failure model](https://github.com/mediumofexchange/money-from-first-principles/blob/c3f4b0f/construction.md#c4-threat-model).
The paper's [privacy discussion](https://github.com/mediumofexchange/money-from-first-principles/blob/c3f4b0f/money-from-first-principles.md#14-privacy-and-disclosure)
identifies the boundary and metadata disclosures that a construction must address.

## Trust and visibility

The release must publish a concrete matrix for its chosen construction,
including collusion and traffic analysis. This is the required baseline:

| Party | Information available | Authority and required limit |
|---|---|---|
| Holder's wallet | Its keys, claims, own payments and recovery material | Signs only the user's authorized actions; keeps secrets on user-controlled devices or explicitly chosen backups. No operator debit or reset key. |
| Payer and receiver | Agreed backing, amount and evidence for their payment; voluntary counterparty information | Verify the intended payment without receiving unrelated holdings or complete spending histories. Counterparties can disclose their own interactions. |
| Issuer | Public terms and issuance; information needed to perform redemption | May authorize issuance and accept redemption. Cannot move another holder's claims. Ordinary circulation must not reveal ownership history to the issuer. |
| Operator | Public terms, proofs and ordering requests; metadata explicitly admitted by the threat model | Orders valid transitions and serves evidence. Cannot forge supply, spend claims or cryptographically trace ordinary transfers. Refusal, equivocation and withholding have specified outcomes. |
| Witness | Published commitments and the data required by its declared witnessing role | Supplies authenticated order and finality under named assumptions. An operator's private clock cannot establish finality for a receiver. |
| Public verifier or replica | Terms, authorized issuance/burn evidence, commitments, nullifiers and conservation evidence required by the construction | Can check supply and state continuity without spending keys or private ownership history. Public proof and traffic sizes are part of the leakage model. |
| Backup or recovery provider | Only the material needed for its declared role; encrypted private data where used | Cannot silently become custodian. Recovery authority and any disclosures require explicit holder authorization and specification. |

Public issuance, redemption and recourse may disclose amounts, identities or
claim references under the chosen profile. Ordinary-payment privacy does not
erase those disclosures. The release must identify exactly which parties learn
them, including when the issuer, operator and witness collude.

## Essential behavior

- **Wallet:** create and restore keys; display the issuer's signed promise and
  accepted risk; receive a payment request bound to backing, amount, recipient
  and purchase; sign locally; persist pending requests before sending; retry
  safely; resynchronize before spending; and durably associate fulfillment
  with one verified payment. Explain pending, final, invalid and unavailable
  evidence separately. A receipt proves acceptance, not a current balance.
- **Operator:** validate proofs and canonical messages at admission; commit
  durable signing state before exposing signatures; serialize competing
  writers; detect rollback or fence obsolete signing instances; and publish
  through a durable outbox when the witness is external. Retries preserve
  command identity and return the same accepted result.
- **Verification and availability:** retrieve public terms, proofs and recovery
  data from independently operated sources; verify them locally; authenticate
  witness order and state continuity. A digest is an integrity check, not a
  retrieval guarantee. A withheld log or proof produces unavailable evidence,
  never an empty balance, valid supply total or proof of omission. Define
  retention, checkpoints, bootstrap and resynchronization before pruning.
- **Redemption and recovery:** support demand, acceptance, holder-authorized
  release and the specified withdrawal path. Preserve privacy where the
  protocol permits it and explain recourse disclosures before publication.
  Exercise operator disappearance, censorship, equivocation, data withholding,
  key compromise and authorized succession under the chosen threat model.
  State what can be prevented, detected and recovered, and the evidence each
  remedy needs. Evidence of dishonour cannot manufacture the external payout.
- **Operation:** provide a supported installation, bounded resource use,
  upgrades, consistent backups, restore drills and diagnostics that do not log
  wallet secrets or private payment history. No account-recovery convenience
  may introduce a privileged spend path. Loss of every key and backup must be
  explained as unrecoverable where that is the construction's limit.

## Release gates

Every gate needs a named owner, a pinned artifact and reproducible evidence in
the release record. An unmeasured or undecided item fails the gate. The current
test count is not a substitute for this evidence.

| Gate | Acceptance evidence | Current gap |
|---|---|---|
| Defined profile | One normative transition specification and encoding version; explicit visibility/collusion model, witness assumptions and supported failure remedies; no unresolved critical protocol choice | A private research candidate exists; a conforming private evidence declaration and production trust model remain unselected. |
| Private, sound payments | Implemented prover/verifier and an independently reviewed security argument; adversarial cases for forged issuance, inflation, duplicate spends, malformed proofs, wrong contexts and disclosure channels | The bounded real-proof run, ordered-history checkpoint fix and valid-fork regression pass. The production claim layer and privacy argument remain unfulfilled. |
| Public supply | A separate verifier checks authorized issuance, conservation, spentness and published supply from public evidence without secret keys; rejects altered, incomplete and wrong-state proofs against an authenticated history | Public replay and rejection of valid prefixes/alternate spent histories pass against caller-pinned checkpoints. Completeness, freshness and independent finality remain unproved. |
| Usable payment | Supported wallet devices complete issue → pay → receive → fulfill → redeem, including interruption and exact retry; replaying payment evidence cannot fulfill another invoice | CLI scenarios and a durable receiver accept-once experiment exist; production wallet, invoice lifecycle and private redemption workflow are absent. |
| Durable operation | Abrupt termination, lost responses, concurrent writers, disk faults, restored backups and obsolete instances cannot cause conflicting exposed signatures or silently lose accepted operations | Local transactional crash tests exist; rollback protection, remote publication and production restore behavior are unfulfilled. |
| Available, recoverable state | With the original operator offline, an independent reader retrieves and verifies the promised evidence and executes each supported remedy; selective withholding fails explicitly | Pilot depends on its cohosted witness and journal; production replication and hostile-operator recovery are absent. |
| Practical deployment | Repeatable measurements of proof creation, verification, resync, startup, storage growth, bandwidth and finality on declared target devices and network conditions; results meet workload and resource budgets agreed before testing | The final Node 24 desktop run is measured, including the checkpoint regression and fresh setup. Production workload/device budgets and mobile/browser suitability remain unestablished. |
| Release assurance | Reproducible builds, installed-package interoperability, pinned dependencies/specification, migration/rollback plan, independent security review and documented disposition of every material finding | Package checks and focused defensive review exist; production protocol implementation and release review remain outstanding. |

## Test harness and consolidation

The [private-payment experiment](../experiments/private-payment) has demonstrated
actual proofs, public replay and durable acceptance in a fixed 256-leaf pool.
Its ordered-history checkpoint fix and valid-fork regression also pass in the
[recorded final run](../experiments/private-payment/results/2026-09-05-windows.json).
Its signed transparent backing identifiers are research asset/obligor mappings;
they are not conforming declarations of private **E**. A private transfer to
the issuer preserves supply, and a subsequent burn reduces it. Neither act
alone implements demand, acceptance, holder release or external performance.
Replaying a valid prefix proves that prefix only: a withheld suffix can hide a
later spend or burn. Current unspentness, fresh supply and independent finality
remain unavailable from that evidence alone.

A note-tree root and count alone also fail to identify the spent set: valid
histories can consume different equal-valued notes and append identical outputs.
Research responses now include `historyHash`, chaining the previous history,
configuration-bound statement digest, resulting root and count. The independent
audit requires a separately supplied expected root, count and history hash.
This distinguishes the caller's expected branch; it still needs an authenticated,
fresh checkpoint source to support production finality.

The [durable local pilot](PILOT.md) is a test harness for command persistence,
replay, transport boundaries and client behavior. Its transparent balances,
cohosted trusted witness, one-root restriction and bounded journal do not meet
the production contract. Passing it is useful evidence for those mechanisms,
not a private-payment or hostile-operator recovery release.

Maintain one production path and one clearly separated deterministic harness.
Reuse encoding, verification and persistence primitives only where they retain
the same security meaning. Experimental adapters must identify the production
component or test purpose they support; they must not become permanent parallel
wallets, ledgers or onboarding flows merely because they already exist.

When a component is replaced, migrate its useful adversarial cases to the
supported path, record the replacement and remove obsolete public entry points,
configuration and instructions together. Preserve readable history and test
vectors. Any live-value migration requires an explicit protocol and evidence
that authorization, supply and finality survive it; never silently reinterpret
old signatures or reuse a signing identity with an emptied history. Retire
unused experiments once their evidence has been captured rather than extending
them to keep every prototype runnable.

Concretely, promotion should move reviewed note/proof rules into the one
supported verifier and admission path, retain the experiment's inflation,
double-spend, replay and crash cases against that path, and retire its standalone
host and receiver APIs. The transparent pilot can remain a differential-test
oracle and local fixture while useful. Its CLI, credentials and alternate
onboarding must not become a fallback that silently disables product privacy.
