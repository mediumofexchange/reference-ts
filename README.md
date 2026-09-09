# reference-ts

The TypeScript reference implementation of the
**[Medium of Exchange Protocol](https://github.com/mediumofexchange/money-from-first-principles)**:
one backing object `B = (K, P, R, E)`, claims held against it as notes in a
shielded pool, wallets, and the law.

The package is not published to npm. Build and check the source with Node.js
20 or newer:

```sh
git clone https://github.com/mediumofexchange/reference-ts.git
cd reference-ts
npm ci
npm run check
```

After building, the package exports are available within this checkout:

```ts
import { makeBacking, backingName } from "@mediumofexchange/reference";

const backing = makeBacking({
  obligor: obligorKey,                                    // K — who owes
  payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },  // P — what a unit pays
  reliance: [],                                           // R — what travels with it
  evidence: {                                             // E — who says it is unspent, and how
    setting: "pool", operator: operatorKey,
    construction: "moe/pool/v2", configuration: configHash,
  },
});

backingName(backing); // the hash of the canonical encoding of all four fields
```

Every module is also importable on its own, if you would rather not take the
whole surface:

```ts
import { encodeBacking } from "@mediumofexchange/reference/backing";
import { REPLACEMENT_CONTEXT } from "@mediumofexchange/reference/contexts";
```

## Status

**Experimental; the API and wire format can change.** Source is the supported
way to try the implementation. There is no published npm release, no
deployment, and no completed security audit.

The active implementation is the shielded pool in `src/pool/`: pinned v2
circuits and proofs, private notes, public supply replay, record-derived
authority and canonical history, receipt readers, and durable sequencing.
Silence recovery is modeled but not implemented in the runtime. There is no
pool wallet, service transport or external witness write adapter yet.

The frozen transparent implementation and its local pilot remain adversarial
and integration evidence. The private-payment experiment retains real-proof
feasibility checks while its remaining cases are migrated.

Use [the architecture map](docs/PRIVATE_PAYMENT_ARCHITECTURE.md) for component
boundaries and retirement conditions, [production requirements](docs/PRODUCTION_REQUIREMENTS.md)
for release gates, and [fault recovery](docs/POOL_FAULT_RECOVERY.md) for the
selected rules and model limits of the companion's
[fault contract](https://github.com/mediumofexchange/money-from-first-principles/blob/23af0f5/pool-fault.md).
`npm run check:pool` exercises the
pinned real circuits and multi-segment replay separately from the ordinary
test suite. With Node 24, `npm run check:pool:delivery` exercises the
[successor delivery/restoration probes](docs/POOL_DEPLOYMENT_PROBES.md#delivery-and-seed-restoration):
seed-encrypted capsules, fresh-process recovery over synthetic public data,
and real proof binding. `npm run check:pool:fees` compares the successor
[transfer shapes and ordinary fees](docs/POOL_DEPLOYMENT_PROBES.md#transfer-shape-and-ordinary-fees)
with real proofs. These probes do not implement a pool wallet or v3 finality.
`npm run check:pool:spent` verifies the successor's
[canonical compressed spent-set candidate](docs/POOL_DEPLOYMENT_PROBES.md#spent-set-replay)
against independent batch roots and hostile keys; `npm run bench:pool:spent`
compares per-insert replay cost with pinned v2. It is outside the runtime.

`model/pool-v3-records.ts` implements the successor's reviewed
[canonical record layouts](https://github.com/mediumofexchange/money-from-first-principles/blob/ca727f6/pool-v3.md#5-canonical-statement-records).
`npm test` checks exact bytes, hostile parsing, delivery association and
signature-message binding. This codec is not exported or used for admission;
v3 configuration, finality and adoption remain undefined.

The runtime follows specification revision
[`3676757a1c8ddc0df607352c6bddbb48f6d85a09`](https://github.com/mediumofexchange/money-from-first-principles/tree/3676757a1c8ddc0df607352c6bddbb48f6d85a09),
whose `pool-v2.md` pins the construction bit for bit and records the
implemented circuits and keys. `docs/PROTOCOL_RULES.md` maps each binding
rule to its specification rule, code and test, and marks what is frozen.
That revision's `pool-recovery.md` specifies presentation, the non-service
count, snapshot redemption at the venue and the return from silence over the
pool; `model/pool-recovery.ts` is its executable model with counterexamples.
Those objects belong to a later construction version and remain outside the
v2 runtime.

The recovery model follows the later [silence-retirement decision](decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts)
and specification revision [`c5f5464`](https://github.com/mediumofexchange/money-from-first-principles/commit/c5f5464).
An intervening silence gap retires old continuation and lapses unfinished
receipts even after an unrelated clock reset, preserving earlier finality and
liability. Return requires a new segment and complete recovery adoption.
The original double-spend counterexample remains under an explicit departure.
`model/pool-fault.ts` extends that model with the selected fault contract at
[`23af0f5`](https://github.com/mediumofexchange/money-from-first-principles/commit/23af0f5):
authenticated exclusion, a clock read from the snapshot, and continuation of
the last valid prefix. Rejected policies remain test-only historical controls.
The model hashes exact admitted proof/signature bytes into a separate chain,
compares receipt evidence and retains witnessed bytes through adoption. Proof
and signature verification remain ideal oracles. Production v3 records/configuration,
compact fault certificates and authenticated interval evidence remain open.

The later [presentment clarification](https://github.com/mediumofexchange/money-from-first-principles/commit/923ee46)
keeps pool demands authorized by their holding proofs. A fresh presenter key
authorizes release/withdrawal; the demand does not establish that key's
participation, its publisher's identity or a person's reputation. Focused
model cases cover copied evidence, field rebinding and lock/retry behavior;
they assume cryptographic authentication and do not implement v3 recovery.

The successor [proof layouts](https://github.com/mediumofexchange/money-from-first-principles/blob/d57ddb0/pool-v3.md)
fix six relations and public-input orders. `npm run check:pool:v3` compiles
and proves them together, including delivery on issue/burn, four spend
outputs, canonical demand padding, refresh binding and equal-count cross-key
rejection. See the [conformance suite](scripts/pool/v3/README.md). V3 remains
an incomplete construction: no configuration hash, approved artifact pins,
backing adoption or runtime support is defined.

## Try the local pilot

With Node.js 24, after the source setup above:

```sh
npm run pilot:demo
```

Two clients, a local operator and witness, payment verification, restart,
retries, and redemption on the frozen transparent path. See
[the pilot guide](docs/PILOT.md) for its storage and trust assumptions. The
real-proof experiment runs separately with `npm run check:privacy`; see
[its README](experiments/private-payment/README.md).

## What this is for

The paper derives the object and argues for it. The protocol says what to
build. This says one way to build it, in code you can read. The package's
own cryptography is hashes and signatures (`@noble/hashes`, `@noble/curves`)
and the pool's Poseidon2 in plain TypeScript; the proof system **E** declares
is Barretenberg's UltraHonk, reached through the optional peer dependency
`@aztec/bb.js` on the `pool/barretenberg` subpath only.

## Reading it

The build order is the reading order, and `src/index.ts` lists the modules in
it: primitives, then the object, then what moves it, then sequencing, then
failure and recovery. Modules marked `FROZEN` at their head are the transparent
path.

Two files are worth opening first:

| | |
|---|---|
| **`src/contexts.ts`** | Every domain-separation tag in the system on one screen, with the prefix-free property asserted at load rather than assumed. |
| **`src/backing.ts`** | The canonical encoding — the byte layout that every name in the system is a hash of. |

`WORK.md` is the current handoff for anyone continuing the implementation.
`AGENTS.md` is the short, shared engineering contract, and `CLAUDE.md` imports
it for Claude Code. `DECISIONS.md` indexes durable choices — one line each,
with the entries in `decisions/` — so agents load only the history relevant to
the current work. `docs/PRODUCTION_REQUIREMENTS.md` is the release contract
and `docs/PRIVATE_PAYMENT_ARCHITECTURE.md` the order of steps and the
consolidation map.

## Working on it

```
npm ci
npm run check     # docs, types, tests, package consumer, pilot and pool-store crashes
```

The core requires Node 20 or newer; the optional durable pilot and pool store
require Node 24. Before changing the implementation, read `WORK.md` and `AGENTS.md`; follow
the linked specification rules and decision entries only as needed for the
current slice.

## The wire format is not stable

Shared commitments authenticate a directory of backing names and snapshot
digests (signature context `moe/commitment/v2`, directory version 1). The
pool's frames follow `pool-v2.md` and **E**'s declaration is evidence clause
`0x05`, but the commitment envelope over the pool's directory and the
sequencer's objects are not yet fixed, and fixing them may change signed
bytes again. Anything you
sign with this package today should be treated as disposable. There is no
compatibility path across format changes and none is planned — accepting two
namespaces would defeat the separation the domain tags exist to provide.

## Licence

CC0 1.0 Universal — public domain dedication, matching the paper. Do what you
like with it.
