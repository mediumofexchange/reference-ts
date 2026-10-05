// What the one state machine (state.ts) reads of a record, whatever its construction (slice 14 M14c): a
// construction decodes its own bytes and names, in one neutral view, the statement's context, the backings it
// names, the nullifiers it spends with their tags, the outputs it creates, what it reads in the state (anchors or
// input commitments), its recovery effect and its checks in the proof's place. Every mode rule, ordering,
// continuity, revocation, supply, lock and uniqueness check stays in state.ts and recovery.ts, once. This file
// holds pool-v3's adapter; lit-v1's is src/lit/construction.ts.
import { verifySignatureStrict } from "../../keys.js";
import { identifierOf } from "../field.js";
import { NOTE_TREE_CAPACITY } from "../note-tree.js";
import { genesisEvidenceHash, genesisHistoryHash, nextEvidenceHash, nextHistoryHash } from "./commitments.js";
import { decodeRecord, evidenceHashes, settlementAuthorization, statementBytes, statementHash, withdrawalBytes, type EvidenceDigests,
  type Record } from "./records.js";
import { effectOf, recoveryEffect, tagOf } from "./recovery.js";
import { requireReplay } from "./refusals.js";
import { POOL_V3_NAMESPACE, type Demand, type NamespaceConstruction } from "./replay-store.js";
import type { ProofCheck } from "./state.js";

/** One record as the state machine reads it. A view is built from a record that decoded; building it never throws
 * on one, whatever the state (a construction's derived values that need a check are read only after it). */
export interface StatementView {
  readonly kind: number;
  readonly identity: Uint8Array;
  readonly domain: Uint8Array;
  readonly segment: Uint8Array;
  /** Pool-v3's scope root; a construction whose segment identity binds its scope names none. */
  readonly scope: bigint | undefined;
  readonly digests: EvidenceDigests;
  /** The backings the record names or derives from its own bytes, each held and scoped. A record that reads its
   * backing from the demand it ends names none here (`needsDemand`); a v3 spend names none at all. */
  readonly backings: readonly Uint8Array[];
  /** The demand a kind 5 or 6 ends (hex identity). */
  readonly ended: string | undefined;
  /** Whether the record reads its ended demand to be judged at all: it is refused as `DEMAND` where that demand
   * does not stand, before the statement check. */
  readonly needsDemand: boolean;
  /** An issue's or burn's quantity (supply), or a settlement's (its demand's). */
  readonly quantity: bigint | undefined;
  /** The nullifiers spent, and each one's tag, aligned. */
  readonly nfs: readonly bigint[];
  readonly tags: readonly bigint[];
  /** The output commitments created, in order, and each one's capsule where the construction carries one. */
  readonly outputs: readonly bigint[];
  readonly capsules: readonly (Uint8Array | undefined)[];
  /** Note-tree roots the record's inputs are anchored at (`ANCHOR`). */
  readonly roots: readonly bigint[];
  /** Commitments the record's inputs open, each an output of the visible state (`INPUT`). */
  readonly inputs: readonly bigint[];
  /** The demand a kind 4 stands up. */
  readonly demand: { readonly id: string; readonly value: Demand } | undefined;
  /** The statement check in the proof's place: a refusal throws ReplayRefusal; the verifier's own failures propagate. */
  check(verifier: ProofCheck): Promise<void> | void;
  /** An issue's signature under K. */
  issuerSigned(issuer: Uint8Array): boolean;
  /** A withdrawal's signature under its demand's presenter key. */
  withdrawalSigned(presenter: Uint8Array): boolean;
  /** A settlement's acceptance deadline and its two signatures: the acceptance under K, the release under the presenter. */
  readonly settlement: { readonly deadline: bigint; signed(issuer: Uint8Array, presenter: Uint8Array): boolean } | undefined;
}

/** A construction's record codec, view and chains, as the state machine and its store read them. */
export interface Construction<R = unknown> {
  readonly namespace: NamespaceConstruction;
  /** The record codec; an EncodingError propagates as a malformed record. */
  decode(bytes: Uint8Array): R;
  kind(record: R): number;
  /** The view, reading a demand the record ends where `needsDemand` (undefined where it does not stand). */
  view(record: R, demand: (id: string) => Demand | undefined): StatementView;
  genesisHistory(segment: Uint8Array): Uint8Array;
  genesisEvidence(segment: Uint8Array): Uint8Array;
  nextHistory(previous: Uint8Array, identity: Uint8Array, noteRoot: bigint, spentRoot: Uint8Array, position: bigint): Uint8Array;
  nextEvidence(previous: Uint8Array, digests: EvidenceDigests, position: bigint): Uint8Array;
  /** The outputs a namespace may hold, where its note tree bounds them. */
  readonly capacity: bigint | undefined;
  /** The demand a stored settlement record ends (C3.8's taken release). */
  settledDemand(bytes: Uint8Array): string;
}

function v3View(record: Record): StatementView {
  const p = record.publicInputs, kind = record.kind, { nfs, outputs, roots } = effectOf(record), { demand, ended } = recoveryEffect(record);
  return {
    kind, identity: statementHash(record), domain: record.domain, segment: identifierOf(p[2]!, p[3]!), scope: p[4],
    digests: evidenceHashes(record), backings: kind === 2 || kind === 5 ? [] : [identifierOf(p[5]!, p[6]!)], ended, needsDemand: kind === 5,
    quantity: kind === 1 || kind === 3 || kind === 6 ? p[7] : undefined, nfs, tags: nfs.map(tagOf), outputs,
    capsules: outputs.map((_, i) => (kind === 6 ? undefined : record.capsules[i])), roots, inputs: [], demand,
    check: async (verifier: ProofCheck): Promise<void> => {
      if (kind !== 5) requireReplay(await verifier.verify(kind, [...p], new Uint8Array(record.proof)) === true, "PROOF");
    },
    issuerSigned: issuer => kind === 1 && verifySignatureStrict(record.authorization, statementBytes(record), issuer),
    withdrawalSigned: presenter => kind === 5 && verifySignatureStrict(record.authorization, withdrawalBytes(record), presenter),
    settlement: kind !== 6 ? undefined : (() => {
      const auth = settlementAuthorization(record);
      return { deadline: auth.acceptance.deadline, signed: (issuer: Uint8Array, presenter: Uint8Array): boolean =>
        verifySignatureStrict(auth.acceptance.signature, auth.acceptanceMessage, issuer) &&
        verifySignatureStrict(auth.releaseSignature, auth.releaseMessage, presenter) };
    })(),
  };
}

/** Pool-v3: §5 records, proofs, anchors in the note tree, the evidence triple and the history over the note root. */
export const POOL_V3: Construction<Record> = Object.freeze({
  namespace: POOL_V3_NAMESPACE,
  decode: decodeRecord,
  kind: (record: Record) => record.kind,
  view: (record: Record) => v3View(record),
  genesisHistory: genesisHistoryHash,
  genesisEvidence: genesisEvidenceHash,
  nextHistory: nextHistoryHash,
  nextEvidence: nextEvidenceHash,
  capacity: NOTE_TREE_CAPACITY,
  settledDemand: (bytes: Uint8Array) => recoveryEffect(decodeRecord(bytes)).ended!,
});

