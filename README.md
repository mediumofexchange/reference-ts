# Medium of Exchange — TypeScript reference

An experimental implementation of the **[Medium of Exchange Protocol](https://github.com/mediumofexchange/money-from-first-principles)**,
for issuing and exchanging claims against publicly defined promises. The design
aims to keep payments private while allowing anyone to verify supply.

A backing defines who owes, what a unit pays, what must accompany redemption,
and how unspent claims are verified. The protocol requires authorization for
increased obligations and for moving a holder's claims.

## Status

The active runtime is a **shielded pool**: private notes with public verification
of issuance and conservation. It implements v2 proofs, canonical history,
receipt readers and durable sequencing. Recovery and successor v3 formats
have executable models and conformance checks; they are not runtime support.

A [local Node 24 service and client](docs/POOL_SERVICE.md) now expose durable
pool submission, commitment and publication retry. There is no pool wallet or
external witness write adapter yet. The API and wire format are experimental, the package is not published
to npm, and no completed security audit or live deployment is claimed.

The runtime tracks specification revision
[`3676757a1c8ddc0df607352c6bddbb48f6d85a09`](https://github.com/mediumofexchange/money-from-first-principles/tree/3676757a1c8ddc0df607352c6bddbb48f6d85a09).
See [implementation status](docs/IMPLEMENTATION_STATUS.md) for component
evidence and later model pins, and [production requirements](docs/PRODUCTION_REQUIREMENTS.md)
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
npm run check:pool       # pinned v2 circuits and real proofs
npm run check:pool:v3    # successor relations; no adopted v3 configuration
```

These are developer verification commands; the repository does not yet provide
an end-user payment application. See the [v2 circuit guide](src/pool/circuits/README.md)
and [v3 conformance guide](scripts/pool/v3/README.md) for proof setup and limits.

## Explore the implementation

| Start here | What it explains |
|---|---|
| [Architecture](docs/PRIVATE_PAYMENT_ARCHITECTURE.md) | Active components, models, and retirement conditions for retained experiments. |
| [Protocol rules](docs/PROTOCOL_RULES.md) | Specification rules mapped to code and tests. |
| [Backing encoding](src/backing.ts) | Canonical terms and the hash that names a backing. |
| [Shielded pool](src/pool/) | Private notes, verification, history and durable operation. |
| [Recovery design](docs/POOL_V3_RECOVERY_MAP.md) | Successor integration work and unresolved dependencies. |
| [Decisions](DECISIONS.md) | Dated choices, rationale, evidence and specification changes. |

The frozen transparent path and private-payment experiment remain test evidence
until their remaining cases move to the pool. They are not separate product
directions. Their purpose and removal criteria are in the
[retirement map](docs/PRIVATE_PAYMENT_ARCHITECTURE.md#retained-evidence-and-retirement-conditions).
The [local pilot guide](docs/PILOT.md) documents the transparent integration harness.

## Contributing

Read [AGENTS.md](AGENTS.md) for engineering and review rules and
[WORK.md](WORK.md) for the current task. Resolve specification changes before
dependent code; record decisions with their reasons and verification evidence.

Signed formats can change. Experimental artifacts have no compatibility or
live-value migration guarantee; version changes must not reinterpret old signatures.

## Licence

[CC0 1.0 Universal](LICENSE) — public domain dedication.
