// Holder/backer witnesses and authorizations for pool-v3 §3 and §6.
// Task builders do not prove or judge validity: prover.ts checks the proof's
// public inputs against the task, and the reader judges the record. Ordinary
// spending and settlement padding still needs an accepted root; demand
// padding uses zero anchors/tags, and requests are segment-free.
import { ed25519 } from "@noble/curves/ed25519.js";
import { copyBytes, compareBytes, EncodingError } from "../../bytes.js";
import { identifierOf, limbsOf } from "../field.js";
import type { NotePath } from "../note-tree.js";
import type { NoteOpening } from "../notes.js";
import { ScopeTree } from "../scope.js";
import { segmentIdentity, type SegmentHeader } from "./headers.js";
import { acceptanceBytes, acceptanceId, decodeRecord, deliveryHash, encodeRecord, encodeSettlementAuthorization,
  releaseBytes, statementBytes, statementHash, withdrawalBytes, type Acceptance, type Kind, type Record,
  type SignedAcceptance } from "./records.js";
import { tagOf } from "./recovery.js";

/** The noir_js input map: decimal strings, booleans and nested arrays of them. */
export type WitnessValue = string | boolean | readonly WitnessValue[] | { readonly [key: string]: WitnessValue };
export type WitnessMap = { readonly [key: string]: WitnessValue };

/** One statement to prove: its kind, the circuit inputs, the public inputs the proof must carry and the ordered capsules. */
export interface ProofTask {
  readonly kind: Extract<Kind, 1 | 2 | 3 | 4 | 6 | 7>;
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

/** The public prefix of segment-bound kinds 1–6, and each scoped backing's path. */
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

/** The holder chooses and retains the presenter's signing secret and both witnessed indices. */
export interface DemandNotice {
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly presenter: Uint8Array;
  readonly instant: bigint;
  readonly deadline: bigint;
}

/** C3.2–3: a holding proof binds the notice; padding anchors and tags are exactly zero. */
export function demandTask(context: SegmentContext, inputs: readonly NoteInput[], notice: DemandNotice): ProofTask {
  const { prefix, base, scoped } = prefixOf(context), own = inputsOf(inputs);
  const { backing, quantity, presenter, instant, deadline } = notice;
  const anchors = inputs.map(i => i.note.opening.value === 0n ? 0n : i.anchor);
  const tags = inputs.map(i => i.note.opening.value === 0n ? 0n : tagOf(i.note.nf));
  const publicInputs = [...prefix, ...limbsOf(backing), quantity, ...anchors, ...tags, ...limbsOf(presenter), instant, deadline];
  statementBytes({ domain: context.domain, kind: 4, publicInputs });
  return Object.freeze({ kind: 4,
    witness: { ...base, ...scoped(backing), inputs: own["inputs"]!, secrets: own["secrets"]!,
      siblings: own["siblings"]!, right: own["right"]!, anchors: anchors.map(decimal), tags: tags.map(decimal),
      backing: limbs(backing), quantity: decimal(quantity), presenter: limbs(presenter), instant: decimal(instant), deadline: decimal(deadline) },
    publicInputs: Object.freeze(publicInputs), capsules: Object.freeze([]) });
}

/** C3.5: the holder proves transfer to the backer's public opening, without its spend secret. */
export function settleTask(context: SegmentContext, inputs: readonly NoteInput[], output: Pick<OutputNote, "opening" | "cm">,
  demand: Uint8Array): ProofTask {
  const { prefix, base, scoped } = prefixOf(context), own = inputsOf(inputs), { opening } = output;
  const publicInputs = [...prefix, ...limbsOf(opening.backing), opening.value, opening.owner, opening.rho,
    ...inputs.map(i => i.anchor), ...inputs.map(i => i.note.nf), output.cm, ...limbsOf(demand)];
  statementBytes({ domain: context.domain, kind: 6, publicInputs });
  return Object.freeze({ kind: 6,
    witness: { ...base, ...scoped(opening.backing), ...own, backing: limbs(opening.backing), quantity: decimal(opening.value),
      owner: decimal(opening.owner), rho_out: decimal(opening.rho), cm_out: decimal(output.cm), demand: limbs(demand) },
    publicInputs: Object.freeze(publicInputs), capsules: Object.freeze([]) });
}

/** C2b.5.1: one real note's segment-free request, with a holder-chosen refresh value. */
export function requestTask(domain: Uint8Array, input: NoteInput, refresh: bigint): ProofTask {
  const { note, anchor, path } = input, tag = tagOf(note.nf);
  const publicInputs = [...limbsOf(domain), ...limbsOf(note.opening.backing), anchor, tag, refresh];
  statementBytes({ domain, kind: 7, publicInputs });
  return Object.freeze({ kind: 7,
    witness: { domain: limbs(domain), backing: limbs(note.opening.backing), anchor: decimal(anchor), tag: decimal(tag),
      refresh: decimal(refresh), note: noteOf(note.opening), secret: decimal(note.secret),
      siblings: path.siblings.map(decimal), right: [...path.right] },
    publicInputs: Object.freeze(publicInputs), capsules: Object.freeze([]) });
}

/** C3.6: a proofless withdrawal, signed by the holder's demand presenter for this segment. */
export function withdrawalRecord(context: SegmentContext, demand: Uint8Array, presenterSecret: Uint8Array): Record {
  const { prefix } = prefixOf(context);
  const record: Record = { domain: context.domain, kind: 5, publicInputs: [...prefix, ...limbsOf(demand)],
    proof: new Uint8Array(), authorization: new Uint8Array(), capsules: [] };
  return decodeRecord(encodeRecord({ ...record, authorization: ed25519.sign(withdrawalBytes(record), presenterSecret) }));
}

/** C3.4: the backer signs its public owner; it retains the corresponding settlement spend secret. */
export function authorizeAcceptance(acceptance: Acceptance, issuerSecret: Uint8Array): SignedAcceptance {
  const own = { domain: copyBytes(acceptance.domain), demand: copyBytes(acceptance.demand),
    owner: acceptance.owner, deadline: acceptance.deadline };
  return Object.freeze({ ...own, signature: ed25519.sign(acceptanceBytes(own), issuerSecret) });
}

/** C3.6: bind the presenter's release to this exact settlement and matching acceptance.
 * The reader still checks the backer's signature, standing demand, tags and deadlines. */
export function authorizeSettlement(record: Record, acceptance: SignedAcceptance, presenterSecret: Uint8Array): Record {
  if (record?.kind !== 6) throw new EncodingError("only a settlement carries a release");
  statementBytes(record); acceptanceBytes(acceptance);
  const demand = identifierOf(record.publicInputs[15]!, record.publicInputs[16]!);
  if (compareBytes(record.domain, acceptance.domain) !== 0 || compareBytes(demand, acceptance.demand) !== 0 ||
      record.publicInputs[8] !== acceptance.owner) throw new EncodingError("the acceptance does not match the settlement");
  const release = releaseBytes(record.domain, demand, acceptanceId(acceptance), statementHash(record));
  const authorization = encodeSettlementAuthorization(acceptance.deadline, acceptance.signature, ed25519.sign(release, presenterSecret));
  return decodeRecord(encodeRecord({ ...record, authorization }));
}
