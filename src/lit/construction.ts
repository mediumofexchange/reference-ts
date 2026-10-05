// Lit-v1's view for the one state machine (pool/v3/state.ts, slice 14 M14c; lit-v1 §7, a draft until adopted): a
// lit record is judged by the pool's rules with §7's readings, named here rather than branched there. Inputs are
// live when their commitment is an output of the visible state (`INPUT`, the anchors' place); the statement check in
// the proof's place is the statement's own arithmetic (`ARITHMETIC`) and its owners' signatures (`SIGNATURE`); every
// output's commitment is derived (§2), never carried. A settlement repeats none of its demand's notes: its nullifiers
// and output are its standing demand's, which the store keeps with the demand. The namespace keeps no note tree.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../bytes.js";
import type { Construction, StatementView } from "../pool/v3/construction.js";
import { requireReplay } from "../pool/v3/refusals.js";
import type { Demand } from "../pool/v3/replay-store.js";
import { genesisEvidenceHash, genesisHistoryHash, nextEvidenceHash, nextHistoryHash } from "./commitments.js";
import { CONSTRUCTION } from "./configuration.js";
import { noteCommitment, noteNullifier, noteTag, spendRho, issueRho, type Opening, type Output } from "./notes.js";
import {
  arithmeticHolds, decodeRecord, evidencePair, ownerSignaturesVerify, settlementAuthorization, statementHash,
  statementSignatureVerifies, type LitRecord,
} from "./records.js";
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
    settlement: undefined as StatementView["settlement"],
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
      const ended = hex(s.demand), demand = demandOf(ended), auth = settlementAuthorization(record);
      const settlement = { deadline: auth.acceptance.deadline, signed: (issuer: Uint8Array, presenter: Uint8Array): boolean =>
        verifySignatureStrict(auth.acceptance.signature, auth.acceptanceMessage, issuer) &&
        verifySignatureStrict(auth.releaseSignature, auth.releaseMessage, presenter) };
      if (demand?.nullifiers === undefined) return { ...base, ended, needsDemand: true, settlement };
      // §3: the demand's backing and quantity to the settlement's owner, over the demand's nullifiers in input order.
      const nfs = demand.nullifiers, rho = spendRho(nfs.map(bytesOf), 0);
      return { ...base, ended, needsDemand: true, settlement, quantity: demand.quantity, nfs: [...nfs], tags: demand.tags.slice(0, nfs.length),
        outputs: [keyOf(noteCommitment(domain, { backing: demand.backing, value: demand.quantity, owner: s.owner, rho }))] };
    }
  }
}

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
});
