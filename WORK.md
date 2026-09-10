# Current work

Updated: 2026-09-10

## Goal

Delivered slice: dedicated validating-node preflight on `docs/ergo-node-preflight`,
based on `4b11830`. Acceptance: pin and inspect the artifact/source, check
validation/history/API/wallet settings, declare finite resource envelopes and
identify a reviewed next step. No node extraction, installation, execution or
sync; no normative/runtime change. Companion `money-from-first-principles`
remains `main` at `7ea0ee8`.

## Status

- Baseline CI [34439509449](https://github.com/mediumofexchange/reference-ts/actions/runs/34439509449)
  passed at `4b11830`; upstream fetched without intervening commits. No branch
  protection or rulesets; no safeguards changed.
- The [preflight](docs/ERGO_NODE_PREFLIGHT.md) finds that stock v6.1.5 always
  starts the wallet actor and mounts authenticated wallet routes. An empty,
  uninitialized wallet has no spending key but is not disabled wallet service.
  No fake configuration switch or silent relaxation was introduced.
- Resource envelopes are declared, not enforced or sufficient for sync.
  The node/service boundary and supervisor remain unselected/unimplemented.
  Independent source/claim review passed after correcting the prerelease label.
  Local docs and cross-repository links pass; final commit CI is pending delivery.

## Evidence

- Prerelease v6.1.5 resolves to fixture source `c36466405abc9a2ddda37e890635f00d593041f5`.
  One bounded archive download: 179,682,635 bytes in 51.175424 seconds;
  measured ZIP and embedded JAR SHA-256 match the release asset digests.
  The archive has 192 entries, 202,691,057 uncompressed bytes and declares
  bundled Java 21.0.1. No executable ran; no reproducible-build claim.
- Artifact inspection declared 192 MiB transfer / 256 MiB scratch, 300 seconds,
  8 MiB/s, at most 1 MiB per text entry; binary JAR hash streamed in memory.
- Host has about 16 GiB RAM, four logical processors and 497 GiB free disk.
  Host Java is Oracle 8u481; the bundled Java avoids that dependency. WSL2 is
  configured but its controls are untested; Docker was not found on PATH.
- Pinned config/source distinguish transaction verification, history retention,
  bootstrap, API auth and mining settings. Mainnet, genesis validation and
  fully validated chain membership need effective startup/sync evidence.
- The old decoder [cost profile](docs/POOL_DEPLOYMENT_PROBES.md#decoder-cost-and-host-overhead)
  remains unchanged: 23/24 transactions at 10 million fuel; the separate
  100-million diagnostic resolves cost, not the original refusal or containment.
  Its code checks passed at baseline (96 files / 1,795 tests plus integration
  checks); docs-only preflight does not require repeating runtime tests.

## Next

1. Check CI for the delivered preflight commit. Local docs/cross-repository link
   checks and independent source/claim review passed; disposable archive/source
   inspection files were removed after evidence capture.
2. Resolve the service boundary with independent review: prefer the stock node
   with no spending keys and an authentication-isolated uninitialized wallet
   if it preserves the invariant; compare minimal source omission if literal
   actor/route removal is necessary. This is an experimental requirement choice,
   not a production dependency decision. See the preflight's falsifier/costs.
3. Implement a fixed-purpose offline startup supervisor, verify resolved config,
   listeners, resource controls, no outbound traffic and whole-job cleanup.
   Do not reuse the failed exact-CPU decoder result as passing node containment.
4. Only after enforcing the disk/network/resource envelope, measure a finite
   sync. Compare all 24 fixture transactions, 65 output fields/IDs, order and
   roots, with ancestry to a captured fully validated tip. HTTP success or
   matching fixtures alone cannot establish validation or chain membership.
5. Authenticate contiguous ranges/publication order, then replay/adoption,
   openings and certificates; see [recovery map](docs/POOL_V3_RECOVERY_MAP.md).
   Fix v3 configuration/artifact pins, integrate v3 runtime and wallet, and
   rerun the six real-proof relations.
6. Continue with Astra in this instance for the next boundary decision and
   supervisor design. Context remains focused; native resource controls and
   wallet isolation need strong review. Reassess a cheaper instance once work
   is routine measurement/fixture integration; no comparative benchmark exists.

## Open questions

- Windows exact CPU containment remains failed; node memory/CPU/disk/network
  controls are not yet demonstrated. Full genesis sync cost is unmeasured.
  Runtime remains v2, rejects silence clauses and has no pool wallet.
- About **45% done / 55% remaining**, plausible done range **35–55%**. This
  preflight does not close a product gate. Largest work: evidence/replay/config,
  v3 runtime, wallet/transport, authenticated ranges, witness publication and
  custody assurance.
- Deployment, public releases, access changes and real funds remain outside
  standing authorization.
