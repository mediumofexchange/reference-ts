# Current work

Updated: 2026-09-12

## Goal

Conditional successor local replay now verifies real issue/spend/burn proofs,
issuance signatures, header-derived scope, accepted anchors, new outputs,
compressed spent roots, bounded totals and the terminal history/snapshot.
Fresh seedless audit and receiver processes agree on the replayed public state;
the receiver reconstructs change and a local membership path from seed/public
bytes. All results remain unspendable with unresolved full authority/currentness.

Implementation branch feat/successor-local-replay starts at main e983f67.
Companion money-from-first-principles/main stays 60f380c; normative content
7ea0ee8. No normative, runtime, circuit, key, dependency or configuration change.
Review and final acceptance passed; authorized delivery remains to complete.

## Status

- [Initial-segment experiment](docs/POOL_DEPLOYMENT_PROBES.md#conditional-initial-segment-replay):
  issue 10, pay 7/change 3, burn 5/change 2. Public outstanding is 5; payer and
  receiver recover 3 and 2 respectively. Local paths reproduce the final root.
- Every proof is verified under independently selected fixture keys. Supply,
  roots and history derive from records, not issuer totals. Wrong proof/key,
  signature, snapshot, spent input, output reuse, unaccepted anchor and scope
  refuse without partial audit/candidates. Repeated reads agree; repeated
  records refuse. Historical and missing evidence retain explicit limits.
- Full package requirements are tabulated in the experiment guide. Synthetic
  domain, issuer key/terms, initial empty-opening force and checkpoint selection
  remain fixture assumptions. No adopted v3 config, authenticated current
  ranges, recovery/import/clock/revocation replay or certified spending anchor.

## Evidence

- `npm run check:pool:local-replay`: 17 groups and 8 real proofs passed on final
  code. [Report](docs/pool-v3-local-replay-verification.json) pins sources and
  bytecode/VK identities; worker checks locally retained key hashes before use.
- Independent actual-source review found SharedArrayBuffer aliasing through
  structuredClone. The real-proof regression failed before the fix: a wrong
  shared issuer key changed during verification and was accepted. Shared key,
  seed and domain buffers now refuse before verifier calls; independent readback
  and lightweight checks passed. No unresolved material findings remain.
- Existing `node scripts/pool/delivery/evidence-check.mjs`: all 14 groups passed
  after extracting seedless local evidence authentication. Its retained source
  report is refreshed. Final docs and diff checks passed; delivery remains.
- Reuse unchanged full/runtime/real-proof baseline e983f67: all seven hosted
  CI jobs passed, run 34716395928, verified this session. New replay command
  runs after existing conformance in both v3 CI jobs. No production code changed.

## Existing local product and custody boundary

- Configured v2 supports one constant-payout backing, real-proof local payments,
  private delivery and independent public audit. Venue/digest authentication
  are locally modeled. No real funds or host controls changed.
- Offline handoff freezes the source and binds one exact destination. Mark the
  paper export historical before activating the matching unfrozen restore;
  lost replies stay with that destination. Old exports cannot resume after
  activity. Active-device loss/continuous recovery remains open.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): automatic preflight
  fail; directory ACL refused, BitLocker/PIN and Secure Boot unavailable.
  Physical theft, cross-account, power-loss, backup isolation and continuous
  recovery qualification need separately authorized test hardware/provisioning.

## Retained Ergo evidence; node stopped

- [Continuation report](docs/ergo-node-sync-resume-verification.json): Ergo 6.0.5 /
  Temurin 21.0.12.1+1 restart stopped externally after 415,386 ms. Sampled headers
  reached 97,923; full heights null. No applied history/ancestry claim; automatic
  result unresolved. Cleanup found no workers/mapping; exclusive image access and
  matching GPT identity were established.
- Retain detached fixed 20 GiB image:
  scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd.
  Do not delete it or allocate another. Original ResumeSync pin is spent; blind
  repetition refuses. Native resume 56, disk 79, sync profile 25, PowerShell
  resume 12 checks and read-only preflight passed. No sync run is active.

## Next

1. Complete authorized delivery, verify remote main parity and latest hosted CI.
2. Resolve the v3 configuration/terms declaration boundary: configuration frame,
   six artifact/key identities, delivery profile and backing evidence encoding.
   Keep declaration disabled until all adoption prerequisites hold. Independently
   review/commit normative gaps before code; then replace fixture key/term inputs.
3. Build authenticated record-range and complete replay integration against the
   documented package checks. Device qualification and external publication
   remain separate dependencies; do not alter this workstation's controls.

## Open questions

- Reassessed 2026-09-12: roughly **50% done / 50% remaining**, plausible done
  range **40-60%**. Real successor local replay is reusable progress; it does
  not materially change this coarse estimate while authority/recovery gates remain.
- Largest blocks: runtime recovery, authenticated configuration/evidence and
  publication, qualified custody/continuous recovery and supported user operation.
- Switch to a fresh instance for configuration/authority design. The next work
  changes protocol declarations; the handoff isolates the replay evidence and
  prerequisites from this proof-tooling context. Not a measured model comparison.
