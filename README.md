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
    construction: "moe/pool/v1", configuration: configHash,
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

Construction's core claim layer is the **shielded pool**: ownership, amounts and
histories hidden, supply proven at the pool's lit boundary. This repository
builds it, in this order: specification → an executable adversarial model of
the rules → the pool's claim layer → sequencing, recovery and presentation
over notes → the wallet → the witness venue's write side. There is no release
deadline. What the repository holds today:

- **Primitives that carry forward:** canonical encoding and naming, strict
  Ed25519 signatures, commitments and their authenticated directory, the venue
  interface and local venue, the durable command journal.
- **A frozen transparent path** — the transparent *profile* from Extensions:
  ledger, sequencer, presentation, replacement, recovery and provable fault,
  with one test file per invariant. It is a differential oracle and a library
  of adversarial cases for the pool path, and it is deleted when superseded.
- **A real-proof experiment for the pool** (`experiments/private-payment/`,
  contract in `RESEARCH.md`): Noir circuits, ZK-enabled UltraHonk proofs,
  public-only supply replay. Excluded from the package and retained until
  its admission, replay and crash cases have moved to the pool path.
- **The pool's claim layer** (`src/pool/`, pool-v1 §§1–8): the field and
  the in-circuit hash on the host, notes with their commitments and
  nullifiers, the depth-32 note tree, the spent-set accumulator with
  membership and non-membership proofs, the configuration, statement, history
  and snapshot frames, **E**'s declaration of the construction, and admission
  against one committed view with replay from genesis. The
  [pool-v1 circuits](src/pool/circuits/README.md) — issue, two-input/two-output
  spend with per-backing conservation and padding, and burn — are the pinned
  sources; `npm run check:pool` checks their identities, exercises real ZK
  proofs and adversarial witnesses, and drives the claim layer with real
  proofs through the Barretenberg verifier.
- **Pool receipt envelopes** (`src/pool/receipt.ts`, pool-v1 §7): strict
  operator signatures bound to the expected configuration, with separate
  checks for statement identity, exact admitted evidence, and inclusion in a
  replayed history. A receipt proves acceptance; witnessed finality remains
  the sequencing layer's check.
- **A local two-process pilot** on the frozen path (`docs/PILOT.md`): durable
  commands, exact retries, crash recovery, a trusted local witness. An
  integration harness, not a product.

Out of scope until their step: the pool sequencer and its commitment schedule,
durable receipt issuance and recovery, note delivery and backups, the wallet,
an external witness's write side, and every Extensions profile.

The [replacement boundary](docs/POOL_SEQUENCING_BOUNDARY.md) is resolved at
the specification and model level by the
[authority and history contract](https://github.com/mediumofexchange/money-from-first-principles/blob/a219aad/pool-authority.md).
It separates immutable note identity from current operator authority, proves
private membership in a public service scope, and imports only finalized
shared histories. [The adversarial model](model/pool-authority.ts) exercises
splits, reunions, replay and scope changes. It uses ideal cryptography and a
local journal abstraction; new frames, circuits and production sequencing
remain to be built. The current v1 runtime is fixed to its original operator
and cannot deploy this replacement contract.

The existing v1 runtime follows specification revision
[`81516ba`](https://github.com/mediumofexchange/money-from-first-principles/tree/81516ba),
whose `pool-v1.md` pins the construction bit for bit and records the
implemented circuits and keys, including the §7 receipt bytes signed here.
`docs/PROTOCOL_RULES.md` maps each binding rule to its specification
rule, code and test, and marks what is frozen.

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
npm run check     # docs, types, tests, built package consumer, and Node 24 pilot
```

The core requires Node 20 or newer; the optional durable pilot requires Node
24. Before changing the implementation, read `WORK.md` and `AGENTS.md`; follow
the linked specification rules and decision entries only as needed for the
current slice.

## The wire format is not stable

Shared commitments authenticate a directory of backing names and snapshot
digests (signature context `moe/commitment/v2`, directory version 1). The
pool's frames follow `pool-v1.md` and **E**'s declaration is evidence clause
`0x05`, but the receipt and commitment envelopes over the pool's fields are
not yet fixed, and fixing them will change signed bytes again. Anything you
sign with this package today should be treated as disposable. There is no
compatibility path across format changes and none is planned — accepting two
namespaces would defeat the separation the domain tags exist to provide.

## Licence

CC0 1.0 Universal — public domain dedication, matching the paper. Do what you
like with it.
