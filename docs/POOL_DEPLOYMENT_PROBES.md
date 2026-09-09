# Pool deployment probes

These are provisional experiments to inform v3, authorized after the
[design-review check](../decisions/archive/2026-09-08-whole-project-design-review-check.md).
They do not change the construction or declare a production release usable.
Production rules still land in the specification and adversarial model first.

## The bounded integration target

Demonstrate one signed constant-payout root, issuance, private payment with
change and a realistic fee arrangement, receiver discovery, independent
verification, interruption/exact retry, restoration on a fresh wallet, and
redemption after the original operator disappears. Start with one venue and
no reliance graph. The [fee contract](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md)
selects two inputs/four ordinary outputs. [The delivery contract](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md)
now selects receiver-prepared exact outputs and seed-encrypted capsules for a
successor; v2 cannot silently stand in for these changes.

Success requires the restored wallet to reconstruct its unspent notes from its
seed plus independently available data; a fresh verifier to check supply and
history without trusting issuer totals; and a returning operator to preserve
every finalized spend and effective recovery settlement. Tests must distinguish
invalid evidence, unavailable evidence and pending receipt liability.

The target phone and practical latency/memory/network budgets have not yet been
selected. The benchmark below supplies a baseline, not a pass against an
unstated budget. A one-backer deployment does not remove general independent
replacement rights from the protocol.

## Browser proof baseline

Use Node 24 for the tooling. Vite 7.3.6 is an explicit development dependency,
already present in the lockfile before this probe; no new runtime dependency
is added to the library. Its development-server Node requirement is narrower
than the library's Node 20 minimum.

```powershell
npm run bench:pool:prepare
npm run bench:pool:browser
```

Open `http://127.0.0.1:4173/`, record the device/browser, run the benchmark and
download the JSON. The server is loopback-only and serves synthetic benchmark
assets and development modules. For an Android device with USB debugging and
`adb` already configured, `adb reverse tcp:4173 tcp:4173` makes that same URL
reachable on the phone without exposing the repository to the LAN. Reverse
forwarding is transport only; it does not emulate phone hardware on desktop.

Preparation reuses `scripts/pool/compile.mjs` and the existing synthetic
fixtures. It verifies source, bytecode and key identities against the v2
manifest, requires the cached parameters recorded in
`docs/pool-v2-verification.json`, and publishes the completion manifest only
after the assets exist. A failed preparation invalidates that marker. Scratch
compiler files are removed on ordinary completion/failure; interrupted runs
may leave disposable compiler directories in `scratch/`. No parameters are
silently fetched by preparation or by the browser probe.

The browser exercises only spend, with one worker and the pinned
`noir-recursive` ZK target. It verifies the locally derived spend key, the
public-input order and values, proof bounds and all nine generated proofs.
There are three raw samples for each of: one real input plus padding, two
same-backing inputs, and two different backings. No warmup sample is discarded.

The recorded [first browser result](pool-browser-verification.json) is Windows
desktop Chromium 152. All nine proofs verified. Proving ranged from 4.28 to
6.29 seconds for same-backing cases and 6.79 to 9.30 seconds for mixed backings;
verification ranged from 91 to 195 ms. Every proof was 14,656 bytes. The entire
run, including initialization, took about 61.6 seconds. This is a small local
sample, not a throughput estimate or an isolated hardware comparison with the
earlier Node run. The result records the probe source hashes used for the run.

Limitations:

- This is not a cold device: code, WASM and operating-system caches may be warm.
  Asset requests bypass HTTP cache; parameter fetch and initialization are timed.
- Window JS heap sampling excludes worker/WASM allocations. Whole-browser peak
  memory is explicitly unknown. Do not compare the sampled value to a phone's
  memory budget or the old Node process RSS.
- Window resource entries exclude worker fetches and are not total network cost.
- The parameter hashes identify the local files; they do not authenticate the
  trusted setup or establish reproducible dependency builds.
- The synthetic proof inputs do not measure a wallet, restoration, note-tree
  resync, encrypted delivery, publication fees, or witnessed payment latency.

## Delivery and seed restoration

F3 selects receiver-prepared exact output requests under
[pool-delivery C4.1–8](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md).
A receiver derives the requested note from its seed and a fresh durable request
identifier and encrypts the identifier/backing/value to itself. The payer
copies the exact opening and opaque capsule. There is no stable public scan
key, new ownership algebra or payer-to-recipient key agreement. Arbitrary
unsolicited amounts require a new receiver request; pending invoices and
accounting labels still need a backup.

Reproduce the cryptographic seam and proof-binding checks with Node 24:

```powershell
npm run check:pool:delivery
```

The retained sources are under [scripts/pool/delivery](../scripts/pool/delivery/).
Generated compilation and run reports stay under ignored `scratch/`.
The [recorded result](pool-delivery-verification.json) identifies the exact
sources/toolchain and records hostile checks and local measurements. CI runs
the candidate checks on Linux and Windows beside the pinned v2 proof checks.
No production circuit, key, configuration or exported runtime API changes.

The fresh restoration process receives only a seed and synthetic public
outputs/capsules, spent nullifiers and lit settlement data. It receives no
request journal, original payer secrets or original operator callbacks.
It reconstructs positive unspent notes, retains unresolved coverage, and
separates force-created outputs awaiting canonical adoption. The probe also
checks deterministic retries, key separation, malformed/context-swapped
capsules, missing/reordered delivery vectors, authenticated wrong-commitment
plaintext, spent/zero outputs and fresh request generation after journal loss.
Node's cipher results are checked against WebCrypto independently.

Every capsule is 89 bytes. One aggregate digest adds two public field
encodings, 64 bytes per issue/spend/burn before record framing: 242 extra
bytes for two outputs, 331 for three. A real candidate spend with those two
public `u128` limbs uses 19,050 gates versus 19,034 (+16); its subgroup
remains 32,768 and proof remains 14,656 bytes. Mutating either limb rejects
the original proof. Changing only the compiler ABI metadata to `Field`
still rejects `2^128` in either limb over unchanged ACIR, establishing an
actual circuit range constraint. This is a spend-binding measurement, not
an already measured final v3 issue/spend/burn suite.

On this Windows desktop (Node 24.6.0, i7-5500U), 1,000 / 10,000 / 100,000
failed capsule opens took 79 ms / 738 ms / 12.36 s. These samples repeat one
foreign envelope while deriving its subkey each time; they measure trial
cryptography, not traversal of distinct history records. Existing commitment
plus nullifier hashing averaged 2.11 ms per pair over 250 samples, excluding
owner derivation and the rest of successful recovery. The candidate spend
proved in 4.38 s and verified in 92 ms. These are single local samples, not
phone budgets or throughput guarantees.

The restoration fixture is explicitly a **prevalidated synthetic view**.
It does not verify full v3 history, force, adoption, venue ordering or range
completeness. A caller's marker is no finality evidence. The production wallet
must consume independently authenticated complete public packages, retain
full evidence before payer/operator disappearance, and construct certified
paths. Seed recovery does not discover unknown venues/backings, prove a
complete balance or guarantee permanent availability. Device and full-history
replay costs remain additional gates.

## Transfer shape and ordinary fees

Run the retained comparison and hostile checks with Node 24:

```powershell
npm run check:pool:fees
```

[Probe sources](../scripts/pool/fees/) generate candidates from the pinned v2
spend; [recorded evidence](pool-fees-verification.json) pins their identities,
inputs and measurement scope. Generated sources/builds/reports stay in
`scratch/pool-fees/`. CI runs this command on Linux and Windows.

F4 selects two input/four output positions for successor spend, under
[pool-fees C1.2.3–7](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md).
A payment of 73 A from 100 A and a fee of 2 B from 10 B fit in one statement:
73 A to the receiver, 27 A change, 2 B to the fee recipient and 8 B change.
Each recipient controls its output through an exact F3 request. Every output
uses the same commitment, scope and per-backing conservation rules; no fee
position, asset, debit authority, public amount or new statement kind exists.
Same-backing fees and sponsored service pad the unused positions with the
payer's distinct zero-value notes and capsules.

Three positions fit same-backing payment/change/fee and can use another fee
backing if its input already has the exact amount. Four also returns both
changes without a preparation transfer. Separate fee/payment statements have
separate admission/finality; putting their submissions beside each other does
not provide atomicity. Adding a batch would need a new receipt/replay/finality
contract for behavior one ordinary spend already supplies.

| Spend candidate | Gates | Subgroup | Public inputs |
|---|---:|---:|---:|
| Pinned v2, 2x2 | 19,034 | 32,768 | 11 |
| F3 delivery, 2x2 | 19,050 | 32,768 | 13 |
| F4 comparison, 2x3 | 19,256 | 32,768 | 14 |
| Selected F4, 2x4 | 19,465 | 32,768 | 15 |

Four costs 209 gates over three (about 1.1%), a 32-byte commitment, 89-byte
capsule, one leaf and one recovery trial on every spend, including padding.
That is 121 extra statement bytes versus another roughly 15 KB proof-bearing
preparation record when needed. It also increases output storage/scanning
positions by one third; no frequency or device budget is assumed. All four
capsules plus the two public digest encodings cost 420 bytes before framing.
Inputs, note formulas, issue's one output and burn's one change remain fixed.

All five real proofs are 14,656 bytes. The selected 2x4 flow and a total of
`2^64` with individually bounded inputs both prove. Seventeen positive host
checks and 35 rejection cases cover every added output, all duplicate pairs,
per-backing conservation even when aggregate value matches, and exact capsule
association. Host-ABI bypasses leave ACIR unchanged and still reject `2^64`
in each added output and `2^128` in either delivery limb. Mutating any
commitment or digest limb rejects its original proof. These tests do not
infer hidden-value range constraints from ABI serialization alone.

On the recorded single-threaded Node 24 desktop run, the selected fee/change
proof took 4.22 s to prove and 92 ms to verify; its widened-sum boundary took
5.78 s and 132 ms. These are individual feasibility measurements, not a
timing distribution or a phone/deployment budget.

The fee recipient knows its fee opening and statement association. When the
flow guarantees the same backing, this reveals the payment backing; a quoted
fee independent of payment size avoids disclosing size through a fee formula.
Another fee backing reduces that inference only where scope and other leaks
leave actual alternatives. Sponsored service avoids direct-fee disclosure.
Fees have ordinary pending-local-root, finality, lapse and recovery treatment;
exact retry returns its existing receipt before applying a changed price.
Changing an exposed fee requires a newly authorized transfer after verified
lapse and canonical unspentness, not an implicit rewrite or cancellation.

Private fee policy is outside public validity. A fee-free admitted statement
remains valid on replay. Unpaid/declined quotes do not clear non-service counts
or gate the public remedies: the holding request proves no fee agreement.
Backer/sponsor funding remains a practical service choice, including for the
unchanged issue/burn/recovery shapes. Pool fees do not fund venue currency
publication costs automatically.

The probe compares generated circuits and receiver-prepared output evidence.
It does not implement v3 admission, a quote transport, durable wallet pricing,
public-history authentication or actual publication. Those are integration
and deployment gates, not consequences of choosing an arity.

## Spent-set replay

A22 selects [the successor spent-root contract](https://github.com/mediumofexchange/money-from-first-principles/blob/78f8a8c/pool-spent.md):
a canonical compressed binary tree with full-key leaves and absolute split
positions. `scripts/pool/spent-set/` retains the candidate and an independent
batch oracle; no runtime v2 code, root, proof or configuration changes.
`npm run check:pool:spent` is included in `npm run check`, so Linux Node 20/24
and Windows Node 24 CI exercise the deterministic checks.

Ten check groups cover empty/singleton frames, all 120 insertion orders of a
five-key boundary set, every prefix under four orders, every split position
and a hostile 256-branch path, skipped prefixes, field boundaries,
non-membership capability, imported-set grouping, duplicates, malformed
typed arrays and input/output aliasing. Imported event/conflict validation
and atomic multi-nullifier statement updates remain runtime obligations;
the probe only accumulates an already validated set. The path algebra proves
the retained non-membership capability, without selecting a published proof
format or parser.

Run `npm run bench:pool:spent` to regenerate
`scratch/pool-spent-set/report.json`. The
[recorded report](pool-spent-verification.json) pins the specification and
LF-normalized source hashes, environment and deterministic roots. Both shapes
use the same SHA-256 library, and the harness reads the root after **every
insert**, including v2's lazy singleton hashing. Sizes are 128, 1,024, 8,192
and 100,000 keys, with one measured run after a 128-key warmup; a reversed
candidate replay checks the final root at every size. No timing threshold
determines a pass. This measures accumulator replay, excluding proof checks,
history bytes, import validation and transport; it is not end-to-end replay,
memory-in-bytes, mobile or deployment evidence.

The retained 100,000-key comparison took 157.29 s for v2 and 15.80 s
for the candidate (9.96×), with 1,649,737 candidate hashes, or 16.50 per
insert. Reverse candidate replay took 10.14 s; timings vary with the
machine and load. An insertion needs at most one leaf hash and 256 branch
hashes even for hostile keys, while uniform-key path lengths are approximately
logarithmic. The selected representation stores N leaves and N−1 branches
for N > 0. This closes the A22 shape decision, not v3 runtime integration.

## Invalid-checkpoint evidence

`model/pool-fault-boundary.test.ts` contains nine cases using the existing
authority/recovery models. The valid control finalizes the same public suffix
that a forged ideal proof causes to fail. In the hostile case both scope
backings lose readable snapshot, count and descent; independently replacing
their operator does not make the invalid predecessor importable.

Invalid publications at indices 4, 8, 12 and 16 keep resetting a five-index
clock. At 22 the gap is open, but the snapshot still cannot be read. Even an
ideal snapshot-only skipping reader cannot fix the clock or descent; the
count reads the snapshot's state (C2b.5.2), so it follows the skip.
Corrupt and withheld replica evidence never restore the consumed payer note
from an older checkpoint. These are concrete failures of conditional progress,
not demonstrations that the finalized payment has been reversed.

The model uses ideal signed objects and proof tokens. It does not implement a
fault-certificate byte format or prove that an interior history event can be
authenticated cheaply. The proposed remedy must establish those facts and
must also explain delayed fault evidence, a prior valid prefix, recovery
publications at their own index, and descendant adoption.

The [fault-recovery proposal](POOL_FAULT_RECOVERY.md) compares intrinsic
exclusion, prospective fault publication and venue-side validation, and
records what `model/pool-fault.ts` shows for the intrinsic candidate; no
candidate has been selected as a normative rule.

## Venue publication sizes, offline

An offline probe under `scratch/ergo-publication/` (Fleet SDK `@fleet-sdk/core`
0.12.0 and `@fleet-sdk/serializer` 0.11.0, no node contacted, nothing signed)
verified the venue constants against upstream source and measured serialized
sizes. At ergo `v6.1.5` with sigmastate-interpreter `v6.0.6`: `MaxBoxSize` is
4,096 bytes and `MinValuePerByte` defaults to 360 nanoERG, both checked against
the full box bytes including the 32-byte transaction id and index; the mempool
`maxTransactionSize` is 98,304 bytes. With one payload chunk per box in `R4` and
a 36-byte object header in `R5`, the largest chunk that fits a box is 3,978
bytes. A 20,000-byte release publication (the 14,656-byte proof plus about
5,000 bytes of statement, signatures, acceptance and two non-membership proofs)
needs 6 outputs in a 20,724-byte transaction carrying at least 0.00745 ERG at
the minimum value per byte, plus the conventional 0.0011 ERG fee; a release and
a demand together (35,000 bytes) need 9 outputs and 35,980 bytes. The
non-membership proofs left the release on 2026-09-09 (C3.6), so a release is
now about 15.5 KB in four chunks; the chunking arithmetic above is unchanged
and still bounds the larger case. Every case is
well under the mempool limit. Not established: node acceptance, a real
signature, fee policy, the votable parameter's current value, reassembly and
authentication of chunks against forged or reordered boxes, and retrieval
after the boxes are spent. The probe's script, notes and JSON stay in
`scratch/` and are reproducible with `npm install` there.

## Full-block commitment feasibility

The private [offline experiment](../experiments/ergo-range/README.md) checks
complete block transaction commitments before choosing an A8/A9 range source.
Run it on Node 24 with `npm run check:ergo:range` after the experiment's
separate pinned install. CI runs it on Linux and Windows. It adds no library
runtime dependency or exported verification API.

The source baseline matches the publication probe: Ergo node v6.1.5 at
[`c364664`](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/ergo-core/src/main/scala/org/ergoplatform/modifiers/history/BlockTransactions.scala),
sigma-state v6.0.6 at
[`ab0b15c`](https://github.com/ergoplatform/sigmastate-interpreter/blob/ab0b15ceb9d34f2ccd6e68e3e2a8aa27cd16a042/data/shared/src/main/scala/org/ergoplatform/ErgoLikeTransaction.scala),
and its scrypto v3.1.1 dependency at
[`70b3610`](https://github.com/ergoplatform/scrypto/blob/70b36102b2ed8f7a443cfc92f9f135665d777a37/shared/src/main/scala/scorex/crypto/authds/merkle/MerkleTree.scala).
Fleet serializer 0.11.0 is pinned to
[`7d06847`](https://github.com/fleet-sdk/fleet/blob/7d06847afea124c5fdc71c0e8d813db0a1791978/packages/serializer/src/serializers/transactionSerializer.ts)
and npm integrity hashes in the experiment lockfile. These are selected
research baselines, not a claim to cover every node or future block version.

Transaction IDs hash the canonical transaction with empty spending proofs.
For block version 1, Merkle leaves are the transaction IDs alone. Later
versions in the node use all transaction IDs followed by all witness IDs.
Each witness ID is Blake2b-256 of the concatenated input proof bytes with its
first byte removed: 31 bytes, as fixed by
[the node transaction implementation](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/ergo-core/src/main/scala/org/ergoplatform/modifiers/mempool/ErgoTransaction.scala).
The leaves are neither pairs nor interleaved. Merkle leaf/internal prefixes
are 0/1; a missing right sibling contributes zero bytes, and a single leaf
still has an internal parent. The
[node types](https://github.com/ergoplatform/scrypto/blob/70b36102b2ed8f7a443cfc92f9f135665d777a37/shared/src/main/scala/scorex/crypto/authds/merkle/Node.scala)
fix those details. Secondary discovery material described a conflicting
paired-leaf construction; the probe follows the pinned source instead.

The retained [result](ergo-range-verification.json) has 342 passing assertions:
three public mainnet block fixtures at heights 100000, 1000000 and 1500000,
versions 1/3/3, 24 transactions and 65 outputs. Their raw JSON totals 138,228
bytes; reconstructed signed transactions total 14,450 bytes, excluding block
section framing. The fixture manifest records source URLs and SHA-256 pins.
These blocks are separated in height and were acquired from a public node;
their headers have not been independently authenticated. No network request
is needed to repeat the checks.

All 24 computed transaction IDs and all three roots match the fixtures.
Controls remove and duplicate every transaction, swap adjacent transactions,
mutate every output value and input-proof evidence, and check competing root
algorithms. Version 1 explicitly retains the same root after proof mutation.
Node 24's JSON source-text reviver retains amounts above JavaScript's exact
integer range without rounding.

**Parser result:** only 11 of 24 transactions round-trip through Fleet's
decoder. The other 13 fail on valid fixture scripts without a size flag;
every sampled block contains at least one such transaction. Expected failure
positions and messages are pinned so new failures cannot count as success.
A small counterexample moves one creation-height byte into a claimed raw
ErgoTree field: two different JSON field assignments serialize to identical
unsigned bytes and transaction IDs. Thus serializing arbitrary node JSON and
checking its root cannot authenticate the claimed output fields. Separate
finite controls show a short byte read advances past the buffer and an empty
integer read returns zero. The
[SDK reader](https://github.com/fleet-sdk/fleet/blob/7d06847afea124c5fdc71c0e8d813db0a1791978/packages/serializer/src/coders/sigmaByteReader.ts)
also allocates arrays from decoded counts. The probe only decodes hash-pinned
fixtures; it is not a safe parser for hostile bytes.

The next source gate is a complete, bounded canonical transaction decoder,
then a contiguous-range reader against externally authenticated headers.
The [binary decoder experiment](#full-binary-decoder-feasibility) below closes
the observed fixture coverage gap but leaves resource isolation and supported
node equivalence open. An unsupported transaction anywhere in the range
prevents an absence verdict.
Consensus, chain selection/finality, exact output extraction, resource refusal,
same-height publication order and admission of held commitments remain open.
No runtime source has been selected and no C2.10.13 completeness claim follows
from this probe. Raw venue outputs would still need existing signature,
sequence and authority checks before acquiring protocol force.

## Full binary decoder feasibility

The same private experiment now evaluates `ergo-lib-wasm-nodejs` **0.28.0**,
the npm stable version observed on 2026-09-09. npm associates it with
sigma-rust [`635bbaca55a27d6dd6b2c0ee2479b6ed60117780`](https://github.com/ergoplatform/sigma-rust/tree/635bbaca55a27d6dd6b2c0ee2479b6ed60117780).
The lockfile pins package integrity; the [retained report](ergo-decoder-verification.json)
also hashes the installed WASM and corpus sources. This is package metadata
provenance, not an independently reproduced build or a maintenance guarantee.

Fleet serializes only the existing hash-pinned fixtures. Sigma-rust parses
those signed binary transactions, reserializes them, and exposes fields only
after exact byte equality. It recovers all **24 transaction IDs and 65 output
IDs**, values, scripts, token order/amounts, registers, creation heights,
transaction references and indices; input proofs/extensions and data inputs
also match. This includes the 13 transactions Fleet cannot decode. Numeric
fixture ingestion remains lossless above `2^53`; comparisons use `bigint`.

The report retains **14,874 assertions**, including rejection of all **14,450
proper prefixes**. For each transaction, the raw parser accepts a trailing
zero byte and an overlong input-count VLQ; the exact byte round trip rejects
both. For each output position, moving a creation-height byte into the claimed
JSON script produces identical signed bytes, but binary extraction recovers
the original committed fields. Forged claimed transaction/output IDs are
ignored and recomputed. These controls establish observed behavior, not a
proof of parser equivalence with the node over every valid transaction.

The fixed corpus runs in a separate process with a **30-second deadline** and
**1 MiB output cap**. It refuses fixture files above **256 KiB** before reading
and transaction buffers above **64 KiB** before entering WASM; the largest
fixture transaction is **2,163 bytes**. These are experiment budgets, not
network consensus limits. A failed, timed-out or oversized run yields
unresolved evidence, never a successful absence verdict. **There is no hard
process/WASM memory limit** and no adversarial depth/allocation exhaustion
test. Input size, reserialization and a process deadline do not establish
bounded memory use; this slice does not pass that part of the source gate.

The pinned [generic parser](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergotree-ir/src/serialization/serializable.rs)
returns after `sigma_parse` without checking cursor exhaustion, explaining
the accepted suffix. More consequentially, the
[sized ErgoTree parser](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergotree-ir/src/ergo_tree.rs)
allocates `vec![0u8; tree_size_bytes as usize]` from a decoded `u32` before
reading that many bytes, without a local pre-allocation cap. A small input
budget therefore does not bound this allocation. Per-field count bounds in
the [transaction parser](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergo-lib/src/chain/transaction.rs)
do not supply a parser-wide resource budget. The exhaustion case is source
evidence only; the finite corpus deliberately does not execute that allocation.

Next, compare an OS-contained decoder with a local validating-node boundary,
including hard memory/CPU limits, hostile depth/counts, refusal semantics and
compatibility with the selected node. Canonical round trips can conservatively
refuse node-valid noncanonical encodings; they must not turn that refusal into
an omission. Only then connect a complete contiguous range to independently
authenticated headers and stable transaction/output order. A8/A9, chain
selection/finality, build provenance and publication admission remain open.
No runtime API, venue profile or protocol rule changes in this experiment.

## Venue and restoration work still required

A separate venue publication experiment must publish a complete recovery publication through
a pinned node, including chunk framing, canonical reassembly, duplicates,
incomplete publication and retrieval after boxes are spent. No transaction
acceptance result is claimed yet.

The restoration experiment must specify receiver-only spending authority,
authenticated encrypted openings, deterministic retry, seed-based discovery
and a complete independently retrievable evidence package. Merely adding
ciphertexts or serving public inputs without proofs is not that package.
