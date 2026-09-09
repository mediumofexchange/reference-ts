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
no reliance graph. Fee shape remains open. [The delivery contract](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md)
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

## Venue and restoration work still required

The next venue experiment must publish a complete recovery publication through
a pinned node, including chunk framing, canonical reassembly, duplicates,
incomplete publication and retrieval after boxes are spent. No transaction
acceptance result is claimed yet.

The restoration experiment must specify receiver-only spending authority,
authenticated encrypted openings, deterministic retry, seed-based discovery
and a complete independently retrievable evidence package. Merely adding
ciphertexts or serving public inputs without proofs is not that package.
