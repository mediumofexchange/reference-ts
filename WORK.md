# Current work

Updated: 2026-09-24

## Goal

Open slice (branch `feat/profile-framer`, from Next 1): no decoder refusal can
deny a range. The candidate profile reads each transaction as its unsigned
bytes (id = their Blake2b-256) plus its 31-byte witness id, and the model
frames outputs itself under a small fixed grammar (sized trees by length,
exact P2PK and miner-fee trees, `Coll[Byte]` registers and extension values);
a transaction it cannot frame carries no record. Sections exist only for
block versions 1–4. Acceptance: decision + profile text; model, tests and
adapters (profile check, replay adapter/fixture, v3 ergo check, chain-cost,
publish) without the decoder on the reader's path; framer against the node's
own reading on the hostile corpus and real transactions; independent review;
merge. Stop: re-recording real-proof v3 reports stays Next 2.

## Status

- Code review pass (2026-09-24, merged): the verifier failures, contained
  decoder, pool runtime review fixes and the three decoder reports were
  reviewed again. Fixed: array-species aliasing in `PoolStore.activate`,
  `Segment.replay` and `copySegmentHeader` (a journal left unloadable, a
  segment identity changing after the copy), receipt checks of a second read
  (a receipt verifying under another segment), verifier options and contract.
- Merged and reviewed before it: hostile-input node equivalence (JDK in
  `scratch/jdk/`), [verifier failures](decisions/2026-09.md#2026-09-24--answer-false-only-for-malformed-proofs-and-never-verify-on-an-instance-that-threw),
  the [contained decoder](docs/POOL_DEPLOYMENT_PROBES.md#contained-decoder)
  (`decoder.mjs` stays the unmetered reference older reports bind), field
  equivalence over 314,028 retained transactions, A13 replay cost,
  served-trail prefixes (spec 786f962) and A10 latency; no depth selected.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, full headers, 127.0.0.1:9053) and testnet (archive + index,
  127.0.0.1:9052) from `scratch/ergo-nodes/`, both synced (5.4 / 17.5 GB);
  after a reboot or stop run `nodes.mjs start` and `watch 10` via WMI
  `Win32_Process.Create` (nodes started from an app's terminal die with it).
  Header source: `docs/ergo-own-node-verification.json`.
- Decoder pin: vendored reproducible release build of sigma-rust 2f840d3
  (`experiments/ergo-range/vendor/`); Rust 1.87 + wasm-bindgen 0.2.128 in
  `~/.cargo`, `scratch/rust-toolchain`, source cache `scratch/sigma-rust-src`.
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (~19,999.99
  tERG, copy outside the repository); testnet transactions need no further
  approval; sweep boxes back and spend only fees.

## Evidence

- [Hostile-input probe](docs/POOL_DEPLOYMENT_PROBES.md#hostile-input-node-equivalence): 159,397 cases, no same-id disagreement.

## Next

1. Reader denial by decoder strictness: sigma-rust refuses bytes the node
   reads (tree type checks, opcodes, value bounds, its own rewrites), so one
   such transaction, if block-valid (untested), denies the reader its
   block. Decide: a lenient framer for ids with full decoding only where
   the profile reads outputs, or a recorded denial limit. Also: the profile
   accepts every header version, equivalence is measured at block 4 only.
2. Evidence binding, at chain-cost's next re-record: move it to
   `contained-decoder.mjs`, fix `decoder.mjs`'s header comment, share helpers
   with the equivalence scripts. `check:evidence` checks only file-named keys,
   so no report binds `ergo_lib_wasm_bg.wasm` (the contained decoder pins its
   hash at load; `decoder.mjs`, used by the equivalence report, does not). That
   report (drifting on package.json) omits `model/pool-v3-*.ts`'s `src/`
   imports and `tsconfig.json`; `contained-range.mjs` binds no inputs. v3
   local-replay and replay-cost reports drift (`bytes.ts`, `scope.ts`): re-record.
3. Deferred review items: the contained reader decodes every block before
   header-id/height filtering (`replay-venue.mjs`), sets no per-read fuel or
   host-memory total, and its instantiation sits outside the refusal try;
   `inspectNotes`, replay's `statements.slice` and `activate`'s snapshots and
   history still read caller data twice (copies owned); a verifier throw in
   `submit` reloads the whole journal (a non-diverging refusal would not);
   retire the v1 store-codec path; shared v3 fixture/byte helpers; v3 harness
   verifiers reuse one instance.
4. Later: a Linux or CI reproducible build of the decoder pin; the note
   tree's Poseidon2 on Barretenberg wasm (about 6x); a warmed spare verifier
   instance if admission's ~1.1 s per malformed proof matters.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  venue/digest authentication are modeled. Offline handoff freezes the source
  and binds one destination; old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): preflight fails;
  qualified hardware, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority.
- The contained-sync node of 2026-09-12 is stopped. Retain the detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and verified
  parameter/tool caches. Do not delete the image or allocate another.
  [Sync handoff](https://github.com/mediumofexchange/reference-ts/blob/c85af7b/docs/ergo-node-sync-resume-verification.json): headers 97,923;
  full heights null/unresolved. The week's cached node responses
  (`scratch/ergo-chain/`, digest in the report), `scratch/sigma-alpha/` and
  the `scratch/sigma-0.28.0/` control can be regenerated; keep the cache.
  `scratch/equivalence/` (chunk and field reports the retained summary binds
  by hash) and its cache `scratch/ergo-chain-own/` reproduce the equivalence
  report offline; the node has since pruned their earliest blocks.
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and external publication
  remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-24: venue cost measured and small, P2 done on the testnet, the
decoder contained and parse-equivalent to the node on mutated inputs;
selection still needs an authenticated header source and an answer to
decoder-strictness denial. Runtime integration, selected venue/decoder,
qualified custody and continuous wallet operation dominate.
