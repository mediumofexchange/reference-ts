# Current work

Updated: 2026-09-05

## Goal

Deliver the approved release contract and real private-payment experiment,
then define consolidation into one product with privacy and public supply
verification. The transparent pilot is an integration harness.

## Status

- Slice complete, independently reviewed and verified; local commits only.
- Implementation: `research/private-payment-architecture`, based on `f8eea32`.
  Companion spec: `spec/private-payment-architecture`, commit `edbc3f3`.
  The supported transparent implementation still pins normative `c3f4b0f`.
- [Release contract](docs/PRODUCTION_REQUIREMENTS.md) and
  [architecture/consolidation](docs/PRIVATE_PAYMENT_ARCHITECTURE.md) define the
  single product and the components to retain, replace or retire.
- [Real-proof experiment](experiments/private-payment/README.md) implements
  shared issue/spend/burn note rules, SQLite admission, receiver checks and
  public-history audit. It is excluded from the shipped package.
- Companion non-normative `private-payment-research.md` states exact relations,
  public input/signature layouts and production gaps. No normative claim of
  a private evidence setting or production deployment is made.
- No push, merge, publication or PR authorized.

## Evidence

- Final `npm run check:privacy`: 8 journal tests, 9 actual ZK proofs and all
  38 named checks passed on Windows / Node 24.6.0. Includes valid unaccepted
  roots, repeated commitments, new-anchor double spending, process death,
  exact retries, public-only supply replay, prefixes and alternate histories.
- Found and fixed a checkpoint gap: identical note roots can hide different
  spent sets. Configuration-seeded ordered statement hashes now bind history;
  independently reviewed and exercised with two valid conflicting histories.
- [Measured run](experiments/private-payment/results/2026-09-05-windows.json):
  proofs 14,656 bytes, proving 1.1-1.7 seconds, warm verification 96 ms,
  peak process RSS 559 MiB; fresh setup including download 29.8 seconds.
- Final `npm run check`: 50 files / 1,000 tests passed (81.03 seconds), plus
  docs, types, build, installed-package and process-crash pilot checks.
  An initial runner-discovery conflict was fixed: the research Node tests run
  under `check:privacy`, separately from the supported Vitest suite.
- Independent circuit/host/journal review and focused checkpoint-fix review
  completed. Disposable probes and generated scratch artifacts removed.

## Next

1. Specify private evidence identity, immutable circuit/version policy and
   finality assumptions in the normative protocol.
2. Build one durable wallet/operator path with private note delivery, invoices,
   restore and bounded multi-input payments; move the useful pilot/experiment
   tests and retire their superseded public paths as replacements work.
3. Prove independent publication, availability and private redemption/recovery,
   and measure supported phones/browsers before allowing live deployment.
4. Push/merge/publication still require maintainer authorization.

## Open questions

- Research backend selection is provisional, not production crypto approval.
  Setup trust/distribution, phone/browser performance and audits remain gates.
- Caller-pinned history does not supply global freshness or independent finality.
  No authenticated checkpoint service, replication or hostile-operator recovery.
- No production note delivery/backup, metadata protection or multi-input shape.
- Signed transparent backing names are research asset mappings only.
- Returning notes to the issuer preserves supply; burn is separate. Full
  demand/accept/release and external performance are outside this experiment.
