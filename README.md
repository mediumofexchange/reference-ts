# Medium of Exchange — TypeScript reference

An experimental implementation of the **[Medium of Exchange Protocol](https://github.com/mediumofexchange/money-from-first-principles)**,
for issuing and exchanging claims against publicly defined promises. The design
aims to keep payments private while allowing anyone to verify supply.

A backing defines who owes, what a unit pays, what must accompany redemption,
and how unspent claims are verified. The protocol requires authorization for
increased obligations and for moving a holder's claims.

## Status

The active development path is a **shielded pool**: private notes with public
verification of issuance and conservation. The guarded v3 runtime, under
pool-v3's adopted configuration, supports issue, payment, burn and
single-backing recovery on local and synthetic reference venues, with
historical live testnet acceptance; succession and bounded venue/publisher
process persistence run on reference venues. The guard refuses mainnet until
the runtime is released. A [v3 wallet](docs/POOL_V3_WALLET.md) persists exact
requests and independently verified final fulfillment, and pays exact requests
from holdings it restores from public evidence with reserved exact statements.
A [v3 loopback service](docs/POOL_V3_SERVICE.md) transports journal operations
and public evidence for independent replay, and an Ergo adapter reads and
publishes venue records under the selected profile. The
[`moe` commands](docs/POOL_V3_WALLET.md#commands) run the wallet, operator,
supply reader and relay from an installed package, with real proofs on a
synthetic chain and live on the Ergo testnet. Qualified deployment storage,
statements spending several backings and a phone-first wallet remain open. The API and
wire format are experimental, the package is not published to npm, and no
completed security audit or live deployment is claimed. The earlier pool-v2
runtime is retired and remains in Git history.

The runtime tracks specification revision
[`e7f7f246a5a57741b9ceeaaa9efef67a7b0bccad`](https://github.com/mediumofexchange/money-from-first-principles/tree/e7f7f246a5a57741b9ceeaaa9efef67a7b0bccad).
See [implementation status](docs/IMPLEMENTATION_STATUS.md) for component
evidence and the pins of individual rules, and [production requirements](docs/PRODUCTION_REQUIREMENTS.md)
for the remaining acceptance criteria.

## Build and verify

Use Node.js 24 for all components. The core supports Node.js 20 or newer;
durable storage and process harnesses require Node.js 24.

```sh
git clone https://github.com/mediumofexchange/reference-ts.git
cd reference-ts
npm ci
npm run check
```

This checks documentation, types, tests, the built package and applicable
process/crash scenarios. Real-proof checks run separately:

```sh
npm run check:pool:v3    # six relations against the manifest, real proofs and store acceptance
```

This is a developer verification command; the repository does not yet provide
an end-user payment application. See the [v3 conformance guide](scripts/pool/v3/README.md)
for proof setup and limits.

## Explore the implementation

| Start here | What it explains |
|---|---|
| [Architecture](docs/PRIVATE_PAYMENT_ARCHITECTURE.md) | Active components, models, and retirement conditions for retained experiments. |
| [Protocol rules](docs/PROTOCOL_RULES.md) | Specification rules mapped to code and tests. |
| [Root terms](src/pool/v3/terms.ts) | Canonical v3 terms and the hash that names a backing. |
| [Shielded pool](src/pool/) | Private notes, verification, history and durable operation. |
| [Who sees what](docs/POOL_V3_VISIBILITY.md) | What pool-v3 on Ergo discloses to each party, coalition and traffic observer. |
| [Decisions](DECISIONS.md) | Dated choices, rationale, evidence and specification changes. |

The transparent path and its local pilot are retired against a
[case map](decisions/2026-10.md#2026-10-03--retire-the-pilot-and-the-transparent-path-against-a-case-map-of-their-checks-slice-10-m10e1)
and remain at [8d207eb](https://github.com/mediumofexchange/reference-ts/tree/8d207eb).
The private-payment research framework has been retired too; its active
equivalents and historical results are mapped in the
[retirement map](docs/PRIVATE_PAYMENT_ARCHITECTURE.md#retained-evidence-and-retirement-conditions).

## Contributing

Read [AGENTS.md](AGENTS.md) for engineering and review rules and
[WORK.md](WORK.md) for the current task. Resolve specification changes before
dependent code; record decisions with their reasons and verification evidence.

Signed formats can change. Experimental artifacts have no compatibility or
live-value migration guarantee; version changes must not reinterpret old signatures.

## Licence

[CC0 1.0 Universal](LICENSE) — public domain dedication.
