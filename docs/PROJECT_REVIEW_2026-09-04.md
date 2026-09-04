# Project review — 2026-09-04

## Assessment

Preserve the project's useful central idea: immutable, signed promises that
anyone can issue, transfer and inspect, with a fixed reliance set for unfunded
cover. The distinctions between ordering and custody, and between promised
value and actual performance, are important strengths.

The largest opportunity is to make that idea smaller to operate and verify.
There is an extensive executable protocol model, but no complete payment
product. Recovery and succession have accumulated considerably more machinery
than the first useful deployment needs, while durable operation, usable payment
verification and distribution remain absent.

Recommended direction: correct the concrete boundary bugs below, execute the
already-recorded compact commitment proposal, and build one durable transparent
payment pilot. Use that pilot and a small adversarial state-machine model to
decide subsequent protocol changes. Defer additional financial features.

This is a defensive engineering and design review, not a completed independent
security audit. No protocol or implementation behavior was changed by it.

## Baseline and evidence

All four working trees were clean at review start. Local `main` matched live
GitHub `HEAD` and `refs/heads/main`, checked with `git ls-remote`:

| Local repository | GitHub repository | Reviewed commit |
| --- | --- | --- |
| reference-ts | mediumofexchange/reference-ts | b384a07da619461f1a4e18167318d1555a81c1b8 |
| money-from-first-principles | mediumofexchange/money-from-first-principles | e3dfeb7dd264963c77e2ba1f7c23acff9332adbb |
| site | mediumofexchange/mediumofexchange.github.io | 5a9bb3ea8daa964cd78c667201ca18340f7be1cb |
| orgprofile | mediumofexchange/.github | 5c779e73ebc9ca1137c059b20cd30209b527f302 |

Review covered intent and limits, normative construction and extensions,
implementation boundaries, relevant decisions, tests, packaging, CI and public
entry points. Independent reviewers covered protocol design, implementation
security, and practical readiness. The security reviewer's final turn was
stopped by an automated content filter. Its earlier findings were available,
but that lane must not be represented as a completed audit.

- `npm run check` passed: documentation checks, typecheck, all 48 test files /
  962 tests, and build. Tests took 128.45 seconds in this run. An initial sandbox
  esbuild filesystem restriction was resolved by a permitted external run.
- `npm pack --dry-run` passed: 83 files, 257.8 kB packed, 988.6 kB unpacked.
- `npm audit --json` reported zero known vulnerabilities. This checks dependency
  advisories, not protocol correctness.
- The Ergo overlap probe reproduced a false silence grade; the primary reviewer
  reran it against the built package. Its source is preserved in the appendix.
- `npm view @mediumofexchange/reference version dist-tags --json` returned E404.

File locations below refer to these reviewed commits, before proposed fixes.

## Concrete findings

### 1. P1: signature verification trusts a caller's cached backing identity

In [backing.ts](../src/backing.ts), `backingName` at line 622 correctly
recomputes identity from canonical terms. However, `verifyBackingSignature`
at lines 657–658 verifies `backing.name` directly. `signBacking` at line 649
uses the same cached value.

A copied backing can retain its original name, nameHex and obligor while its
payout changes. The original signature then passes the public verifier although
the presented terms have a different canonical hash. The implementation reviewer
observed this with a payout changed from 100 to 1,000,000 quanta. The existing
changed-terms test constructs a fresh backing, refreshing the cached name and
missing this case. Source inspection confirms the missing binding.

This reaches public `TransparentLedger.register` at [ledger.ts](../src/ledger.ts)
line 1003: it verifies the supplied object, indexes by supplied nameHex, then
normalizes with makeBacking. That can admit terms not authorized by the supplied
signature and store their normalized identity under a different map key.
`Sequencer.register` normalizes first, so this does not establish the same
bypass through the supported sequencer path. It is not an Ed25519 forgery.

Fix: derive canonical identity before signing/verifying, and storage keys from
the same validated object. Cached names must be conveniences, not authority.
Test retained identifiers with changed terms, mismatched nameHex, and malformed
names. Framing currently occurs outside a guard, so malformed backing input can
also throw from the public verifier.

### 2. P1: overlapping Ergo refreshes can manufacture silence

[ErgoVenue.sync](../src/ergo.ts), starting at line 306, replaces shared height
and maps while awaiting network reads. `syncCommitments` at lines 425–427
installs an awaited result into those maps. No overlap guard or generation
check protects the view.

Pause an old refresh at its commitment fetch, finish a newer refresh, then
release the old fetch. Both calls succeed, but the old commitment replaces the
newer one while the newer clock remains:

```text
new sync finished      { height: 197n, sequence: 1n, silent: false }
old sync finished last { height: 197n, sequence: 0n, silent: true }
```

Silence is an input to recovery eligibility, so this is a protocol-input
coherence failure. The probe establishes the false grade; it does not establish
theft or a deployed-network exploit.

Small fix: serialize or explicitly reject overlapping refreshes. Better
boundary: build a private complete snapshot and install it atomically with a
generation policy. A slower earlier refresh must not overwrite a completed
newer generation. Test overlap, failures and reads during refresh.

### 3. P2: Ergo reads expose mutable stored records

`revocationsFor` at [ergo.ts](../src/ergo.ts) line 546 and `publishedOpsFor`
at line 558 return new outer wrappers around stored values without copying
their inner records or bytes. A caller can mutate a returned record and change
subsequent answers. `replacementsFor` already copies, showing the intended rule.

This is a same-process isolation bug; no remote exploit is established. Use
existing copy helpers and test nested byte mutation. It was already noted at
the end of the September 3 decision but omitted from the short active handoff.
Keep unresolved security findings visible until fixed or explicitly accepted.

### 4. The advertised public installation path is unavailable

The npm query returned E404, while the implementation README, paper README and
website advertise `npm install @mediumofexchange/reference@next`. The September
3 decision itself describes the package as unpublished.

Use a tested source-install path until an authorized prerelease exists. Add a
clean consumer test: pack, install the tarball in an isolated project, import
supported entry points, and execute an example. CI currently stops at
`npm pack --dry-run`, which does not establish public availability or usability.

## Architectural changes worth considering

### 5. Make verification and recovery specific to a backing

[commitment.ts](../src/commitment.ts), lines 29–37, explicitly requires the
whole served state to verify a commitment. `stateRoot` at line 109 hashes
anonymous snapshot digests. Establishing that one backing is missing requires
the other backings' full logs. One user's recovery consequently depends on
unrelated activity under the same operator.

The earlier review recorded 19.2 MB per omission exhibit at 100 backings with
1,000 entries each. That is historical evidence, not a rerun here. September 3
already recommends framing each name beside its digest, reducing the directory
to roughly 64 bytes per backing. Execute that decision before durable
commitments make changing the format costly. This is not a newly found hash
collision or a new recommendation disguised as one.

Then assess a larger design: per-backing checkpoints naming the backing,
operator term, prior checkpoint, log length and log commitment, batched into one
venue publication. Wallets should retain their relevant history with compact
proofs connecting it to the shared publication.

Keep three properties separate:

- A name/digest directory or authenticated tree makes inclusion/absence proofs
  smaller.
- Append-only evidence or validated checkpoint ancestry establishes continuity.
  An arbitrary signed state root alone does not.
- Replication makes data available. A hash does not.

Eliminating the unbounded omission walk requires an explicit per-backing
history source: durable update records, persistent checkpoint pointers, or
venue-enforced transitions. Merkle proofs alone do not remove that walk. These
alternatives cost metadata, storage or stronger venue requirements and need a
deliberate specification decision. Batching can remain without putting every
payment on a global ledger.

### 6. Separate a fixed venue view from asynchronous publication

[Venue](../src/venue.ts), lines 222–266, combines synchronous reads and
publication. [ErgoVenue](../src/ergo.ts) throws from every publish method at
lines 503–520 and from commitsFor at lines 523–535. Sequencer.commit calls
venue.publish directly. These components do not form a working real-chain
sequencer yet.

Use an immutable, complete VenueView for deterministic verification and an
asynchronous publisher for submission and confirmation. Distinguish “not
observed,” “not covered by this view” and “failed to read.” Never convert a
transport failure into evidence of absence. Identify the witnessed chain
position and covered subjects in the view. This also gives the refresh race
a natural architectural fix.

Implement a durable local adapter first, then a complete Ergo adapter including
transaction construction, submission, record retrieval, bundle decisions and
restart. FakeNode tests cannot establish pagination, index completeness, fee
handling or actual confirmation behavior.

### 7. Durability is part of signing correctness

[sequencer.ts](../src/sequencer.ts), lines 147–217, keeps ledger state,
receipts, seats, in-flight commitment and highest signed sequence in memory.
A served-state snapshot is not a recovery image for all these facts.

The venue cannot reveal a signed commitment it never received. Waiting one
venue lag after restart cannot prove that no older signature exists when
inclusion delay is unbounded. Persist signing-sequence reservations, canonical
signed bytes, accepted operations, idempotent responses and publication outbox
state before exposing the relevant result. Fence competing operator processes
so they cannot sign different roots at the same sequence.

Introduce a narrow signer interface alongside a transactional store. A local
durable signer is sufficient for the pilot; hardware or threshold signing can
later use the same boundary. Test crashes before/after persistence, signing,
broadcast and response, including a signed publication absent from the venue.
This is required deployment work, not a claim that the immediate LocalVenue
model already provides durable guarantees.

## A specification that is cheaper to implement correctly

### 8. Extract one explicit transition specification

Construction C2 line 281 contains approximately 2,490 whitespace-delimited
words in one paragraph. It mixes force, successor consent, replacement order,
possession, omission walks, restart, in-flight publication and empty openings.
Much of its reasoning is repeated in implementation comments and
docs/PROTOCOL_RULES.md.

First preserve behavior while extracting state variables, events, preconditions,
effects and evidence requirements. Assign stable rule identifiers. Separate
normative rules from explanations of past failures. Keep decisions as history
rather than a second specification.

Build a small independent model with two operators, two backings, a holder,
delayed/dropped publications, replacement cancellation, restarts and incomplete
views. Check safety and conditional progress separately. Preserve counterexamples
as regression vectors. More tests using the implementation's decomposition may
not expose a missing state dimension.

Do not casually restore “the successor takes force when it first serves.” Prior
decisions explain why force, consent and possession were separated. A simpler
design must replace their guarantees explicitly rather than forgetting them.

### 9. Distinguish prevention, evidence and recovery

Construction C4 line 371 gives sequencer equivocation no residual once witnessed,
while C2 allows withheld data to strand a successor and false empty-book claims
to be exposed by later evidence. Detecting a signed lie does not restore a
spendable balance or make an obligor pay.

Publish a guarantee matrix: what is prevented, what is detectable, which
evidence must survive, who must cooperate for recovery, and what remains
unrecoverable. A non-service grade cannot guarantee escape if the blocker also
controls replacement or redemption. Preserve the paper's distinction between
terms and value.

Reflect this in the public API. `receiptStatus` deliberately does not replay
the log; “witnessed” alone is not complete payment validation. Provide a
wallet-facing verifier combining terms authorization, request context,
inclusion, applicable operator term, lawful state and relevant freshness/finality
checks. Return structured reasons rather than leaving every wallet to discover
the correct combination of low-level predicates.

### 10. Name and version the implemented profile

The specification permits time-dependent payouts, chain-asset legs and multiple
privacy constructions. `Payout` in [backing.ts](../src/backing.ts), line 101,
supports constant external payouts and constant payouts in another backing's
units; reliance entries name backings. The README lists several exclusions,
but there is no complete conformance matrix. The paper repository says the
implementation tracks the moving spec rather than a snapshot.

Define an experimental transparent profile with supported operations, payout
forms, assets, witness assumptions and recovery semantics. Pin the spec commit
and wire version per release. Publish canonical encoding/signature and
transition vectors independent of the TypeScript tests, so another implementation
can agree without reconstructing choices from source comments.

Keep B=(K,P,R,E). For the first pilot, use R empty, one constant payout template
and one declared witness venue. Defer advanced cover, state-reading payouts,
multiple venues and private constructions until demonstrated need. This is a
deployment profile, not removal of R from the protocol. Transparent operation
does not meet the privacy goal for sensitive deployments; do not present this
engineering pilot as doing so.

## Proposed next milestone

Deliver one repeatable scenario against the built package:

1. Two independently running wallet clients create keys and agree signed root
   terms and acceptance policy.
2. An issuer issues; a payer transfers; an operator durably accepts and witnesses.
3. A receiver independently verifies the payment and sees pending/final status.
4. Kill and restart the operator and clients around persistence, signing and
   publication; retry lost responses without conflicting signatures or duplicate
   movement.
5. Redeem and exercise an operator outage. Identify exactly which recovery case
   succeeds and which needs missing evidence or cooperation.

Start with a durable local witness and actual process/transport boundaries.
Run the same scenario on Ergo testnet once its adapter is complete. Measure
payment/finality latency, proof bytes, cold verification, retained storage and
recovery cost. Include modest multi-backing histories, not only an empty happy
path.

Before this milestone, fix findings 1–3 and decide compact root framing. After
it, let measured failures select the next protocol slice. Retain independent
adversarial review for authorization, signing, persistence and consensus-sensitive
changes; another broad panel is unnecessary for ordinary documentation.

## Workflow and public presentation

- Keep risk-scaled review and short WORK.md handoffs. Track unresolved findings
  with status and evidence so issues do not disappear into monthly history.
- Link one current profile/status page from the website, paper and organization.
  Remove volatile test counts: all three still say 784. Replace “none built”
  with the distinction between an implemented reference model and an undeployed
  product.
- Correct package-lock's stale root identity, mfp-reference@0.0.1, to match
  package.json's @mediumofexchange/reference@0.1.0. Add a package-consumer test.
- At first release, add a vulnerability-reporting route, tested publishing with
  provenance, and pinned CI action revisions. Existing read-only CI permissions
  and the Node 20/24 matrix are useful foundations.
- Let pilot usage define a small supported facade. Wildcard subpaths and the
  root barrel currently expose nearly every mechanism; treating all as stable
  increases compatibility and misuse costs.
- Keep the repositories for now. Pin companion commits and check conformance
  before spending the next milestone on a monorepo migration.

## Reproducer: overlapping Ergo refreshes

After building, save the following in scratch/review-ergo-concurrency.mjs and
run with Node. It uses synthetic keys and records, no network or real assets.

```js
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  makeBacking, ErgoVenue, commitmentRegisters, signCommitment, isSilent,
} from '../dist/index.js';
const secret = new Uint8Array(32).fill(7);
const operator = ed25519.getPublicKey(secret);
const addressing = {
  commitments: () => 'commit', publications: () => 'pub', revocations: () => 'rev',
};
const venue = new ErgoVenue('test', 3n, 'script', addressing);
const backing = makeBacking({
  obligor: ed25519.getPublicKey(new Uint8Array(32).fill(1)),
  payout: { thing: 'EUR', quantumExponent: -2, perUnit: 100n }, reliance: [],
  evidence: {
    setting: 'transparent', operator,
    silence: { noCommitmentDuration: 10n, challengeWindow: 5n },
    witnessing: { venue: venue.id, interval: 5n },
  },
});
const oldBox = {
  inclusionHeight: 80n,
  registers: commitmentRegisters(signCommitment(secret, 0n, new Uint8Array(32))),
};
const newBox = {
  inclusionHeight: 194n,
  registers: commitmentRegisters(signCommitment(secret, 1n, new Uint8Array(32).fill(1))),
};
let unblock, entered;
const atCommit = new Promise(resolve => { entered = resolve; });
const gate = new Promise(resolve => { unblock = resolve; });
const oldNode = {
  indexedHeight: async () => 100n,
  boxesByAddress: async address => {
    if (address === 'commit') { entered(); await gate; return [oldBox]; }
    return [];
  },
};
const newNode = {
  indexedHeight: async () => 200n,
  boxesByAddress: async address => address === 'commit' ? [oldBox, newBox] : [],
};
const oldRefresh = venue.sync(oldNode, [backing]);
await atCommit;
await venue.sync(newNode, [backing]);
const status = () => ({
  height: venue.witnessedIndex(), sequence: venue.latestFor(operator).sequence,
  silent: isSilent(venue, backing),
});
console.log('new sync finished', status());
unblock();
await oldRefresh;
console.log('old sync finished last', status());
```

After a fix, an older refresh must not combine its records with a newer clock.
Rejecting/serializing overlaps or atomically installing generation-checked
snapshots should enforce that property.
