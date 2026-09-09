# Wallet direction and non-circulating promises

Discussion draft, 2026-09-07. This records the product direction
and a proposed minimum for evaluation. It does not change Construction, approve a
new claim layer, or describe an implemented wallet.

## Product direction

One mobile wallet holds native cryptocurrencies (BTC, ERG and the
Ergo stablecoin USE), circulating protocol claims, and promises made to a
fixed creditor. Asset support is a requirement here, not a verified integration.

The user accepts or declines incoming offers, pays or sends, requests payment,
issues a promise, asks for evidence, and verifies it. Policies and manual
acceptance determine the portfolio. The wallet also shows what the user has
promised to others. Technical mechanisms stay behind ordinary actions, with
consequences and unresolved evidence visible where they affect a decision.

The paper already describes acceptance and pricing policies in
[§15](https://github.com/mediumofexchange/money-from-first-principles/blob/da80f85/money-from-first-principles.md#15-valuation)
and one balance in a chosen unit in
[§20](https://github.com/mediumofexchange/money-from-first-principles/blob/da80f85/money-from-first-principles.md#20-in-practice).
The production wallet's existing verification and persistence requirements
remain in [Production requirements](PRODUCTION_REQUIREMENTS.md#essential-behavior).

## Proposed minimum for a non-circulating promise

A backer signs an immutable promise identifying a unique promise ID, the
creditor's verification key, the quantity and unit, and the exact payout and
conditions. An address or contact is a UI representation; the signed recipient
identity must have a specified verification method. Both parties retain the
signed object. Multiple promises to the same creditor remain distinct.

The backer's signature proves that the backer made those terms to that key.
The creditor proves control of the key with a fresh, context-bound signature.
Neither proves that delivery occurred or that the creditor accepted: those
facts need the creditor's signed acknowledgement if the protocol requires them.
A proof request must not authorize a payment, release or new promise.

With one fixed creditor and no transfer operation, there is no changing holder
for a shared sequencer to order. The backer still needs a durable journal of
issuance and settlement, replay-safe requests and serialized processing of
concurrent redemptions. The creditor keeps settlement evidence and the
remaining amount. Restoring an old backup must not permit duplicate payment
or silently revive a discharged promise.

A signed promise is not by itself proof that it remains unpaid. A settlement
needs evidence linked to that promise: for example an agreed creditor receipt,
or an externally verifiable payment under explicitly agreed settlement rules.
A backer's unilateral "paid" flag is insufficient evidence for another reader.
Goods and services require an agreed acknowledgement or dispute treatment.

This proposal gives up transfer to other holders. Copying the document cannot
change the creditor, but software cannot prevent someone sharing their secret
key. Transfer, creditor replacement and key recovery therefore need explicit
semantics before they are offered. A bilateral journal also does not establish
the backer's total liabilities or solvency. Public evidence of timing, default
or aggregate supply would require additional mechanisms with their own costs.

Construction currently defines circulating bearer claims in
[§C1](https://github.com/mediumofexchange/money-from-first-principles/blob/da80f85/construction.md#c1-claims-and-wallets).
Treat this as a proposed additional instrument supported by the wallet while
deciding whether it belongs in Extensions or changes the core. It cannot obtain
the pool's guarantees just by dropping the sequencer fields from E.

## One balance and ordinary actions

Use one prominent estimated portfolio value in the user's chosen unit. Keep
native quantities, the value source and its freshness in the detail view.
Allow a personal value or a configured lookup source where no price is
available. Mark personal estimates and stale values; an unknown value remains
unpriced, with a visible count alongside the valued subtotal. Entering a price
does not turn invalid or unavailable evidence into a verified holding.

Keep "I owe" visible as obligations, separate from owned holdings. Creating a
promise must never increase the issuer's owned balance. Any net-position view
must account for obligations explicitly. The headline estimate does not promise
that the whole portfolio can fund a particular payment.

Pay uses only holdings that can move and satisfy the recipient's request and
acceptance policy. A fixed-creditor promise offers "Request settlement";
its creditor cannot send it to a shop. Redeeming it and then paying with the
proceeds is a separate sequence whose completion must be verified.

Show a short payment preview with the recipient, amount, assets given, fees,
and any conversion. Explain pending, final and unavailable outcomes in plain
language. Do not imply one atomic payment across unrelated chains without a
specified mechanism. Acceptance policies can check issuer exposure, asset
identity, evidence, value freshness and user-set limits before automatic
acceptance; exceptions remain reviewable. Declining an offer must not silently
sign a release of an existing claim.

## Choices before specification or implementation

- Does issuance bind immediately, or does creditor acceptance activate it?
  What exactly does declining an offer do to an already signed promise?
- What proves full or partial settlement, and how are disputes represented?
- What recovery is possible after creditor-key loss without adding a backer
  power to replace the creditor unilaterally?
- Is private bilateral evidence sufficient, or must strangers verify timing,
  outstanding status or total issuance? Each stronger property has a cost.
- Where does the instrument belong relative to the existing core, and which
  existing invariants apply or need an explicitly priced exception?

Resolve these as a specification proposal before changing signed bytes or
state transitions. The existing shielded-pool work can continue independently.
