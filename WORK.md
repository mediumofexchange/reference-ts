# Current work

Updated: 2026-09-04

## Goal

Implement the maintainer-approved smaller durable payment system and the
whole-project review's security, proof and workflow improvements.

## Status

- Implementation branch: `feat/durable-transparent-pilot`, after review commit
  `2762b3b`; security fixes `b019815`, directory format `1dfcc50`, pilot at HEAD.
  All work is local. No push, merge, publication or PR is authorized.
- Companion spec: `money-from-first-principles`, branch
  `spec/durable-transparent-pilot`, commits `5f1663d` and `c3f4b0f` (README pin).
  Site and org profile: `docs/durable-pilot`, commits `87a15b6` and `da7288b`.
- Backing identity, Ergo refresh serialization and mutable boundaries fixed.
  Independently reviewed, with regressions.
- Commitment v2 authenticates a sorted digest directory and selected logs.
  Authenticated absence differs from withholding; independently reviewed.
- Durable Node 24 SQLite store, local signing CLI, HTTP and payment checker
  implemented. Independent critical review findings addressed.
- Built-package process demo passes payment, crash/restart, exact retry and
  redemption. Package consumer install/import/signature check passes.
- CI and public docs updated. This implementation slice is complete and verified.
- See [pilot guide](docs/PILOT.md) and [review](docs/PROJECT_REVIEW_2026-09-04.md).

## Evidence

- Final `npm run check` on local Windows / Node 24.6.0: all 50 files / 1,000
  tests passed (98.61 seconds); docs, typecheck, build, installed tarball consumer
  and multi-process pilot passed. Initial surface-inventory failure was fixed
  by testing the pilot's explicit unavailable result alongside core refusal.
- Pilot passed, including process.exit(71) at applied,
  stored and committed; final balances Alice60/Bob0/issuer40, outstanding100.
- CI now runs the same gate on Ubuntu Node 20/24 and Windows Node 24; these
  remote jobs have not run locally. Node 20 explicitly skips the SQLite pilot.
- Independent critical reviews and final self-review completed; scratch clean.

## Next

1. Maintainer can run `npm run pilot:demo` with Node 24 and inspect the guide.
2. Next proposed slice: measure realistic pilot loads and define receiver invoice
   persistence before adding independent witness publication or more profiles.
3. Push/merge/publication require separate maintainer approval.

## Open questions

- Pilot trusts the cohosted local witness; no hostile-operator recovery or
  independent witnessing. External publication needs signer reservation/outbox.
- Journal is bounded at 10,000 commands and one root. Checkpoints and realistic
  load measurement remain future scaling work.
- Database rollback/copies and loss of key/history are outside recovery scope.
- Payment checker proves inclusion, not invoice freshness. Receiving apps must
  durably deduplicate fulfillment. No merchant checkout app is included.
- This work includes independent defensive review, not an external security audit.
