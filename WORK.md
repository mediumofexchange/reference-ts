# Current work

Updated: 2026-09-12

## Goal

Extend local wallet operation beyond the fixed acceptance invoice.
Acceptance: caller-selected invoices, digest-authenticated enrollment, verified
selection of up to two notes, exact durable payment retry, private delivery,
checkpoint-scoped status and receipt/change recording, followed by another pay.
Work: reference-ts/main; baseline 150fdbd (hosted CI 34704797024 passed).
The [operation profile](docs/POOL_WALLET_OPERATION.md) is under independent
design review before implementation. No new protocol or custody format.
Companion money-from-first-principles/main at 7ea0ee8 is unchanged; runtime pin,
v2 circuits and derivation are unchanged. This is a local application profile
under v2 sections 3 and 9, not protocol failure recovery or deployment.

## Status

- [Pairing profile](docs/POOL_WALLET_PAIRING.md): private per-wallet TLS keys,
  canonical invitations and independently authenticated full digests. Accepted
  bindings and credentials persist with complete encrypted offline exports.
- Rotation atomically changes generation/key and revokes capabilities. Servers
  bind their actual certificate and generation, including inside inbox commit.
  Payer sends check invoice terms, exact leaf and active custody before disclosure.
- Independent design/source review and narrow fix readback are complete. Resolved
  nonstring invoice IDs and self-issued certificate checks; no material finding
  remains within the local profile. Ordinary TLS accepts the hostile alternate
  leaf; exact pinning refuses it before HTTP application data.
## Evidence

- OpenSSL 3 provisions RSA-2048 keys/certificates through bounded private stdout,
  with no key staging file. Final helper passed 10 sequential and 8 concurrent
  generations after removing unreliable Windows named-pipe input.
- Abrupt-commit acceptance passed 22 exits and 22 fresh recoveries across eleven
  wallet operations, including rotation, invitation mint and pairing acceptance.
- Full npm check passed: 103 files / 1,863 tests, build, installed-package imports
  and all acceptance stages. Focused pairing suite: 12 passed. Final real-proof
  wallets passed both offline restores, rotation, retries and public audit to
  outstanding zero. Exports: payer 66,102 bytes, receiver 35,144 bytes. Exact source
  pins and review evidence: [wallet evidence](docs/pool-wallet-verification.json).
- Independent digest authentication is modeled through parent-owned IPC. A
  qualified human/device channel, protected storage and reachable endpoint remain
  deployment obligations. Latest recovery identity, one active restored copy
  and current binaries remain custody preconditions.

## Retained Ergo evidence; node stopped

- [Continuation report](docs/ergo-node-sync-resume-verification.json): bounded
  Ergo 6.0.5 / Temurin 21.0.12.1+1 restart stopped externally after 415,386 ms.
  Sampled headers reached 97,923; all sampled full heights were null. No applied
  history or ancestry claim. Automatic result unresolved; final worker checks
  were not reached. Independent owner cleanup found no surviving processes or
  mapping, established exclusive image access and matching GPT identity.
- Retain detached fixed 20 GiB image and actual reports:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete it or allocate another. ResumeSync's original configuration pin
  is spent; blindly repeating the one-time command will refuse admission.
- Native resume 56, disk 79, sync profile 25 and PowerShell resume 12 checks
  passed; read-only preflight passed. No unattended sync run is active.

## Next

1. Inspect hosted CI for the delivered main revision, then extend ordinary wallet
   operation beyond the fixed acceptance invoice:
   caller-selected requests, authenticated enrollment and payment/status commands
   using verified note selection. State the smallest supported flow before coding;
   preserve local custody and explicit unavailable evidence. Keep it local.
2. Continuous/device-loss recovery needs its own concrete custody boundary.
   Offline export cannot safely resume stale state after later wallet activity.
   Do not add C4 derivation or successor seed capsules to pinned v2.
3. CLI proof paths still need one segment/no imports. Extend selection from the
   verified forest only when a concrete multi-segment wallet flow requires it.
   Applied Ergo history/publication remains unestablished; more sync needs separate
   justification and exact ancestor/body checks against pinned upper IDs.

## Open questions

- Runtime recovery, authenticated evidence/publication, qualified device custody,
  continuous recovery and ordinary user operation remain the largest blocks.
- About **45% done / 55% remaining**, plausible done range **35–55%**. Transport
  lifecycle work reduces a wallet risk within this coarse uncertainty; no external
  witness, continuous custody or recovery gate is closed by local pairing.
- Use a fresh instance for the next ordinary-wallet flow: it benefits from fresh
  product context after
  this transport review. This is an efficiency judgment, not measured performance.
