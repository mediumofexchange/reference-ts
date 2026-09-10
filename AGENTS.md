# reference-ts

This repository is the executable reference implementation of the Medium of Exchange Protocol. Optimize for a working, simple, and secure protocol: choose the smallest design that is easy to audit, then make it fast enough. Security and protocol correctness take precedence over brevity or speed. There is no release deadline; a finished, working protocol is the deliverable.

## Sources of truth

- The normative specification lives in the companion `money-from-first-principles` repository. The README pins its implemented revision. If code and specification disagree, identify the exact conflict and fix or escalate the specification first.
- `WORK.md` is the current operational handoff. Replace stale status instead of appending a diary.
- Keep README as the concise introduction and setup guide. Detailed component evidence and specification pins belong in `docs/IMPLEMENTATION_STATUS.md`; update that guide in place rather than appending milestones to README.
- Record decisions neutrally: choice, rationale, alternatives, evidence and status. Do not quote conversations or attribute decision authority to a person or model; retain substantive review findings and evidence limits. Git preserves authorship.
- `DECISIONS.md` is the index of durable design decisions. Read only relevant entries. Keep selected checked reviews in `decisions/archive/`; completed session logs and superseded drafts belong in Git history, not new archive copies.
- Keep one current document per topic. Update it in place; capture a resolved choice in the decision log and remove its superseded diagnosis once the evidence is preserved. Link historical text at an immutable Git revision when needed.
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

The finished protocol's claim layer is the **shielded pool** (Construction §C1.2): ownership, amounts and histories hidden, supply proven at the pool's lit boundary. Build it in dependency-ordered product slices. For each changed mechanism, settle the specification, model new semantic risks, then implement and integrate it. Develop wallet, transport and witness feasibility alongside the core so deployment constraints arrive before formats are fixed. A mock or ideal model is evidence about a stated boundary, not a finished product feature.

The current implementation map and retirement conditions are in
[the architecture](docs/PRIVATE_PAYMENT_ARCHITECTURE.md). Read its relevant
row when entering a component, rather than loading every module summary.

- `src/pool/` is the active v2 runtime. Recovery is model-only; PoolStore
  refuses silence clauses. The fault model binds exact evidence bytes with
  real hashes and ideal proof/authentication oracles; v3 bytes remain open.
- The transparent path is frozen as a differential oracle and adversarial
  case library. Port cases as their pool rules land; remove it when covered.
  Never port the retired exhibit walk or signed opening claim.
- Keep one production path. Retire experiments only after their needed
  evidence and cases have moved to it. Do not reinterpret pinned versions.
- [Production requirements](docs/PRODUCTION_REQUIREMENTS.md) owns release
  gates; [fault recovery](docs/POOL_FAULT_RECOVERY.md) owns the selected
  fault contract's model coverage and remaining evidence work.

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

Standing authorization effective 2026-09-08 covers engineering and protocol decisions, with independent review for consequential choices, and merge and push after verification. Continue from `WORK.md` without asking for routine decisions or renewed merge permission. Use available capabilities, not assumptions about a model name.

Preserve the project's intent: open entry without a gatekeeper, independent verification, private payments with public supply verification, no privileged debit or hidden custody, and compartmentalized failure. Choose practicality, simplicity, security and efficient code within those boundaries. There is no deadline that licenses weakening them.

Ask only when the next action needs unavailable access or physical input, changes that core intent, or exceeds existing authority. Merge/push authorization does not itself authorize public releases, live deployment, spending or moving real funds, destructive data/history operations or access-control changes. Finish the safe preparation and present a concrete recommendation; continue independent work while blocked.

For a protocol decision, state the exact ambiguity and relevant rule, compare the smallest viable alternatives (including reuse or omission), and recommend one. Explain invariant preservation, trust/privacy effects, compatibility and resource/operating costs. Identify the counterexample or measurement that could falsify it. Resolve review findings, record the choice in the decision log and commit the specification before dependent code. A reviewed choice inside intent is approved; a new rule alone is not a reason to stop. Reopen it only for new evidence or a concrete missed requirement.

Choose the next slice by its contribution to the smallest supported product, dependencies and the highest consequential uncertainty. Prefer demonstrating a complete user/recovery path or removing its next blocker over expanding models or abstractions indefinitely. State the expected observable result and completion checks in `WORK.md` before substantial work; a slice may span context windows.

Reuse an existing mechanism where it has the same security meaning. Prefer fewer states, formats, dependencies and operating obligations; measure hot paths and resource limits before optimizing. Apply obvious low-risk workflow fixes in scope, and record larger opportunities in `WORK.md` without derailing the product. Do not combine unrelated cleanup with sensitive changes.

## Implementation and verification

- Inspect before editing. Preserve unrelated user changes.
- Specification first: a missing or changed rule is resolved through the decision/review process above, written in the relevant normative document, cleared under §C0a, and committed before dependent code. Check companion amendments and implementation pins together; never reinterpret an old version.
- For changed behavior or a bug, add the smallest test that would have exposed the problem. Hostile witnesses must otherwise satisfy the relation, so an unrelated constraint cannot hide a missing guard. Documentation-only and mechanical changes do not need ceremonial tests.
- Run focused checks while iterating. Before declaring a code, packaging, or CI change ready, run `npm run check`; report exact failures instead of weakening a check. `npm run check:privacy` exercises the real-proof experiment separately.
- Changed circuits, proof relations, keys or pool configuration also require the relevant real-proof `npm run check:pool` evidence. Docs-only changes need `npm run check:docs` and affected cross-repository links, not a full runtime rerun. Reuse passing evidence for unchanged code; rerun affected checks after fixes and required checks on the final code.
- Exercise hostile inputs, replay, aliasing, overflow, boundary indices, withheld data, and wrong-context proofs where relevant.
- Keep recoverable scratch work small. Promote lasting evidence to a test, decision, or concise note in `WORK.md`, then remove bulky clones, dependency trees, and duplicate artifacts.
- Make logical commits at completed milestones. Do not rewrite unrelated history or discard changes you did not create.
- Under standing authority, fetch and inspect upstream changes, integrate without rewriting others' work, satisfy repository protections and required checks, then merge and push. Verify the resulting commit, clean status and remote parity. Check available CI for that revision; distinguish pending CI from passed local checks. Do not bypass a failed or unavailable required gate.

A slice is complete when its stated behavior is demonstrated, relevant hostile cases pass, required review findings are resolved, the specification/code/docs agree, and the authorized delivery is verified. An architectural model alone cannot close a runtime or product gate. Leave concrete remaining limitations in the handoff; do not claim release readiness from test counts or review consensus.

## Review by risk

Every change gets a self-review. Additional review is proportional to risk:

- Documentation, tooling, and mechanical refactors need focused checks and a careful diff review; they do not require a panel.
- Changes to signed bytes, parsers, circuits and statement layouts, authorization, custody, balances, state transitions, time or finality, recovery, or consensus-sensitive behavior require independent adversarial review before merge.
- Use one fresh independent reviewer by default for a consequential decision or sensitive patch. Add a different reviewer only for unresolved competing mechanisms, inconclusive evidence or a distinct risk boundary. Record substantive decisions once in `decisions/` with an index entry in `DECISIONS.md`.
- Review a fix independently when it changes critical logic or when the original finding suggests nearby variants. Do not recursively commission review rounds for low-risk fixes, and do not review the frozen transparent path at all except to port a case.

Delegate concrete independent work when it reduces the critical path. Give each agent the outcome, relevant source paths/revisions, invariants, acceptance criteria and file ownership; avoid scripting every reasoning step or cloning the full session unnecessarily. One primary agent owns integration; concurrent writers use disjoint files or worktrees and never manipulate a shared branch/index. Use economical available models for bounded inventories and verification; use strong reasoning for protocol, security and design. Do not assume another provider/model is available or install one without authority.

The reviewer receives the actual patch or fixed commit range, normative intent and acceptance criteria, and independently looks for counterexamples before adopting the author's explanation. Require concrete findings with affected path/rule, trigger, impact and reproducer or explicit evidence gap; distinguish blockers from optional improvements. Different models/providers can add diversity when available, but their agreement is not proof. Self-review, a generated audit prompt or a summary without inspection is not independent review.

Resolve blockers and have critical fixes/nearby variants read back. Close review when the current patch has no unresolved material findings and its proof obligations/checks are satisfied; do not repeat broad reviews for cosmetic fixes or collect approvals by majority vote. If reviewers disagree, investigate the disputed claim with a targeted test, proof or source check. If required independent review is unavailable, continue safe work and retain the merge gate and exact review owed.

## Handoff discipline

Before stopping or compacting a long session, update `WORK.md` with:

- the current goal and status;
- branch and relevant commits;
- completed work and exact verification evidence;
- the next concrete action;
- unresolved risks, questions, and any review still owed; and
- the companion specification branch or decision links when applicable.

Do not create a decision entry to mark the end of a session or to log a review round. Another agent should be able to read `WORK.md`, inspect the named evidence, and resume immediately.

Keep `AGENTS.md` under 200 lines and `WORK.md` under 100. Handoffs retain the next executable action, its acceptance result and any blocker/assumption; do not copy full transcripts, whole decision logs or repeated check output. Read deeper sources only for the active mechanism. `CLAUDE.md` remains the exact `@AGENTS.md` import.

Final reports state the delivered behavior, checks/review, merge/push state and remaining limits. Include a rough percentage done and remaining toward the usable end-to-end product, a range for roadblocks and the largest remaining work. Use the acceptance scope and estimate in [production requirements](docs/PRODUCTION_REQUIREMENTS.md#progress-estimate); estimate effort, not files, commits or tests. Workflow work alone does not advance product completion.

After each slice, recommend continuing with the current model/instance or switching, based on the next slice's reasoning needs, context freshness and expected efficiency. State the reason; distinguish a recommendation from measured comparative performance.

## Toolchain

Use Node.js 20 or newer. Node.js 24 is the development target.

```bash
npm ci
npm run check
```

During iteration, the component commands are `npm run typecheck`, `npm test`, `npm run build`, and `npm run check:docs`.
