# Conformance read of lit-v1 for adoption, 2026-10-07

Read the companion specification's `lit-v1.md` at `a554f8a` against reference `c7418b8`: `src/lit/`, the shared seams lit
runs through (`pool/evidence-chain.ts`, `pool/v3/construction.ts`, `state.ts`, `recovery.ts`, `dishonour.ts`, the
`scope-reader.ts` answers path, `non-service.ts`, `trail.ts`, `terms.ts`, `keys.ts`, the `store.ts` submit path and the
wallet-store accept path), `test/lit-*.test.ts` and `test/fixtures/lit-v1-vectors.json`. One fresh, read-only reviewer did
the read, after the [read of 2026-10-06](2026-10-06-lit-v1-conformance-read.md) and the changes since (M14e–M14g5b, the one
evidence chain). It gates the [adoption decision](../2026-10.md#2026-10-07--adopt-moelitv1-with-9s-configuration-reading-the-contracts-in-the-text-pool-v3-fixes-slice-14-m14h).

**Result:** adopt after text-only fixes. No place where code and text disagree on a byte or a verdict.

**Run:** a script recomputed every vector from the text with node:crypto and noble Ed25519 alone (no reference code),
0 failures; the contexts are prefix-free (the only prefix pairs are the length-prefixed construction strings in terms,
not hash contexts); `npx vitest run test/lit-*.test.ts`: 8 files, 89 tests passed.

**Recomputed and equal (text = code = vectors):** configHash `17835aa2…77c1`; statement prefix 53, bodies 136,
34+104k+72m, 42+104k+72m, 81+104k, 64, 96, 112; acceptance 125, release 146, settle authorization 200, kind-2 body 253,
publication fixed part 91; publications demand (k=2) 569/478, acceptance 344/253, release 448/357, withdrawal 280/189,
request 328/237; records withdraw 189, request 237, issue 261, settle 357, largest spend 719 (statement 583); every vector
record with its outputs' opening, cm, nf and tag and every signature (issue by K, the settle's three, owners in input
order); snapshot 163, receipt 194 (record 290); the spent root by an independent pool-spent C1.2.8 implementation;
history and evidence chains over four steps; fault evidence 244 fixed bytes, authenticating to the snapshot; header 126,
262 to 8,913,022; trail 28 with its 8200-byte record bound; target field bound 4096; package 22 + Σ(9+len); terms at most
1296 (vector 253 bytes, tags 2–6); `ownerSecret`, `acceptSecret`, `presentSecret` for two inputs and one (zero `tag_2`).

**Verdict rules read against code, none diverging:** §7 common checks (context, scope, backing, repeated statement, input
liveness, distinct unspent nullifiers, fresh outputs, the adopted block's binding); issue (K from the terms, supply bound,
revocation); spend and burn (arithmetic, owner signatures in input order, locks; burn within outstanding); demand (one
backing, sum a `u64`, tags, locks, door times at admission and force only); withdraw (presenter over the statement);
settle (standing demand, quantity, acceptance deadline, K's, the owner's and the presenter's signatures, door deadline,
tags, locks but its own, output derived from the demand's nullifiers); force (inputs the snapshot's outputs, both
acceptance signatures, TAKEN unreachable behind SPENT); C3.8 (published and release-carried acceptances, both signatures);
request (owner signature and output, then the pool's spent-tag and lock checks); §6's split rule (`MALFORMED` for a record
that splits but does not decode; one that does not split stays unresolved); compact exclusion; §9's terms table; the
trail's skipped oversize terms field; lit's pre-copy fault-evidence bound as a local limit.

## Findings and disposition

- **Major: the contracts' revision was unpinned.** §1's "as pool-v3 reads them" read either as pool-v3's pinned text or
  the contracts' current text; a later version's amendment would change lit verdicts under the second. No contract file
  changed between `e7f7f24` and `a554f8a`. Taken: lit-v1 §1 reads the text pool-v3 §1 fixes. Noted: Construction's own
  numbered rules are unpinned for both constructions.
- **Minor: venue-ergo §1 did not name lit.** It admitted pool-v3 and constructions with kind 1–3 records only, so a strict
  reader might refuse lit terms naming an Ergo venue; verdicts are identical since §6 attributes kind 4 by location and
  shape. Taken: a no-verdict correction to venue-ergo §§1, 8.
- **Minor: transitions the vectors leave to oracle tests:** a settlement's nullifiers in the spent root, a demand or
  withdraw step keeping a non-empty root, an opening's root over an imported closure, fault evidence at position 1, and
  wallet vectors not tied to record vectors. Recorded as a limit; the fixture's revision label moves at adoption.
- **Nits:** §7's "two equal signatures" for a K-owned acceptance could split verdicts for a hedged signer (reworded; the
  code verifies each); §3's replay "whatever its signature bytes" while the store decodes first (reworded: the
  authorization has its kind's length); §1's prefix rule against a moving set of contexts (bound to later declarations).

**Not covered:** the service wire and CLI lit paths (lit-v1 fixes neither), the wallet's window and restoration logic
beyond its derivations, the M14e kept-state residuals, real-proof checks and fuzzing beyond the vectors.
