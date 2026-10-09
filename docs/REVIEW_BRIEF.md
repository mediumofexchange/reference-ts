# External security review brief

What an external reviewer of `@mediumofexchange/reference` needs to begin: what to review, how to reproduce every
retained report, which findings are already known and how each is dispositioned, and what is out of scope. It is the
last item of the [release gates](PRODUCTION_REQUIREMENTS.md#release-gates)' security review (WORK.md slice 19 M19b).
Commissioning the review lies outside this repository.

## What to review

- **The [security argument](SECURITY_ARGUMENT.md).** It states five claims (supply, payment soundness, payment
  privacy, holder authorization, compartmentalized failure and recovery) and lit notes' claims, over sixteen
  assumptions A1–A16. Each claim names the rules it reads and the code that holds them. An error in the argument is a
  finding, as is a claim the code does not hold or an assumption the argument leaves out.
- **The code at one commit.** Review the commit this file is read at, named by its
  [release record](RELEASE.md): CI's `release-record-ubuntu-latest` and `release-record-windows-latest` artifacts for
  that commit, which its `reproducible-release` job compares. The release's constructions are `moe/pool/v3` under its
  one adopted configuration (pool-v3 §11.4) and `moe/lit/v1`, on the Ergo venue profile.
- **The specification it implements**, in
  [money-from-first-principles](https://github.com/mediumofexchange/money-from-first-principles): Construction,
  pool-v3 and venue-ergo at `e7f7f24`, lit-v1 at `80a4ea1` (later commits there change no byte, identity or verdict of
  these). Later pins of single rules (pool-v3 §14 at `dc51baf`, C2.4.1/C2.7.5 at `25c078e`, C3.5 at `114799e`) are in
  [protocol rules](PROTOCOL_RULES.md), which maps each rule to its code and to the test that fails without it.
- **Sensitive areas, in the argument's order:** the six Noir relations (`scripts/pool/v3/circuits/`) and their
  boundary in `src/pool/v3/{records,state,recovery,non-service}.ts`; the state machine and readers
  (`src/pool/v3/{state,reader,scope-reader,package-reader,replay-store}.ts`); the operator journal (`store.ts`); the
  wallet's custody (`wallet-store.ts`, `holdings.ts`, `wallet-backup.ts`, `src/cli/wallet.ts`); the Ergo header
  verifier and view (`src/ergo-headers.ts`, `src/ergo.ts`, `src/ergo-store.ts`); signatures and key files
  (`src/keys.ts`); the proving-parameter loader (`src/pool/{parameters,parameter-files}.ts`, A3); delivery capsules
  (`src/pool/v3/capsules.ts`); the lit construction (`src/lit/`).

## Reproducing the reports

On Node 24.21.0 or later (CI uses Node 24 and records its exact version in the release record), from a clean
checkout of the commit:

```
npm ci
npm run build
node scripts/pool/prepare-crs.mjs
```

The last command fetches the Ignition proving parameters into `scratch/private-payment-crs/` and checks each file's
SHA-256 against the manifest the runtime holds (A3). Then:

| Command | Shows | Writes |
|---|---|---|
| `npm run check` | Documentation and links, typecheck, the unit suite, build, and `check:scripts`: compiled relations equal their sources, the package and its install, the Ergo view's persistence, wallet and journal crash recovery, the service, the synthetic node against recorded node answers, testnet transfers offline, and the lit command drill over a fixture Tor proxy with stand-in onion names | `scratch/release/` (the release record) |
| `npm run check:pool:v3 -- --ergo` | Every real-proof check in order (`scripts/pool/v3/real-proof.mjs`): the six relations' conformance and mutations; the journal with real proofs on the synthetic Ergo chain; the history store locally; recovery, succession, scope and redemption stores, each locally and on the synthetic chain; the pool command drill (every party from its own install); local replay with its Ergo adapter | Nine of the twelve current `docs/pool-v3-*-verification.json` reports directly; the conformance, journal and local replay checks write `scratch/pool-v3-results.json`, `pool-v3-store-results.json` and `pool-v3-local-replay-results.json`, retained as `docs/pool-v3-conformance-`, `store-` and `local-replay-verification.json`. The committed reports are copied from CI's merged `pool-v3-reports-ubuntu-latest` artifact; a local run overwrites the nine `docs/` reports, so compare with `git diff` |
| `npm run check:evidence` | Lists each retained report whose recorded source hashes differ from this checkout (informational, exit 0): after the build the twelve current reports match; the live testnet drill's report is history and drifts | — |
| `node scripts/release.mjs --verify <dir> <record>` | That an install is the record's tarball and lock ([installing](RELEASE.md#installing)) | — |

CI runs `check:pool:v3` in five parallel groups (`--group history|stores|redemption|drill|replay`, about twelve
minutes each on its runners), so a serial run takes roughly their sum; leave at least 4 GB of memory free. A report names
its specification pin and the SHA-256 of every source it binds (the conformance, journal, history and local replay
reports also their environment); compare yours with the committed
one by its checks and verdicts, since times and memory differ. The live testnet command drill (`command-drill.mjs --testnet --authorized-testnet`) needs
the project's own synced testnet node and funded testnet wallet, so its report
([`docs/pool-v3-command-testnet-verification.json`](pool-v3-command-testnet-verification.json)) is evidence to
read, not to reproduce.

## Known findings and their disposition

- **Deferred review findings** are lettered in WORK.md Next 4 at the commit, each with the trigger that reopens it
  (performance, replica availability, a later profile, mainnet, tooling) or accepted with its reason; the
  [M13g decision](../decisions/2026-10.md#2026-10-08--judge-lapse-before-the-readers-own-snapshot-serve-every-forks-trail-and-disposition-the-rest-of-next-4-slice-13-m13g)
  dispositioned every letter open before it. Two bear on the argument:
  - **(bh)**, A15: the commitment's signed message names no venue, so one operator key on two venues lets anyone
    copy its commitments between them ([open items](SECURITY_ARGUMENT.md#open-items-this-argument-found)).
  - **(bg)**: a kept read discarded for good reason (a new code version, a damaged file) is replayed whole inside an
    admission's turn, which at scale can lapse a short silence window. Availability, not validity.
- **Internal audits.** One area per run by AI instances, recorded in the decision log (`decisions/`, search "audit") and
  the audit commits (`git log --grep audit`): shared encoding; the shared primitives with the retired v2 relations; v3
  records, codecs and evidence store; the range verifier; the Ergo node-JSON intake and header store as the venue uses
  it; the six relations; the state machine (`state`, `recovery`, the replay store's reads and append, `spent-set`,
  `capsules`, `verify-ahead`, the reader's trail replay); the neutral core, Ergo venue and publisher; the wallet and
  `cli/wallet.ts` custody; the service transport, replica and relay serving; the multi-backing and recovery readers;
  the lit runtime. Sensitive patches record their adversarial reviews in their decisions. These are AI reviews: they
  are not the independent review the release gate asks for.
- **Not audited as an area** (each slice's patches were reviewed): the operator journal and served trail
  (`store.ts`, `trail.ts`), the reader beyond its trail replay, `construction.ts`, `guard.ts`, `refusals.ts`; the Ergo
  header verifier's work and difficulty rules (`src/ergo-headers.ts`); the proving-parameter loader; `file-identity.ts`
  and `evidence-chain.ts`; the shared note tree, scope and schedule (exercised by real proofs only); the `moe` commands
  other than the wallet's custody and serving, the compiled-relation loader and key files (`src/cli/`,
  `src/pool/v3/{programs,verifier}.ts`, `src/keys.ts`); the replay harness and check tooling (`scripts/`); the Ergo
  experiments; the retained reports; and the specification documents (Construction, pool-v1/v2 layouts, authority,
  recovery and fault, pool-v3, spent, fees, delivery, venue-ergo, lit-v1), each reviewed when written.

## Out of scope

- Everything the argument [does not claim](SECURITY_ARGUMENT.md#what-this-argument-does-not-claim): the issuer's
  creditworthiness and payouts outside the claim layer, network anonymity (A13), availability of evidence and of the
  venue, denial of service beyond the declared budgets, and side channels on a holder's device.
- Mainnet: the guard refuses every venue but three reference ones ([where it runs](SECURITY_ARGUMENT.md#where-it-runs-today)).
- Qualified storage and custody drills, and operations at the design point's scale (measured separately in
  [deployment probes](POOL_DEPLOYMENT_PROBES.md)).

## What to report

For each finding: the rule or claim, the path and line, the trigger, the impact, and a reproducer or the evidence it
needs. Name the assumption it breaks where it breaks one. Findings are recorded and dispositioned in the decision log,
as internal ones are.
