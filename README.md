# reference-ts

The TypeScript reference implementation of the
**[Medium of Exchange Protocol](https://github.com/mediumofexchange/money-from-first-principles)**:
one backing object `B = (K, P, R, E)`, claims held against it, wallets, and the
law.

```
npm install @mediumofexchange/reference@next
```

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

**Early, and the API moves.** Published under the `next` dist-tag, so
`npm install @mediumofexchange/reference` without a tag will not pick it up
until there is something worth calling `latest`.

The transparent setting only. In scope: canonical encoding of backings,
hashing, signatures, issuance, swaps, presentation, sequencing, dishonour,
succession, recovery, and the conservation arithmetic. Out of scope for now:
blinding, the accumulator and pooled constructions, the Chaumian profile,
shielded anything, external references, triggers, pro-rata.

784 tests, covering the invariants one file at a time — `test/invariant-*.ts`
is the readable index of what the code promises.

## What this is for

The paper derives the object and argues for it. The protocol says what to
build. This says one way to build it, in code you can read — it is a reference,
not a product. Nothing here has been deployed, audited, or used for anything
that matters, and the cryptography is deliberately limited to hashes and
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

`CLAUDE.md` states the invariants that bind every line. `DECISIONS.md` indexes
the resolved questions — one line each, with the entries in `decisions/` — so
reopening one is done knowingly rather than by forgetting it was ever decided.

## Working on it

```
npm install
npm test          # vitest, 784 tests
npm run typecheck
npm run build     # tsc -> dist, with declarations
```

Requires Node 20 or newer.

## The wire format is not stable

Backing names, venue ids and signatures are hashes over byte layouts that are
still free to change, and one already has: the domain-separation namespace and
the canonical encoding's magic bytes moved from `mfp/` and `"MFPB"` to `moe/`
and `"MOEB"` when the project took the `mediumofexchange` name. There is no
compatibility path across that change and none is planned — accepting two
namespaces would defeat the separation the tags exist to provide. Anything you
sign with this package today should be treated as disposable.

## Licence

CC0 1.0 Universal — public domain dedication, matching the paper. Do what you
like with it.
