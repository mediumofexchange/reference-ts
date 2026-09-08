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
no reliance graph. A fee-capable shape and authenticated note encryption are
candidate changes requiring specification; v2 cannot silently stand in for them.

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
a demand together (35,000 bytes) need 9 outputs and 35,980 bytes. Every case is
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
