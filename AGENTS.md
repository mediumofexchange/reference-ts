# reference-ts

Executable reference for the Medium of Exchange Protocol. Build a working, auditable protocol with
private payments and public supply verification. Security and correctness precede speed or brevity;
there is no release deadline.

## Start and navigate

At session start, read `git status`, the recent log, `WORK.md` and applicable `AGENTS.md`. Resume
from the handoff; verify inherited claims needed for the next action. Read affected implementation
and tests before editing.

| Need | Source |
|---|---|
| Active slice, acceptance, blockers and companion branch | `WORK.md` |
| Binding behavior | Companion `money-from-first-principles` specification; README pins the runtime revision |
| Rule → specification → code → tests | Relevant rows of [protocol rules](docs/PROTOCOL_RULES.md) |
| Component boundaries and retirement | Relevant row of [architecture](docs/PRIVATE_PAYMENT_ARCHITECTURE.md) |
| Current component evidence and later specification pins | [Implementation status](docs/IMPLEMENTATION_STATUS.md) |
| Prior rationale | Search `DECISIONS.md`, then read only its relevant linked entry |
| Release gates and estimate method | [Production requirements](docs/PRODUCTION_REQUIREMENTS.md) |
| Fault-contract coverage and limits | [Fault recovery](docs/POOL_FAULT_RECOVERY.md) |

Load sources for the mechanism being changed, not whole decision archives or every component guide.
README stays an introduction; update each topic in place. Keep durable instructions here, active
status in WORK.md, and substantive decisions in `decisions/` with an index entry. Retain selected
checked reviews in `decisions/archive/`; superseded drafts, retired harnesses and session logs
belong in Git history (link a permalink when history must stay reachable). Each measurement has one
home, normally its probes section or retained report; other documents link it with at most a
one-clause summary, not numbers or dated status. `CLAUDE.md` contains exactly `@AGENTS.md`.

## Direction and authority

The shielded pool is the active claim layer (Construction C1.2). `src/pool/` is the v2 runtime;
PoolStore refuses silence clauses. `src/pool/v3/` is the unadopted v3 candidate; successor work in
`model/`, `scripts/pool/v3/` and `experiments/` is conditional evidence, not runtime support. The
fault model binds exact bytes with real hashes and ideal proof/authentication oracles; current
layout and adoption limits are in implementation status.

The transparent path is frozen as a differential oracle and adversarial case library. Port cases as
pool rules land, then retire covered material. Do not review or extend it otherwise, or port the
retired exhibit walk/signed opening claim. Keep one production path and never reinterpret pinned
versions. Develop wallet, transport and witness feasibility alongside the core.

Standing authorization effective 2026-09-08 covers development, protocol decisions and merge/push
after verification until superseded, without renewed permission; it excludes real funds, public
releases, live deployment, destructive data/history operations and access-control changes unless
separately authorized. Deleting disposable files in ignored `scratch/` is authorized (2026-09-25),
except WORK.md's retained local state. Pause only for unavailable access/physical input, a
departure from core intent, or actions outside authority; continue safe work.

Preserve open entry, independent verification, private payments, public supply verification, holder
authorization and compartmentalized failure. Prefer fewer mechanisms and lower measured compute,
storage, bandwidth and operating costs within those boundaries. Do not weaken an invariant to pass a
test or benchmark.

## Engineering contract

- Use `bigint` for money, counters, epochs, positions and timestamps; convert to `number` only at checked external-library boundaries.
- Sign canonical framed bytes with fixed domain tags; no delimiter concatenation, JSON signing, variable domains or permissive signature parsing.
- Validate at trust boundaries. Copy mutable inputs on ingestion and outputs on return; keep internal helpers small.
- Public verification returns `false` for malformed/invalid external data. Venue mutation throws `VenueError` with a stable code. Unexpected programming failures remain visible.
- Time is a witnessed venue index or another protocol-defined witness, never local wall-clock time.
- Issuance is distinct from movement. No clawback, reversal, freeze or privileged debit path.
- A backing's terms are committed once inside its name. A construction/version change needs a successor.
- Signed submissions/transitions are idempotent: exact replay returns the prior result; conflicting replay is rejected.
- Commitments bind state injectively and statements in order. Receipts prove acceptance, not a live balance or spendable holding.
- Locks add constraints and no debit privilege. Valid lock proofs are complete and deterministic.
- Closure is terminal. Final-state proofs prove closure of the same committed state, not merely an empty balance.
- Recovery/succession preserve identity, authorization, replay protection and finality; no convenience API may create a coordination authority.
- Settlement is payer-driven. The payee needs only the request and payer receipt, without monitoring or trusting an operator.
- No impossible whole-history scans or global cycle detection. Correctness rests on local signed evidence and venue-enforced invariants.
- Cryptography is hashes, signatures and the proof system E declares; a new primitive is a protocol decision.

For affected invariants, inspect the relevant specification, decision, types, encoding, transition
and adversarial tests together. Code/tests do not override the specification.

## Work and review

Default to a complete capability at the selected layer (a user/recovery path or end-to-end
experiment, not one helper or missing guard), scoped by product dependencies and consequential
uncertainty, not commit count; it may span specification, models, implementation and audit. Before
substantial work, state observable acceptance, evidence limits and the real stop boundary in WORK.md.
Continue through reviewable internal milestones until acceptance and delivery are complete. Start
with the cheapest decisive probe for the largest uncertainty; if it fails, resolve the design before
dependent machinery. A probe, measurement or hardening item names the decision or release gate it
serves and retires with it: once that is recorded or a runtime test or conformance suite covers it,
delete the probe and cite its report at its last revision. Only acceptance evidence for current
runtime behavior is re-recorded as current. Do not broaden into unrelated cleanup or call an
experiment a runtime capability.

For a protocol ambiguity/change: identify the exact rule and conflict; compare the smallest
alternatives, including reuse or omission; explain invariants, trust/privacy, compatibility and
resource costs; name a falsifying counterexample or measurement. Have a fresh reviewer inspect the
actual proposal and sources. Resolve findings, record the choice neutrally, clear Construction C0a,
then commit the specification before dependent code. A reviewed choice within intent does not need
another approval. Reopen it only for new evidence or a missed requirement. Keep companion branches
and implementation pins coordinated.

Every patch gets self-review. Review consequential design choices before dependent code, then review
the integrated sensitive patch at a stable acceptance boundary; further rounds follow changed risk or
unresolved findings, not each helper, test or commit. Documentation, tooling and mechanical edits
need focused verification, not a panel. Signed bytes, parsers, circuits, authorization, custody,
balances, state transitions, time/finality, recovery and consensus-sensitive changes need
independent adversarial review before merge.

Use one fresh reviewer by default; add one only for a distinct risk or unresolved disagreement.
Supply the actual patch/commit range, normative intent and acceptance criteria. Require concrete
path/rule, trigger, impact and reproducer or evidence gap. Resolve blockers and read back critical
fixes/nearby variants. Agreement, self-review or generated audit prompts are not independent
evidence. If review is unavailable, retain the merge gate and exact review owed; continue safe work.

Delegate bounded work when it reduces the critical path. Use economical available agents for
inventories/mechanical checks and strong reasoning for protocol, security/design or inconclusive
work. Give outcomes, constraints, sources and acceptance criteria; let agents choose steps. One
primary owns integration. Writers own disjoint files or isolated worktrees (`git worktree add
scratch/wt/<name>`; dependencies resolve from the checkout) and never concurrently change a shared
branch/index. Reviewers are read-only and report path:line, trigger, impact and fix. Check a
finished agent's commits and leftovers rather than trusting its summary. Do not assume or install
another provider/model.

## Verification and delivery

Use Node 24 for all components; the core package supports Node 20+. Install with `npm ci` when
dependencies need installation, not on every resume. Choose the check set before expensive runs;
commands are in `package.json`.

| Change | Checks |
|---|---|
| Documentation only | `npm run check:docs`; check affected companion links |
| Isolated experiment/tooling | Syntax, focused tests and its acceptance command |
| Shared runtime/protocol, public API, dependencies/toolchain, packaging, broad CI/build, or uncertain impact | `npm run check` |
| v2 circuits/proof relations/keys/configuration | Relevant real-proof `npm run check:pool` evidence |
| v3 relations/keys/configuration | `npm run check:pool:v3` (add `-- --ergo` for its adapter) |
| v3 replay-only experiment | `npm run check:pool:ergo-replay` |
| Real-proof wallet flow | `npm run check:pool-wallet-real` |
| Sources bound by a retained report | `npm run check:evidence`; re-record reports cited as current |

Add the smallest regression test for changed behavior; hostile witnesses must otherwise satisfy the
relation so unrelated constraints cannot hide a missing guard. Cover relevant replay, aliasing,
overflow, index boundaries, withheld data and wrong-context proofs.

Iterate with focused checks; run expensive real-proof/full acceptance after the relevant patch
stabilizes. Reuse a passing baseline when its inputs are unchanged, recording revision, affected
checks and gaps. A report/cache is evidence only for the exact sources/artifacts/configuration it
binds, so a report generator hashes every source its verdict depends on (including imported
parsers) and takes specification pins from one constant. Rerun affected checks after fixes and
required checks on final code. Do not duplicate unchanged passing CI locally or weaken checks after
failures. A negative test asserts the specific refusal (code, check or reason), not merely a throw.

Preserve unrelated changes. Make logical commits, fetch/inspect upstream, integrate without
rewriting others' work, satisfy protections and required checks, then merge/push under standing
authority. Verify final commit, clean status and remote parity. Inspect available CI for that
revision and distinguish pending from passed. Do not bypass failed or unavailable required gates.
After a verified merge, delete the merged branch locally and on the remote, its worktrees and the
slice's disposable scratch files; only WORK.md's retained local state outlives a slice. Deletions
the permission check refuses go into the one deletion list under WORK.md's Open questions. Prefer
one complete handoff in the delivery commit; follow up only for new evidence or a correction.

A slice is complete when acceptance is demonstrated, relevant hostile cases pass, material review
findings are resolved, specification/code/docs agree, and delivery is verified. Models and fixture
verdicts cannot close runtime or release gates.

## Handoff and workspace hygiene

Keep AGENTS.md under 200 lines and WORK.md under 100. Before stopping/compaction, replace stale
handoff status with goal/acceptance, branch/relevant commits, evidence, next executable action,
blockers/review owed, and companion branch or decision links. Distinguish source/model/proof/
fixture/live evidence. Do not append diaries or create decisions merely to record completion.

Record choices, rationale, alternatives, evidence, limits and status neutrally; do not quote
conversations or attribute authority to a person/model. Git records authorship. Use Construction's
terms and rule numbers in code, tests and commits, not new metaphors; consult the [older
vocabulary](docs/PROTOCOL_RULES.md#older-vocabulary) only for older material. Commit prefixes:
`spec:`, `feat:`, `fix:`, `docs:`, `test:`, `chore:`, with a plain title naming the rule or change.

Keep disposable probes/build copies in ignored `scratch/`; promote lasting evidence then remove
obsolete copies. Edit files with the editor tool; a scripted edit is disposable and deleted after
use. Preserve explicitly retained evidence and useful verified caches. Never place full
clones/dependency trees at the workspace root. Apply obvious low-risk workflow improvements; put
larger opportunities in WORK.md without derailing the slice.

The host is Windows (Git Bash, PowerShell; LF files). Use absolute paths or `git -C`; the shell's
directory drifts. Write large text and multi-line scripts to a scratch file with the editor, not a
heredoc or `node -e`. Search with the Grep tool or `git grep`: `scratch/` holds tens of GB of node
data. Start commands that can pass two minutes (`npm test`, `npm run check`, `check:pool*`,
`check:evidence`, probes, CI waits) in the background, logging output and exit code to scratch; wait
with an until-loop or Monitor, never `sleep N; check`. WORK.md names detached jobs (own Ergo nodes,
drivers); change files they read only on a branch/worktree, merging after they end. New commits,
fresh file times or live agent processes mean another session shares the checkout: stay read-only.

WORK.md alone holds the coarse product-effort estimate (method in production requirements).
Reassess from gathered evidence after meaningful product progress or a major blocker, without extra
research just to estimate; credit reusable progress, never commit/test counts or workflow cleanup.
Report changed/requested rounded estimates and blockers, omitting unchanged percentages.

Final reports state behavior, verification/review, delivery and remaining limits, and recommend
staying with this instance or switching by next work and context freshness. WORK.md must suffice to
resume independently.
