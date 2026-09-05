# reference-ts

This repository is the executable reference implementation of the Medium of Exchange Protocol. Optimize for a working, simple, and secure protocol: choose the smallest design that is easy to audit, then make it fast enough. Security and protocol correctness take precedence over brevity or speed. There is no release deadline; a finished, working protocol is the deliverable.

## Sources of truth

- The normative specification lives in the companion `money-from-first-principles` repository. The README pins its implemented revision. If code and specification disagree, identify the exact conflict and fix or escalate the specification first.
- `WORK.md` is the current operational handoff. Replace stale status instead of appending a diary.
- `DECISIONS.md` is the index of durable design decisions. Read the index, then only the entries relevant to the work at hand. Session handoffs and review rounds are not decisions; they live unindexed in `decisions/archive/`.
- `docs/PROTOCOL_RULES.md` maps each binding rule to its specification rule, code and test. Load only the relevant rows when changing that mechanism.
- The implementation and tests describe behavior already built, but they do not override the specification.
- `scratch/` is disposable local evidence, not project memory.

At the start of a work session:

1. Read `git status`, the recent log, and `WORK.md`.
2. Read this file.
3. Follow only the specification and decision links relevant to the current goal.
4. Inspect the affected implementation and tests before changing them.
5. Verify any inherited claim that matters to the next action; do not trust a transcript alone.

## Scope and direction

The finished protocol's claim layer is the **shielded pool** (Construction §C1.2): ownership, amounts and histories hidden, supply proven at the pool's lit boundary. That is the production path this repository builds, rule by rule from Construction, in this order: specification first, then an executable adversarial model of the rules, then the pool's claim layer, then sequencing, recovery and presentation over notes, then the wallet, then the external witness venue's write side.

What the repository holds today:

- **Primitives that carry forward as-is:** canonical encoding and naming (`backing.ts`, `bytes.ts`, `keys.ts`, `contexts.ts`), commitments and their directory (`commitment.ts`), the venue interface and local venue (`venue.ts`), the durable command journal pattern (`pilot-store.ts`).
- **The transparent path, frozen:** `ledger.ts`, `sequencer.ts`, `presentation.ts`, `replacement.ts`, `recovery.ts`, `fault.ts` and their tests implement the transparent *profile* (Extensions). It is a differential oracle and a library of adversarial cases for the pool path. Do not extend it; port its cases as each rule lands over notes, and delete it when the pool path passes them. Two of its mechanisms are retired by the specification (`docs/PROTOCOL_RULES.md` marks them) and must not be ported.
- **The Ergo read-only venue adapter** (`ergo.ts`): kept as the venue direction, not exported from the root barrel, rewritten when the commitment format is final.
- **`experiments/private-payment/`:** the real-proof feasibility check for the pool, with its research contract in `RESEARCH.md`. Excluded from the package. It is promoted into `src/` when the normative statement layouts are final, and retired then.
- **The local pilot** (`docs/PILOT.md`): the transparent path across two processes with a trusted local witness. An integration harness that proves the protocol runs end to end; its transport and CLI go when a pool equivalent exists.

The release contract and consolidation map are `docs/PRODUCTION_REQUIREMENTS.md` and `docs/PRIVATE_PAYMENT_ARCHITECTURE.md`.

## Vocabulary

Use Construction's words in code, comments, tests, commits and decisions, and cite rule numbers (`C2.5.3`) rather than quoting paragraphs. No new metaphors in anything normative or binding: two readers, or two models, must not be able to disagree about one sentence. Earlier work used a private vocabulary; when you meet it, read it as:

| Earlier word | Meaning |
|---|---|
| seat | the operator's current link in the replacement chain, with the commitment it stands on |
| book | the served state of one backing |
| pin | the commitment a seat's served state stands on |
| walk, descent | finding the opening state through the record's commitments (C2.7) |
| exhibit | evidence that a commitment does not carry a backing — now a directory absence proof |
| door | an admission check on a sequencer entry point |
| era | the commitment a receipt names (C2b.4) |
| term | the interval during which one link is in force (C2.5.8) |
| grade | a silence-clause condition: non-service (C2b.5) or no-commitment (C2b.6) |
| opening claim | a retired mechanism: an operator's signed claim of an empty book |

Commit messages: `spec:`, `feat:`, `fix:`, `docs:`, `test:`, `chore:` and a title that states the rule or change in plain words.

## Engineering contract

Preserve these invariants unless the normative specification is deliberately changed:

- Monetary quantities, counters, epochs, positions, and timestamps use `bigint`. Convert to `number` only at checked external-library boundaries.
- Signatures cover canonical framed bytes with fixed domain tags. Do not use delimiter concatenation, JSON bytes, variable domains, or permissive signature parsing.
- Validate at trust boundaries, then keep internal helpers small. Copy mutable inputs on ingestion and outputs on return.
- Public verification APIs return `false` for malformed or invalid external data. Venue mutation APIs throw `VenueError` with a stable code. Unexpected programming failures should remain visible.
- Protocol time is a witnessed venue index or other protocol-defined witness, never local wall-clock time.
- Issuance is distinct from movement. Value cannot be clawed back, reversed, frozen, or moved through a privileged path.
- A backing's terms are committed once, inside its name, and cannot change for the same name. A change of construction or version is a successor.
- Signed submissions and transitions are idempotent: exact replay returns the prior result; conflicting replay is rejected.
- Commitments commit injectively to protocol-relevant state and bind the order of statements. Receipts prove acceptance, not a live balance or spendable holding.
- Locks are additive constraints and cannot create a privileged debit path. Valid lock proofs are complete and deterministic.
- Closure is terminal. Final-state proofs prove closure of the same committed state, not merely an empty balance.
- Recovery and succession preserve identity continuity, authorization, replay protection, and finality. Do not introduce a coordination authority through a convenience API.
- Settlement remains payer-driven. A payee receives only the request plus the payer's receipt and need not monitor or trust an operator.
- Code must not depend on impossible whole-history scans or global cycle detection. Correctness comes from local signed evidence and venue-enforced invariants.
- Cryptography is hashes, signatures and the proof system **E** declares, and nothing else. A new primitive is a decision.

When a change touches one of these rules, inspect its relevant specification rule, decision entry, types, encodings, state transition, and adversarial tests together.

## Work autonomously

An approved goal authorizes routine, reversible work needed to complete it: investigation, planning, implementation, refactoring, documentation, targeted tests, and cleanup. Do not wait for approval between those steps.

Stop and ask only when:

- the specification is contradictory or leaves a materially important protocol choice unresolved;
- continuing would select a substantially different product or trust model;
- an irreversible or externally visible action needs authority; or
- required credentials, data, or access are unavailable.

Choose a coherent outcome-sized slice rather than one file or one tiny edit. A slice may span several sessions or context windows. Keep `WORK.md` accurate at meaningful checkpoints so another capable agent can continue without reconstructing the session.

Prefer an existing mechanism over a parallel abstraction. Remove accidental complexity when doing so is within scope, but do not combine unrelated cleanup with a security-sensitive protocol change.

Notice recurring friction and opportunities to simplify the repository or its workflow. Implement a low-risk improvement when it is clearly within the current goal; otherwise add a concise `Improvement opportunities` note to `WORK.md` with its expected benefit and cost. Suggestions are welcome, but they must not derail or silently broaden the active protocol slice.

## Implementation and verification

- Inspect before editing. Preserve unrelated user changes.
- Specification first: a rule the code needs and the specification lacks is written in Construction, cleared under §C0a, and committed there before the code that depends on it.
- For changed behavior or a bug, add the smallest test that would have exposed the problem. Documentation-only and mechanical changes do not need ceremonial tests.
- Run focused checks while iterating. Before declaring a code, packaging, or CI change ready, run `npm run check`; report exact failures instead of weakening a check. `npm run check:privacy` exercises the real-proof experiment separately.
- Exercise hostile inputs, replay, aliasing, overflow, boundary indices, withheld data, and wrong-context proofs where relevant.
- Keep recoverable scratch work small. Promote lasting evidence to a test, decision, or concise note in `WORK.md`, then remove bulky clones, dependency trees, and duplicate artifacts.
- Make logical commits at completed milestones. Do not rewrite unrelated history or discard changes you did not create.
- Never push, merge, publish, or open a pull request without maintainer authorization.

## Review by risk

Every change gets a self-review. Additional review is proportional to risk:

- Documentation, tooling, and mechanical refactors need focused checks and a careful diff review; they do not require a panel.
- Changes to signed bytes, parsers, circuits and statement layouts, authorization, custody, balances, state transitions, time or finality, recovery, or consensus-sensitive behavior require independent adversarial review before merge.
- Convene multiple design reviewers only when a real ambiguity or competing mechanism exists. Record the alternatives, tradeoffs, and chosen invariant in `DECISIONS.md`, as one entry whose title states the rule.
- Review a fix independently when it changes critical logic or when the original finding suggests nearby variants. Do not recursively commission review rounds for low-risk fixes, and do not review the frozen transparent path at all except to port a case.

When subagents are available, give each one a bounded, non-overlapping lane and concrete output. Use economical models for inventories, mechanical work, and deterministic verification; reserve the strongest available reasoning for protocol design, security analysis, and unresolved cross-cutting failures. The primary agent owns synthesis and implementation. If independent review is temporarily unavailable, continue safe work and record the review still owed in `WORK.md` instead of abandoning the slice.

## Handoff discipline

Before stopping or compacting a long session, update `WORK.md` with:

- the current goal and status;
- branch and relevant commits;
- completed work and exact verification evidence;
- the next concrete action;
- unresolved risks, questions, and any review still owed; and
- the companion specification branch or decision links when applicable.

Do not create a decision entry to mark the end of a session or to log a review round. Another agent should be able to read `WORK.md`, inspect the named evidence, and resume immediately.

## Toolchain

Use Node.js 20 or newer. Node.js 24 is the development target.

```bash
npm ci
npm run check
```

During iteration, the component commands are `npm run typecheck`, `npm test`, `npm run build`, and `npm run check:docs`.
