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
- **The pool's claim layer** (`src/pool/`, construction `moe/pool/v2`,
  pool-v2 §§1–13): the field and the in-circuit hash on the host, notes over
  the construction domain with their commitments and nullifiers, the depth-32
  note tree, the spent-set accumulator with membership and non-membership
  proofs, the depth-16 scope tree with private membership paths, the
  configuration, segment, statement, history and snapshot frames, **E**'s
  declaration of the construction, and `Segment`: finalized import of the
  openings' prefixes with deduplication and conflict refusal, admission
  against one committed view with one anchor per input, the directory over
  the whole scope, and replay through supplied checkpoint evidence. The
  [pool-v2 circuits](src/pool/circuits/README.md) — issue, two-input/two-output
  spend with per-backing conservation, padding and scope membership, and
  burn — are the pinned sources; `npm run check:pool` checks their
  identities, exercises real ZK proofs and adversarial witnesses, and drives
  two segments across an operator replacement with real proofs through the
  Barretenberg verifier.
- **Pool receipt envelopes** (`src/pool/receipt.ts`, pool-v2 §9): strict
  operator signatures bound to the segment's authority — domain, identity,
  scope root, operator — with separate checks for statement identity, exact
  admitted evidence, and inclusion in a replayed history. A receipt proves
  acceptance; witnessed finality and the scope's standing remain the
  sequencing layer's check.
- **Shared-scope scheduling** (`src/pool/schedule.ts`, C2.6.1/C2.10.9):
  bigint time checks for the earliest term boundary, the operator-wide
  commitment in flight and restart lag, checked against an enumerated
  calendar model. Durable execution and the remaining entry checks are pending.
- **Record-derived scope authority** (`src/pool/authority.ts`, C2.5/C2.10):
  an immutable read of signed backing terms and the witnessed replacement
  chain checks every scoped term, distinguishes same-key reappointments,
  and derives the scheduler's deadlines. It requires an explicitly declared
  common venue. It does not authenticate a header or finalize its openings.
- **Bounded commitment predecessor reads** (`Venue.previousFor`, C2.7.2):
  the local and Ergo venues locate prior held sequences, including at the same
  witnessed index, with logarithmic lookup across sparse histories. Custom
  `Venue` adapters must implement this required read.
- **Exact directory descent** (`readPoolPredecessor`, C2.7/C2.10.4): selects
  a candidate before replay, relative to a held child checkpoint. Authenticated
  directory absence and public whole-scope lapse permit descent; missing
  evidence or invalid live history cannot substitute an older candidate.
  Snapshot preimages authenticate scope without revealing local statements.
  Candidate selection does not establish whole-scope finality.
- **Whole-scope checkpoint validation** (`readPoolCheckpoint`, C2.10.3–5):
  checks an exact held checkpoint and its transitive canonical imports,
  selecting every backing's predecessor before replay. Continued segments
  preserve their finalized prefix. Missing evidence stops validation;
  historical finality survives later term endings. The reader returns a
  verified prefix, not permission to open service or spend a note.
- **Canonical opening construction** (`preparePoolOpening`, C2.7/C2.10.4–7):
  derives the current scope and latest carrying state before a child exists,
  validates all required histories together, and prepares a segment with empty
  local history. Its next sequence comes from the operator's durable signed
  counter, including unsuccessful publications. Preparation neither reserves
  that sequence nor authorizes abandoning receipts or activating service.
- **A local two-process pilot** on the frozen path (`docs/PILOT.md`): durable
  commands, exact retries, crash recovery, a trusted local witness. An
  integration harness, not a product.

Out of scope until their step: the pool sequencer over the witnessed record
(durable activation of prepared openings, admission/signing and restart),
durable receipt issuance and recovery, note delivery and backups,
the wallet, an external witness's write side, and every Extensions profile.

The [replacement boundary](docs/POOL_SEQUENCING_BOUNDARY.md) is resolved by
the [authority and history contract](https://github.com/mediumofexchange/money-from-first-principles/blob/main/pool-authority.md),
which `moe/pool/v2` instantiates: immutable note identity separated from
current operator authority, private membership in a public service scope,
one anchor per input, and finalized shared histories imported with
deduplication. [The adversarial model](model/pool-authority.ts) exercises
splits, reunions, replay and scope changes with ideal cryptography; the
claim layer now holds the frames and circuits. Record-derived authority,
scheduling, predecessor descent, whole-scope checkpoint finality and canonical
import validation and canonical opening construction are implemented;
durable activation, admission/signing and restart are next.
The historical `moe/pool/v1` runtime was replaced and lives in git history.

The runtime follows specification revision
[`ba8fe21a8d3e55d07f18edbd9ec180adb68f6ef4`](https://github.com/mediumofexchange/money-from-first-principles/tree/ba8fe21a8d3e55d07f18edbd9ec180adb68f6ef4),
whose `pool-v2.md` pins the construction bit for bit and records the
implemented circuits and keys. `docs/PROTOCOL_RULES.md` maps each binding
rule to its specification rule, code and test, and marks what is frozen.

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
