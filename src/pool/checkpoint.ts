// C2.10.3–5 / C2b.1: whole-scope finality, canonical imports and prospective revocation.
// Selection reads the record before proofs run; replay cannot select a fallback.
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeBacking, type Backing } from "../backing.js";
import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { decodeCommitment, directoryRoot, encodeCommitment, verifyCommitment, type Commitment } from "../commitment.js";
import { VenueError, type Venue } from "../venue.js";
import { revokedAt } from "../revocation.js";
import { PoolAuthorityView } from "./authority.js";
import { readPoolPredecessor, type PoolSnapshotEvidence } from "./descent.js";
import { PoolError, Segment, type AcceptedStatement, type Checkpoint, type FinalizedPrefix, type SegmentTrail, type StatementVerifier } from "./segment.js";
import { configurationHash, copyConfiguration, copySegmentHeader, copyStatement, ISSUE, parsePublicInputs, segmentIdentity,
  type OpeningCheckpoint, type PoolConfiguration } from "./statement.js";

/** Directory/scope evidence can be served without history, including for
 * absence and public lapse. Each queried carrying backing needs its snapshot
 * preimage. History is only required for selected checkpoints and imports. */
export interface PoolCheckpointEvidence extends Checkpoint {
  readonly snapshots?: readonly PoolSnapshotEvidence[];
  readonly history?: { readonly trail: SegmentTrail; readonly length: bigint };
}

export type PoolCheckpointFailure =
  | { readonly kind: "unavailable"; readonly commitment: OpeningCheckpoint; readonly evidence: "directory" | "scope" | "history" }
  | { readonly kind: "invalid"; readonly reason: string };

/** `accepted` contains owned local records from this replay. Its evidence
 * hashes describe the supplied replay bytes, not necessarily the evidence
 * originally admitted by the operator; receipts attest that separately. */
export type PoolCheckpointResult = PoolCheckpointFailure
  | { readonly kind: "final"; readonly prefix: FinalizedPrefix; readonly accepted: readonly AcceptedStatement[]; readonly at: bigint; readonly witnessedIndex: bigint };

export type PoolCheckpointsResult = PoolCheckpointFailure
  | { readonly kind: "final"; readonly checkpoints: readonly {
      readonly commitment: Commitment; readonly prefix: FinalizedPrefix; readonly accepted: readonly AcceptedStatement[]; readonly at: bigint;
    }[]; readonly witnessedIndex: bigint };

interface CheckpointReadArguments {
  readonly configuration: PoolConfiguration;
  readonly venue: Venue;
  readonly evidence: readonly PoolCheckpointEvidence[];
  readonly verifier: StatementVerifier;
}

function same(a: Uint8Array, b: Uint8Array): boolean { return compareBytes(a, b) === 0; }
function key(c: OpeningCheckpoint): string { return `${bytesToHex(c.operator)}:${c.sequence}:${bytesToHex(c.root)}`; }
function requireThat(ok: boolean, reason: string): asserts ok {
  if (!ok) throw new PoolError("SEGMENT", reason);
}
// A trusted callback's exception is not malformed external evidence, even
// when its programming failure uses TypeError, RangeError or PoolError.
class CallbackFailure {
  constructor(readonly cause: unknown) {}
}
function ownEvidence(e: PoolCheckpointEvidence): PoolCheckpointEvidence {
  const checkpoint = { commitment: decodeCommitment(encodeCommitment(e.commitment)),
    directory: e.directory.map(d => ({ name: copyBytes(d.name), digest: copyBytes(d.digest) })) };
  // Planning is synchronous. Copy history only when selected, and let descent
  // copy only the snapshot it needs. Irrelevant malformed tails cannot defeat
  // authenticated absence or public lapse. None is read after planning yields.
  return { ...checkpoint, ...(e.snapshots === undefined ? {} : { snapshots: e.snapshots }),
    ...(e.history === undefined ? {} : { history: e.history }) };
}
function ownHistory(history: NonNullable<PoolCheckpointEvidence["history"]>): NonNullable<PoolCheckpointEvidence["history"]> {
  const { trail, length } = history;
  requireThat(Array.isArray(trail.statements) && typeof length === "bigint" && length >= 0n &&
    length <= BigInt(trail.statements.length), "checkpoint length exceeds supplied history");
  return { length, trail: { configuration: copyConfiguration(trail.configuration), header: copySegmentHeader(trail.header),
    backings: trail.backings.map(b => ({ backing: makeBacking(b.backing), signature: copyBytes(b.signature) })),
    // A served tail beyond the checkpoint is neither imported nor verified.
    statements: trail.statements.slice(0, Number(length)).map(copyStatement) } };
}

interface Planned {
  readonly evidence: PoolCheckpointEvidence & { readonly history: NonNullable<PoolCheckpointEvidence["history"]> };
  readonly at: bigint;
  readonly imports: readonly string[];
  readonly dependencies: readonly OpeningCheckpoint[];
  readonly previous?: string;
}

/** Validate an exact held checkpoint and all its required ancestors against
 * one venue view. Final means historical finality, not current spendability.
 *
 * All required bytes and all record selections are owned before asynchronous
 * proof verification. The iterative plan follows only required local edges;
 * their witnessed ranks decrease, so no whole-history graph is discovered.
 * Checkpoints are verified once per call. The computed prefixes passed to
 * Segment are private results of this validation, never caller assertions.
 * Newly checkpointed issuance must precede its obligor's revocation. Earlier
 * validated prefixes and imported events retain their original finality;
 * replay never removes revoked events to repair an invalid history. Silence
 * redemption/nullifier adoption remains outside pool-v2 (pool-v2 §7.4).
 *
 * Missing evidence stops with unavailable; malformed or invalid evidence with
 * invalid. Venue failures (including a changed view) throw VenueError, as do
 * unexpected verifier failures. This reader neither signs nor opens service.
 */
export async function readPoolCheckpoint(args: CheckpointReadArguments & { readonly checkpoint: Commitment }): Promise<PoolCheckpointResult> {
  if (typeof args !== "object" || args === null) return { kind: "invalid", reason: "malformed checkpoint arguments" };
  const result = await readPoolCheckpoints({ ...args, checkpoints: [args.checkpoint] });
  if (result.kind !== "final") return result;
  const verified = result.checkpoints[0]!;
  return { kind: "final", prefix: verified.prefix, accepted: verified.accepted, at: verified.at, witnessedIndex: result.witnessedIndex };
}

/** Validate several distinct held checkpoints in one plan. Own all required
 * histories before any verifier callback, and verify common ancestry once.
 * Results follow request order; any unavailable/invalid root stops the batch. */
export async function readPoolCheckpoints(args: CheckpointReadArguments & { readonly checkpoints: readonly Commitment[] }): Promise<PoolCheckpointsResult> {
  let stable = (): void => {};
  try {
    const configuration = copyConfiguration(args.configuration), domain = configurationHash(configuration);
    const targets = args.checkpoints.map(c => decodeCommitment(encodeCommitment(c)));
    const requested = new Map(targets.map(c => [key(c), c]));
    requireThat(targets.length !== 0 && requested.size === targets.length, "checkpoint requests must be nonempty and distinct");
    const backend = args.verifier;
    const verifier: StatementVerifier = {
      ...(backend.identities === undefined ? {} : { identities: backend.identities }),
      verify: async (kind, inputs, proof) => {
        try { return await backend.verify(kind, inputs, proof); }
        catch (cause) { throw new CallbackFailure(cause); }
      },
    };
    const supplied = new Map<string, PoolCheckpointEvidence>();
    for (const item of args.evidence.map(ownEvidence)) {
      requireThat(!supplied.has(key(item.commitment)), "duplicate checkpoint evidence");
      supplied.set(key(item.commitment), item);
    }
    const venue = args.venue, now = venue.witnessedIndex(), lag = venue.lag(), venueId = copyBytes(venue.id);
    const revocations = new Map<string, { backing: Backing; at: bigint | undefined }>();
    const readRevocation = (backing: Backing): bigint | undefined => {
      try { return revokedAt(venue, makeBacking(backing)); }
      catch (cause) { throw new CallbackFailure(cause); }
    };
    stable = (): void => {
      if (venue.witnessedIndex() !== now || venue.lag() !== lag || !same(venue.id, venueId)) {
        throw new VenueError("venue view changed during checkpoint validation");
      }
      // A revocation can be appended at an already observed index. Clock-only
      // stability would turn that cutoff into a stale clean bill of health.
      for (const saved of revocations.values()) {
        if (readRevocation(saved.backing) !== saved.at) throw new VenueError("revocation record changed during checkpoint validation");
      }
      if (venue.witnessedIndex() !== now || venue.lag() !== lag || !same(venue.id, venueId)) {
        throw new VenueError("venue view changed during revocation validation");
      }
    };
    requireThat(targets.every(verifyCommitment), "invalid checkpoint signature");
    const planned = new Map<string, Planned>(), order: string[] = [];
    const pending: { reference: OpeningCheckpoint; child?: Planned; finish?: boolean }[] = targets.map(reference => ({ reference }));
    while (pending.length !== 0) {
      const step = pending.pop()!, id = key(step.reference);
      if (step.finish) { order.push(id); continue; }
      let node = planned.get(id);
      if (node === undefined) {
        const e = supplied.get(id);
        if (e === undefined) { stable(); return { kind: "unavailable", commitment: step.reference, evidence: "directory" }; }
        const c = e.commitment;
        requireThat(verifyCommitment(c) && same(directoryRoot(e.directory), c.root), "checkpoint signature or directory is invalid");
        // previousFor refuses unsettled adapter refreshes before exact lookup.
        const held = venue.previousFor(c.operator, c.sequence + 1n, now);
        requireThat(held !== undefined && same(encodeCommitment(held), encodeCommitment(c)), "checkpoint is not held");
        const at = venue.witnessedAtSequence(c.operator, c.sequence);
        if (typeof at !== "bigint" || at < 0n || at > now) throw new VenueError("inconsistent checkpoint index");
        const target = requested.get(id);
        if (target !== undefined) requireThat(same(encodeCommitment(c), encodeCommitment(target)), "wrong target commitment");
        if (e.history === undefined) { stable(); return { kind: "unavailable", commitment: c, evidence: "history" }; }
        const history = ownHistory(e.history), { trail } = history, h = trail.header;
        requireThat(same(configurationHash(trail.configuration), domain) && same(h.domain, domain) && same(h.venue, venueId),
          "wrong checkpoint configuration or venue");
        requireThat(same(h.operator, c.operator) && c.sequence >= h.sequence, "checkpoint does not belong to its segment");
        requireThat(e.directory.length === h.entries.length && h.entries.every((entry, i) => same(entry.backing, e.directory[i]!.name)),
          "checkpoint does not carry the whole scope");
        const authority = new PoolAuthorityView(configuration, venue, trail.backings);
        requireThat(authority.authorizes(h, at), "whole scope is not in force at checkpoint index");
        for (const { backing } of trail.backings) {
          const obligor = bytesToHex(backing.obligor);
          if (!revocations.has(obligor)) {
            const cutoff = readRevocation(backing);
            if (cutoff !== undefined && (typeof cutoff !== "bigint" || cutoff < 0n || cutoff > now)) throw new VenueError("inconsistent revocation index");
            revocations.set(obligor, { backing: makeBacking(backing), at: cutoff });
          }
        }
        const terms = new Map(trail.backings.map(b => [bytesToHex(b.backing.name), b]));
        const predecessors: (OpeningCheckpoint | undefined)[] = [];
        let previous: string | undefined;
        for (const entry of h.entries) {
          const selection = readPoolPredecessor({ configuration, venue, backing: terms.get(bytesToHex(entry.backing))!, child: c,
            evidence: [...supplied.values()].map(item => {
              const carries = item.directory.some(d => same(d.name, entry.backing));
              const matches = carries ? item.snapshots?.filter(s => same(s.backing, entry.backing)) ?? [] : [];
              requireThat(matches.length <= 1, "duplicate snapshot evidence for a backing");
              return { commitment: item.commitment, directory: item.directory, ...(matches[0] === undefined ? {} : { snapshot: matches[0] }) };
            }) });
          if (selection.kind === "invalid" || selection.kind === "unavailable") { stable(); return selection; }
          const predecessor = selection.kind === "candidate" ? selection.checkpoint.commitment : undefined;
          predecessors.push(predecessor);
          if (selection.kind === "candidate" && same(segmentIdentity(selection.header), segmentIdentity(h))) previous = key(selection.checkpoint.commitment);
        }
        if (previous !== undefined) {
          requireThat(predecessors.every(p => p !== undefined && key(p) === previous), "scope does not continue one shared checkpoint");
        } else {
          requireThat(h.entries.every((entry, i) => {
            const predecessor = predecessors[i];
            return entry.opening === undefined ? predecessor === undefined : predecessor !== undefined && key(entry.opening) === key(predecessor);
          }), "segment openings are not the canonical predecessors");
        }
        const openings = h.entries.flatMap(entry => entry.opening === undefined ? [] : [entry.opening]);
        const dependencies = new Map([...openings, ...predecessors.filter(p => p !== undefined)].map(p => [key(p), p]));
        node = { evidence: { commitment: e.commitment, directory: e.directory, history }, at, imports: [...new Set(openings.map(key))], dependencies: [...dependencies.values()],
          ...(previous === undefined ? {} : { previous }) };
        planned.set(id, node);
        pending.push({ reference: step.reference, finish: true });
        for (const reference of node.dependencies) pending.push({ reference, child: node });
      }
      if (step.child !== undefined) {
        const parent = node.evidence.commitment, child = step.child.evidence.commitment;
        requireThat(node.at < step.child.at || (node.at === step.child.at && same(parent.operator, child.operator) && parent.sequence < child.sequence),
          "import does not precede its child checkpoint");
      }
    }
    stable();
    const verified = new Map<string, FinalizedPrefix>();
    const accepted = new Map<string, readonly AcceptedStatement[]>();
    for (const id of order) {
      const node = planned.get(id)!, { trail } = node.evidence.history;
      const imports = node.imports.map(parent => {
        const prefix = verified.get(parent);
        if (prefix === undefined) throw new Error("checkpoint plan is not in dependency order");
        return prefix;
      });
      const segment = new Segment(configuration, trail.header, imports, verifier);
      for (const b of trail.backings) segment.register(b.backing, b.signature);
      const previous = node.previous === undefined ? undefined : verified.get(node.previous);
      if (node.previous !== undefined && previous === undefined) throw new Error("checkpoint predecessor was not verified");
      let position = 0n;
      const records: AcceptedStatement[] = [];
      for (const statement of trail.statements) {
        position++;
        const record = await segment.admit(statement);
        requireThat(record.position === position, "checkpoint history repeats a statement");
        if (statement.kind === ISSUE && position > (previous?.length ?? 0n)) {
          const inputs = parsePublicInputs(statement.kind, statement.publicInputs);
          if (inputs.kind !== ISSUE) throw new Error("issuance parse mismatch");
          const backing = segment.backing(inputs.backing)!.backing;
          const cutoff = revocations.get(bytesToHex(backing.obligor))!.at;
          requireThat(cutoff === undefined || node.at < cutoff, "issuance first witnessed at or after revocation");
        }
        if (requested.has(id)) records.push(record);
      }
      const prefix = segment.prefix(), directory = node.evidence.directory;
      requireThat(prefix.directory.length === directory.length && prefix.directory.every((d, i) =>
        same(d.name, directory[i]!.name) && same(d.digest, directory[i]!.digest)), "checkpoint directory does not match replay");
      if (previous !== undefined) {
        requireThat(previous.length <= prefix.length && same(segment.prefix(previous.length).historyHash, previous.historyHash),
          "checkpoint rewrites or truncates its finalized prefix");
      }
      verified.set(id, prefix);
      if (requested.has(id)) accepted.set(id, records);
    }
    stable();
    return { kind: "final", checkpoints: targets.map(c => ({ commitment: c, prefix: verified.get(key(c))!,
      accepted: accepted.get(key(c))!, at: planned.get(key(c))!.at })), witnessedIndex: now };
  } catch (cause) {
    try { stable(); }
    catch (error) { if (error instanceof CallbackFailure) throw error.cause; throw error; }
    if (cause instanceof CallbackFailure) throw cause.cause;
    if (cause instanceof PoolError || cause instanceof EncodingError || cause instanceof TypeError || cause instanceof RangeError) {
      return { kind: "invalid", reason: cause.message };
    }
    throw cause;
  }
}
