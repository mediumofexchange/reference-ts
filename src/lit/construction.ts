// Lit-v1's view for the one state machine (pool/v3/state.ts, slice 14 M14c; lit-v1 §7, a draft until adopted): a
// lit record is judged by the pool's rules with §7's readings, named here rather than branched there. Inputs are
// live when their commitment is an output of the visible state (`INPUT`, the anchors' place); the statement check in
// the proof's place is the statement's own arithmetic (`ARITHMETIC`) and its owners' signatures (`SIGNATURE`); every
// output's commitment is derived (§2), never carried. A settlement repeats none of its demand's notes: its nullifiers
// and output are its standing demand's, which the store keeps with the demand. The namespace keeps no note tree.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared, EncodingError } from "../bytes.js";
import type {
  Construction, FaultTarget, PublicationView, ReaderFrames, ReceiptView, RequestView, StatementView,
} from "../pool/v3/construction.js";
import type { VerifierIdentities } from "../pool/v3/configuration.js";
import { requireReplay } from "../pool/v3/refusals.js";
import type { Demand } from "../pool/v3/replay-store.js";
import type { RootTerms, TermsCodec } from "../pool/v3/terms.js";
import {
  decodeReceipt, decodeSnapshot, genesisEvidenceHash, genesisHistoryHash, nextEvidenceHash, nextHistoryHash, receiptMatchesEvent,
  snapshotBytes, snapshotDigest, verifyReceipt,
} from "./commitments.js";
import { CONSTRUCTION, litConfigHash, litConfigurationBytes } from "./configuration.js";
import { decodeFaultEvidence, intrinsicFailures, verifyFaultEvidence } from "./fault-evidence.js";
import { noteCommitment, noteNullifier, noteTag, spendRho, issueRho, type Opening, type Output } from "./notes.js";
import {
  arithmeticHolds, decodePublication, decodeRecord, encodeRecord, evidencePair, hashEvidenceFields, splitRecord, ownerSignaturesVerify,
  settlementAuthorization, statementHash, statementSignatureVerifies, type LitRecord,
} from "./records.js";
import { LIT_TERMS } from "./terms.js";
import { LIT_HEADERS, LIT_PACKAGES, LIT_TRAILS, MAX_LIT_TRAIL_RECORD_BYTES } from "./transport.js";
import { verifySignatureStrict } from "../keys.js";

const keyOf = (bytes: Uint8Array): bigint => BigInt(`0x${hex(bytes)}`);
const bytesOf = (key: bigint): Uint8Array => Uint8Array.from(Buffer.from(key.toString(16).padStart(64, "0"), "hex"));
/** Distinct backings in first-named order. */
function distinct(backings: readonly Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const backing of backings) if (!out.some(b => compareBytes(b, backing) === 0)) out.push(backing);
  return out;
}

/** The view of a decoded lit record of kinds 1–6 (a request is refused as `KIND` before any view). It never throws on
 * one: a demand's sum past a u64 or mixed backings is left for `ARITHMETIC`, and a settlement whose demand does not
 * stand names no nullifier or output and is refused as `DEMAND` first. */
function litView(record: LitRecord, demandOf: (id: string) => Demand | undefined): StatementView {
  const s = record.statement, kind = s.kind;
  if (kind === 7) throw new TypeError("a request is never a history event");
  const identity = statementHash(s), pair = evidencePair(record), domain = s.domain;
  const base = {
    kind, identity, domain, segment: s.segment, scope: undefined,
    // A lit record has no proof: the store keeps an empty proof digest, which no lit frame reads (§5).
    digests: { statementHash: pair.statementHash, proofHash: new Uint8Array(0), signatureHash: pair.signatureHash },
    backings: [] as Uint8Array[], ended: undefined as string | undefined, needsDemand: false, quantity: undefined as bigint | undefined,
    nfs: [] as bigint[], tags: [] as bigint[], outputs: [] as bigint[], capsules: [] as undefined[], roots: [] as bigint[],
    inputs: [] as bigint[], demand: undefined as StatementView["demand"],
    check: (): void => {},
    issuerSigned: (issuer: Uint8Array): boolean => kind === 1 && statementSignatureVerifies(record, issuer),
    withdrawalSigned: (presenter: Uint8Array): boolean => kind === 5 && statementSignatureVerifies(record, presenter),
    settlement: (): ReturnType<StatementView["settlement"]> => { throw new TypeError("not a settlement"); },
  };
  const created = (outputs: readonly Output[], rho: (output: Output, j: number) => Uint8Array): bigint[] =>
    outputs.map((output, j) => keyOf(noteCommitment(domain, { ...output, rho: rho(output, j) })));
  // The statement check of kinds 2–4: its own arithmetic, then each input's owner signature, in input order (§§3, 6).
  const owned = (): void => {
    requireReplay(arithmeticHolds(s), "ARITHMETIC");
    requireReplay(ownerSignaturesVerify(record), "SIGNATURE");
  };
  switch (s.kind) {
    case 1: return { ...base, backings: [s.backing], quantity: s.quantity,
      outputs: created([{ backing: s.backing, value: s.quantity, owner: s.owner }], output => issueRho(output, s.nonce)) };
    case 2: case 3: case 4: {
      const cms = s.inputs.map((input: Opening) => noteCommitment(domain, input)), nfs = cms.map(noteNullifier);
      const tags = nfs.map(nf => keyOf(noteTag(nf))), inputs = cms.map(keyOf);
      if (s.kind === 4) {
        const value: Demand = { backing: Uint8Array.from(s.inputs[0]!.backing), quantity: s.inputs.reduce((sum, input) => sum + input.value, 0n),
          tags: [tags[0]!, tags[1] ?? 0n], presenter: Uint8Array.from(s.presenter), instant: s.instant, deadline: s.deadline,
          nullifiers: nfs.map(keyOf) };
        return { ...base, backings: distinct(s.inputs.map(input => input.backing)), inputs, check: owned, demand: { id: hex(identity), value } };
      }
      return { ...base, backings: distinct([...s.inputs, ...s.outputs].map(note => note.backing)), quantity: s.kind === 3 ? s.quantity : undefined,
        nfs: nfs.map(keyOf), tags, inputs, check: owned, outputs: created(s.outputs, (_, j) => spendRho(nfs, j)) };
    }
    case 5: return { ...base, ended: hex(s.demand), needsDemand: true };
    case 6: {
      const ended = hex(s.demand), demand = demandOf(ended);
      const settlement = (): ReturnType<StatementView["settlement"]> => {
        const auth = settlementAuthorization(record);
        return { deadline: auth.acceptance.deadline, signed: (issuer: Uint8Array, presenter: Uint8Array): boolean =>
          verifySignatureStrict(auth.acceptance.signature, auth.acceptanceMessage, issuer) &&
          verifySignatureStrict(auth.releaseSignature, auth.releaseMessage, presenter) };
      };
      if (demand?.nullifiers === undefined) return { ...base, ended, needsDemand: true, settlement };
      // §3: the demand's backing and quantity to the settlement's owner, over the demand's nullifiers in input order.
      const nfs = demand.nullifiers, rho = spendRho(nfs.map(bytesOf), 0);
      return { ...base, ended, needsDemand: true, settlement, quantity: demand.quantity, nfs: [...nfs], tags: demand.tags.slice(0, nfs.length),
        outputs: [keyOf(noteCommitment(domain, { backing: demand.backing, value: demand.quantity, owner: s.owner, rho }))] };
    }
  }
}

/** §6's fault-evidence target: its intrinsic failures (`ARITHMETIC`, owners' and K's `SIGNATURE`), each one §9.1 may
 * exclude by. No verifier is asked; the demand's keys a withdrawal or settlement needs are state, so none is reported. */
function litFaultTarget(payload: Uint8Array, maxSuffixEntries: bigint): FaultTarget {
  const value = decodeFaultEvidence(payload, maxSuffixEntries);
  return {
    snapshot: value.snapshot, position: value.position, length: value.length,
    digests: hashEvidenceFields(value.statement, value.authorization), demand: undefined,
    verify: (expected, max) => verifyFaultEvidence(expected, value, max),
    observe: async ({ domain, scopedTerms }) => {
      if (compareBytes(domain, litConfigHash()) !== 0) return [];
      const failures = intrinsicFailures(value.statement, value.authorization, backing => scopedTerms.get(hex(backing))?.obligor);
      return failures.map(failure => ({ intrinsic: true, observation: failure.check === "ARITHMETIC" ? { check: "ARITHMETIC" as const } :
        { check: "SIGNATURE" as const, authorizationRole: failure.role, signer: hex(failure.signer), authorizationBacking: hex(failure.backing) } }));
    },
  };
}

const NO_IDENTITIES: VerifierIdentities = Object.freeze({});
const LIT_READER: ReaderFrames = Object.freeze({
  specification: "lit-v1 7e1ddd5",
  domain: litConfigHash,
  verifyConfiguration: (bytes: Uint8Array): boolean => {
    try { return compareBytes(copyUnshared(bytes), litConfigurationBytes()) === 0; } catch (error) {
      if (error instanceof EncodingError) return false;
      throw error;
    }
  },
  // No circuit, key or parameter (§9): a verifier naming any is another construction's.
  verifierIdentities: (identities: VerifierIdentities | undefined): VerifierIdentities => {
    if (identities !== undefined && (identities === null || typeof identities !== "object" || Reflect.ownKeys(identities).length !== 0)) {
      throw new TypeError("a lit reader takes no circuit identities");
    }
    return NO_IDENTITIES;
  },
  proofs: false,
  scopeRoot: () => undefined,
  header: LIT_HEADERS,
  trail: Object.freeze({ ...LIT_TRAILS, maxRecordBytes: MAX_LIT_TRAIL_RECORD_BYTES }),
  package: LIT_PACKAGES,
  // Lit's silence clause names its duration alone (§9); the walk reads nothing else of it.
  terms: LIT_TERMS as unknown as TermsCodec<RootTerms>,
  snapshot: Object.freeze({ bytes: snapshotBytes, digest: snapshotDigest, decode: decodeSnapshot }),
  receipt: (bytes: Uint8Array): ReceiptView => {
    const receipt = decodeReceipt(bytes);
    return { segment: receipt.segment, position: receipt.position, after: receipt.after, operator: receipt.operator,
      // §5: no scope root; the segment identity binds the scope.
      verify: ({ domain, operator }) => verifyReceipt({ domain, segment: receipt.segment, operator }, receipt),
      matches: event => receiptMatchesEvent(receipt, event) };
  },
  // §6: the pair needs only §3's split, so a record that splits authenticates whether or not it decodes, and fails replay.
  digests: (bytes: Uint8Array) => {
    const { statement, authorization } = splitRecord(bytes);
    return { ...hashEvidenceFields(statement, authorization), proofHash: new Uint8Array(0) };
  },
  publication: (bytes: Uint8Array): PublicationView => {
    const p = decodePublication(bytes);
    return { domain: p.domain, backing: p.backing, kind: p.kind, record: p.kind === 2 ? undefined : encodeRecord(p.record) };
  },
  // C2b.5.2 as §7 reads it: the owner's signature in the proof's place, the input commitment an output of the state.
  request: (bytes: Uint8Array): RequestView => {
    const record = decodeRecord(bytes), s = record.statement;
    if (s.kind !== 7) throw new EncodingError("not a request");
    const cm = noteCommitment(s.domain, s.input), input = keyOf(cm);
    return { identity: hex(statementHash(s)), tag: keyOf(noteTag(noteNullifier(cm))), reads: state => state.hasOutput(input),
      holds: () => ownerSignaturesVerify(record) };
  },
  fault: litFaultTarget,
});

/** Lit-v1: §3 records, §2's derived outputs, §5's chains with the evidence pair and no note root, no note tree. */
export const LIT: Construction<LitRecord> = Object.freeze({
  namespace: Object.freeze({ name: CONSTRUCTION, tree: false }),
  decode: decodeRecord,
  kind: (record: LitRecord) => record.statement.kind,
  view: litView,
  genesisHistory: genesisHistoryHash,
  genesisEvidence: genesisEvidenceHash,
  nextHistory: (previous: Uint8Array, identity: Uint8Array, _noteRoot: bigint, spentRoot: Uint8Array, position: bigint) =>
    nextHistoryHash(previous, identity, spentRoot, position),
  nextEvidence: (previous: Uint8Array, digests: { readonly statementHash: Uint8Array; readonly signatureHash: Uint8Array }, position: bigint) =>
    nextEvidenceHash(previous, { statementHash: digests.statementHash, signatureHash: digests.signatureHash }, position),
  capacity: undefined,
  settledDemand: (bytes: Uint8Array) => {
    const s = decodeRecord(bytes).statement;
    if (s.kind !== 6) throw new TypeError("not a settlement");
    return hex(s.demand);
  },
  reader: LIT_READER,
});
