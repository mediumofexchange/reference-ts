// The holder's and backer's side of pool-v3 §3.1–3.3: the circuit inputs and
// exact public inputs of an issue, a two-in/four-out spend and a burn, from
// notes, their paths and prepared outputs (C4.1–C4.4). Pure: nothing here
// proves, signs or judges validity; the prover (prover.ts) executes a task and
// checks the proof's public inputs against these, and admission judges the
// record. A padding input's path and anchor are unconstrained by the relation
// (§3.2) but must still name an accepted root, which the reader checks.
import { ed25519 } from "@noble/curves/ed25519.js";
import { copyBytes, compareBytes, EncodingError } from "../../bytes.js";
import { limbsOf } from "../field.js";
import type { NotePath } from "../note-tree.js";
import type { NoteOpening } from "../notes.js";
import { ScopeTree } from "../scope.js";
import { segmentIdentity, type SegmentHeader } from "./headers.js";
import { deliveryHash, statementBytes, type Kind, type Record } from "./records.js";

/** The noir_js input map: decimal strings, booleans and nested arrays of them. */
export type WitnessValue = string | boolean | readonly WitnessValue[] | { readonly [key: string]: WitnessValue };
export type WitnessMap = { readonly [key: string]: WitnessValue };

/** One statement to prove: its kind, the circuit inputs, the public inputs the proof must carry and the ordered capsules. */
export interface ProofTask {
  readonly kind: Extract<Kind, 1 | 2 | 3>;
  readonly witness: WitnessMap;
  readonly publicInputs: readonly bigint[];
  readonly capsules: readonly Uint8Array[];
}

/** Where a statement is proven: the configuration's domain and the segment's header, whose scope it names. */
export interface SegmentContext {
  readonly domain: Uint8Array;
  readonly header: SegmentHeader;
}
/** A note its owner can spend: the opening, the spend secret, and its commitment and nullifier. */
export interface SpendableNote {
  readonly opening: NoteOpening;
  readonly secret: bigint;
  readonly cm: bigint;
  readonly nf: bigint;
}
/** An input: the note, the accepted root it is proven under and its path there. */
export interface NoteInput {
  readonly note: SpendableNote;
  readonly anchor: bigint;
  readonly path: NotePath;
}
/** An output as its recipient prepared it (C4.1–C4.3): opening, commitment and capsule. */
export interface OutputNote {
  readonly opening: NoteOpening;
  readonly cm: bigint;
  readonly capsule: Uint8Array;
}

const decimal = (value: bigint): string => value.toString();
const limbs = (identifier: Uint8Array): string[] => limbsOf(identifier).map(decimal);

/** The public prefix every kind 1–3 statement starts with, and each scoped backing's path. */
function prefixOf(context: SegmentContext): { readonly prefix: bigint[]; readonly base: WitnessMap; scoped(backing: Uint8Array): WitnessMap } {
  const { domain, header } = context;
  if (!(domain instanceof Uint8Array) || domain.length !== 32 || compareBytes(domain, header.domain) !== 0) {
    throw new EncodingError("the statement's domain is not its segment's");
  }
  const segment = segmentIdentity(header), tree = new ScopeTree(header.entries), scope = tree.root();
  return {
    prefix: [...limbsOf(domain), ...limbsOf(segment), scope],
    base: { domain: limbs(domain), segment: limbs(segment), scope: decimal(scope) },
    scoped(backing) {
      const at = header.entries.findIndex(entry => compareBytes(entry.backing, backing) === 0);
      if (at < 0) throw new EncodingError("the backing is outside the segment's scope");
      const path = tree.path(at);
      return { link: limbs(header.entries[at]!.link), scope_siblings: path.siblings.map(decimal), scope_right: [...path.right] };
    },
  };
}
const noteOf = (opening: NoteOpening): WitnessMap =>
  ({ backing: limbs(opening.backing), value: decimal(opening.value), owner: decimal(opening.owner), rho: decimal(opening.rho) });
const deliveryOf = (domain: Uint8Array, outputs: readonly OutputNote[]): readonly [bigint, bigint] =>
  limbsOf(deliveryHash(domain, outputs.map(o => o.cm), outputs.map(o => o.capsule)));
function inputsOf(inputs: readonly NoteInput[]): WitnessMap {
  if (!Array.isArray(inputs) || inputs.length !== 2) throw new EncodingError("a statement spends exactly two inputs");
  return {
    inputs: inputs.map(i => noteOf(i.note.opening)), secrets: inputs.map(i => decimal(i.note.secret)),
    anchors: inputs.map(i => decimal(i.anchor)), nullifiers: inputs.map(i => decimal(i.note.nf)),
    siblings: inputs.map(i => i.path.siblings.map(decimal)), right: inputs.map(i => [...i.path.right]),
  };
}

/** §3.1: issue `output.opening.value` of its backing as one output, before the backer signs it. */
export function issueTask(context: SegmentContext, output: OutputNote): ProofTask {
  const { prefix, base, scoped } = prefixOf(context), { opening } = output;
  const delivery = deliveryOf(context.domain, [output]);
  return Object.freeze({
    kind: 1,
    witness: { ...base, ...scoped(opening.backing), backing: limbs(opening.backing), quantity: decimal(opening.value),
      cm: decimal(output.cm), owner: decimal(opening.owner), rho: decimal(opening.rho), delivery: delivery.map(decimal) },
    publicInputs: Object.freeze([...prefix, ...limbsOf(opening.backing), opening.value, output.cm, ...delivery]),
    capsules: Object.freeze([copyBytes(output.capsule)]),
  });
}

/** §3.2: two inputs into four ordinary outputs, in the payer's chosen order (pool-fees C1.2.3). */
export function spendTask(context: SegmentContext, inputs: readonly NoteInput[], outputs: readonly OutputNote[]): ProofTask {
  const { prefix, base, scoped } = prefixOf(context);
  if (!Array.isArray(outputs) || outputs.length !== 4) throw new EncodingError("a spend creates exactly four outputs");
  const own = inputsOf(inputs), delivery = deliveryOf(context.domain, outputs);
  const scopes = inputs.map(i => scoped(i.note.opening.backing));
  return Object.freeze({
    kind: 2,
    witness: { ...base, ...own, links: scopes.map(s => s["link"]!), scope_siblings: scopes.map(s => s["scope_siblings"]!),
      scope_right: scopes.map(s => s["scope_right"]!), output_notes: outputs.map(o => noteOf(o.opening)),
      outputs: outputs.map(o => decimal(o.cm)), delivery: delivery.map(decimal) },
    publicInputs: Object.freeze([...prefix, ...inputs.map(i => i.anchor), ...inputs.map(i => i.note.nf), ...outputs.map(o => o.cm), ...delivery]),
    capsules: Object.freeze(outputs.map(o => copyBytes(o.capsule))),
  });
}

/** §3.3: burn `quantity` of the inputs' backing, the rest returned as one change output. */
export function burnTask(context: SegmentContext, quantity: bigint, inputs: readonly NoteInput[], change: OutputNote): ProofTask {
  const { prefix, base, scoped } = prefixOf(context), backing = change.opening.backing;
  const own = inputsOf(inputs), delivery = deliveryOf(context.domain, [change]);
  return Object.freeze({
    kind: 3,
    witness: { ...base, ...scoped(backing), ...own, backing: limbs(backing), quantity: decimal(quantity),
      change: noteOf(change.opening), cm_change: decimal(change.cm), delivery: delivery.map(decimal) },
    publicInputs: Object.freeze([...prefix, ...limbsOf(backing), quantity, ...inputs.map(i => i.anchor),
      ...inputs.map(i => i.note.nf), change.cm, ...delivery]),
    capsules: Object.freeze([copyBytes(change.capsule)]),
  });
}

/** The backer's authorization of an issue (§5): strict Ed25519 over the statement bytes with K's secret. */
export function authorizeIssue(record: Record, issuerSecret: Uint8Array): Record {
  if (record?.kind !== 1) throw new EncodingError("only an issue carries the backer's authorization");
  return Object.freeze({ ...record, authorization: ed25519.sign(statementBytes(record), issuerSecret) });
}
