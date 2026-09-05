# Private-payment feasibility experiment

One executable acceptance experiment for the intended private product. It uses
real Noir circuits and ZK-enabled Barretenberg UltraHonk proofs. It is research
code, excluded from the package and its public exports; it is not a second
wallet, service or supported protocol profile.

Read [the architecture decision](../../docs/PRIVATE_PAYMENT_ARCHITECTURE.md)
and [production requirements](../../docs/PRODUCTION_REQUIREMENTS.md) first.
The experiment's own contract — relations, layouts, admission rules and
promotion blockers — is [RESEARCH.md](RESEARCH.md).

## Run

From the repository root, with Node.js 24:

```sh
npm ci
npm --prefix experiments/private-payment ci --ignore-scripts --no-audit --no-fund
npm run check:privacy
```

The experiment has its own pinned lockfile. Its dependencies are deliberately
absent from the shipped TypeScript package. The normal `npm run check` verifies
the supported implementation; `check:privacy` separately builds it, runs the
journal tests, compiles all three circuits and exercises actual proofs.

The first proof run downloads public setup parameters using Barretenberg's
upstream distribution. They are cached only in the ignored
`scratch/private-payment-crs/` directory, which may be deleted between runs.
Allow several minutes and approximately a gigabyte of available memory. A run
prints JSON with environment, compiler/verification-key identities, proof sizes,
timings, assertions and setup-file hashes. To save it, set `MOE_RESEARCH_REPORT`
to an absolute output path. No spending secrets are included in this report.

Temporary compiled projects, databases, request files and public evidence are
created under `scratch/private-payment-run-*` and removed after completion or
failure. Interrupted runs may leave that directory for manual cleanup.

## What the check establishes

Two signed research assets are issued, a holder privately pays another holder,
the receiver verifies its requested note and records one invoice acceptance,
the receiver transfers a note to the issuer, and the issuer burns that note.
Outstanding quantities end at A=60 and B=80. Returning a note to the issuer
does not change supply. This is not the full normative redemption protocol.

The check generates valid proofs under accepted and unaccepted roots, rejects
double spending even under a newer anchor, rejects duplicate commitments, and
exercises malformed witnesses, altered proofs, wrong contexts and issuer
authorization. Negative witness checks test actual circuit constraints;
positive cases generate and verify actual proofs. SQLite tests cover exact
retries and competing writers. Child processes die before and after commit;
saved requests recover the same accepted responses after restart.

A separate process receives only public configuration, artifacts, proofs and
a separately supplied expected root/count/history hash. It reconstructs supply and rejects
a valid but truncated prefix against that expected head. That head is supplied
by the test caller, not an independent witness. Replay cannot discover whether
an operator withheld a newer valid suffix without an authenticated reference.
The history hash also binds the ordered public statements: two histories can
create identical note-tree leaves while spending different earlier notes.
A valid alternate-history fixture checks that the audit rejects this substitution
even when its tree root and event count match the expected history.

## Code boundaries

`circuits/notes.nr` defines the shared note and membership relation. Issue,
spend and burn are separate entry circuits. `proofs.mjs` pins the backend,
field representation and verification keys. `host.mjs` checks authorization,
accepted roots, unique outputs, nullifiers and public supply. Its mutable
history instances are used sequentially; they are not concurrent server APIs.
`journal.mjs` is a bounded, crypto-agnostic persistence helper, not an admission
API: callers must validate proofs and bind the same configuration first.

The compiler runs in an isolated child process because Noir's source identifiers
need POSIX paths on Windows. That adaptation never runs in the payment host.
No `unconstrained` payment checks or simulated verifiers are used.

There is no production wire format, note-delivery protocol, wallet backup,
authenticated finality, checkpoint proof, replication, metadata privacy or
hostile-operator recovery here. The tree holds 256 leaves and the journal at
most 512 events. A zero-valued change output is inert padding. One input and
two outputs cannot implement general payments from accumulated notes.
The experiment must be promoted or retired once the production relation and
wallet path replace its acceptance purpose; do not extend it into a service.
