# reference-ts

The TypeScript reference implementation of the
**[Medium of Exchange Protocol](https://github.com/mediumofexchange/money-from-first-principles)**:
one backing object `B = (K, P, R, E)`, claims held against it, wallets, and the
law.

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
  evidence: { setting: "transparent", operator: operatorKey },   // E — who says it is unspent
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
way to try the implementation. There is no published npm release.

The transparent setting only. In scope: canonical encoding of backings,
hashing, signatures, issuance, swaps, presentation, sequencing, dishonour,
succession, recovery, and the conservation arithmetic. Out of scope for now:
blinding, the accumulator and pooled constructions, the Chaumian profile,
shielded anything, external references, triggers, pro-rata.

The test suite covers the invariants one file at a time — `test/invariant-*.ts`
is the readable index of what the code promises.

The compact commitment format and local pilot profile follow specification
revision [`c3f4b0f`](https://github.com/mediumofexchange/money-from-first-principles/tree/c3f4b0f99f00f60edb3305e83f7359346c8805d9).

## Try the local payment pilot

With Node.js 24, run the optional durable pilot after the source setup above:

```sh
npm run pilot:demo
```

The scenario exercises two clients, a local operator and witness, payment
verification, restart, retries, and redemption. See [the pilot guide](docs/PILOT.md)
for its storage and trust assumptions. The witness is local and trusted; this
is an integration demonstration, not a deployed payment service.

## What this is for

The paper derives the object and argues for it. The protocol says what to
build. This says one way to build it, in code you can read. The reference and
local pilot are experimental and have not undergone a completed security
audit. The cryptography is deliberately limited to hashes and
signatures (`@noble/hashes`, `@noble/curves`, and nothing else).

## Reading it

The build order is the reading order, and `src/index.ts` lists the modules in
it: primitives, then the object, then what moves it, then sequencing, then
failure and recovery.

Two files are worth opening first:

| | |
|---|---|
| **`src/contexts.ts`** | Every domain-separation tag in the system on one screen, with the prefix-free property asserted at load rather than assumed. |
| **`src/backing.ts`** | The canonical encoding — the byte layout that every name in the system is a hash of. |

`WORK.md` is the current handoff for anyone continuing the implementation.
`AGENTS.md` is the short, shared engineering contract, and `CLAUDE.md` imports
it for Claude Code. `docs/PROTOCOL_RULES.md` holds detailed invariants for
on-demand reading. `DECISIONS.md` indexes durable choices — one line each,
with the entries in `decisions/` — so agents load only the history relevant to
the current work.

## Working on it

```
npm ci
npm run check     # docs, types, tests, built package consumer, and Node 24 pilot
```

The core requires Node 20 or newer; the optional durable pilot requires Node 24.
Before changing the implementation, read `WORK.md`
and `AGENTS.md`; follow the linked specification and decision entries only as
needed for the current slice.

## The wire format is not stable

Shared commitments now authenticate a directory of backing names and snapshot
digests. A verifier can fetch the relevant log without unrelated histories;
a named but withheld log is unavailable evidence, never proof of absence.
This changes the commitment signature context to `moe/commitment/v2` and is
incompatible with earlier commitments.

Backing names, venue ids and signatures use byte layouts that are
still free to change. Earlier, the domain-separation namespace and
the canonical encoding's magic bytes moved from `mfp/` and `"MFPB"` to `moe/`
and `"MOEB"` when the project took the `mediumofexchange` name. There is no
compatibility path across that change and none is planned — accepting two
namespaces would defeat the separation the tags exist to provide. Anything you
sign with this package today should be treated as disposable.

## Licence

CC0 1.0 Universal — public domain dedication, matching the paper. Do what you
like with it.
