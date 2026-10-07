// What the one state machine (state.ts) reads of a record, whatever its construction (slice 14 M14c): a
// construction decodes its own bytes and names, in one neutral view, the statement's context, the backings it
// names, the nullifiers it spends with their tags, the outputs it creates, what it reads in the state (anchors or
// input commitments), its recovery effect and its checks in the proof's place. Every mode rule, ordering,
// continuity, revocation, supply, lock and uniqueness check stays in state.ts and recovery.ts, once. This file
// holds pool-v3's adapter; lit-v1's is src/lit/construction.ts. The readers (package-reader.ts, scope-reader.ts,
// reader.ts) read a construction's frames beside it (`reader`, slice 14 M14d); the operator journal (store.ts) also writes
// its records, receipts and configuration item (`journal`, M14f).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { verifySignatureStrict } from "../../keys.js";
import { identifierOf } from "../field.js";
import { ScopeTree } from "../scope.js";
import { authorizationFaults, type AuthorizationFault } from "./authorization-evidence.js";
import {
  decodeReceipt, decodeSnapshot, encodeReceipt, genesisEvidenceHash, genesisHistoryHash, nextEvidenceHash, nextHistoryHash, receiptBytes,
  receiptMatchesEvent, snapshotBytes, snapshotDigest, verifyReceipt, type Receipt, type Snapshot,
} from "./commitments.js";
import { adoptedConfigurationBytes, adoptedDomain, requireConfigurationVerifier, verifyConfiguration, type VerifierIdentities } from "./configuration.js";
import { decodeFaultEvidence, verifyFaultEvidence, type ExpectedSnapshot } from "./fault-evidence.js";
import { V3_HEADERS, type SegmentHeader, type SegmentHeaderCodec } from "./headers.js";
import { V3_PACKAGES, type PackageCodec } from "./package.js";
import {
  acceptanceBytes, acceptanceId, decodePublication, decodeRecord, decodeStatement, encodeRecord, evidenceHashes, hashEvidenceFields, settlementAuthorization,
  statementBytes, statementHash, withdrawalBytes, type EvidenceDigests, type Record, type SignedAcceptance, type Statement,
} from "./records.js";
import { effectOf, recoveryEffect, tagOf } from "./recovery.js";
import { requireReplay } from "./refusals.js";
import { POOL_V3_NAMESPACE, type Demand, type NamespaceConstruction } from "./replay-store.js";
import type { ProofCheck, ReceiptEvent, ScanOutput, StateHandle, StateView, WitnessPredicate } from "./state.js";
import { V3_TERMS, type RootTerms, type TermsCodec } from "./terms.js";
import { MAX_TRAIL_RECORD_BYTES, V3_TRAILS, type TrailCodec } from "./trail.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

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
  /** A settlement's acceptance deadline and its two signatures (the acceptance under K, the release under the
   * presenter), read only at recovery's settlement checks: building them may refuse bytes a decoder accepts (pool-v3's
   * zero acceptance owner), which every earlier check must have the chance to refuse by name first. */
  settlement(): { readonly deadline: bigint; signed(issuer: Uint8Array, presenter: Uint8Array): boolean };
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
  /** The demand a stored settlement record ends (C3.8's taken release). */
  settledDemand(bytes: Uint8Array): string;
  /** Output `i` (commitment `cm`) of a judged record as a wallet's witness predicate reads it (slice 14 M14g); `demand`
   * is the standing demand a settlement ends. */
  scanOutput(record: R, view: StatementView, cm: bigint, i: number, demand: Demand | undefined): ScanOutput;
  /** The frames and objects the readers read (slice 14 M14d). */
  readonly reader: ReaderFrames;
  /** What an operator's journal writes besides (slice 14 M14f). */
  readonly journal: JournalFrames<R>;
  /** What the one wallet (wallet-store.ts) reads and builds for a construction whose notes are held by owner keys
   * (lit-v1 §8, slice 14 M14g); pool-v3's wallet path is the wallet's own, so it names none. */
  readonly wallet?: KeyedWalletFrames | undefined;
}

/** A note's public opening where openings are public (lit-v1 §2). */
export interface KeyedOpening {
  readonly backing: Uint8Array; readonly value: bigint; readonly owner: Uint8Array; readonly rho: Uint8Array;
}
/** An output as a statement carries it: backing, value and owner key. */
export interface KeyedOutput { readonly backing: Uint8Array; readonly value: bigint; readonly owner: Uint8Array }
/** A request by owner key (lit-v1 §8): the backing, the quantity and this request's own key. */
export interface KeyedRequest {
  readonly domain: Uint8Array; readonly backing: Uint8Array; readonly value: bigint; readonly owner: Uint8Array;
}
/** How a note is a wallet's: an owner key of a backing and index, or a settlement's acceptance (lit-v1 §8). */
export type KeyedOwner = { readonly backing: Uint8Array; readonly index: bigint; readonly acceptance?: never } |
  { readonly backing?: never; readonly index?: never; readonly acceptance: { readonly demand: Uint8Array; readonly deadline: bigint } };
/** A wallet's note found by its key: its opening, commitment, nullifier and tag (C3.3), how it is the wallet's, and the
 * namespace and position of the statement that created it. */
export interface KeyedNote {
  readonly opening: KeyedOpening;
  readonly cm: bigint;
  readonly nf: bigint;
  readonly tag: bigint;
  readonly owner: KeyedOwner;
  readonly ns: number;
  readonly position: bigint;
  readonly local: boolean;
}
/** A wallet's owner keys by backing and index (public keys derived once per handle; secrets derived when spent). */
export interface Keyring {
  key(backing: Uint8Array, index: bigint): Uint8Array;
  /** The caller zeroes it after use. */
  secret(backing: Uint8Array, index: bigint): Uint8Array;
  /** The backing and index whose key is `owner`, among those derived (each held backing's window, from a read's scan). */
  find(owner: Uint8Array): { readonly backing: Uint8Array; readonly index: bigint } | undefined;
  close(): void;
}
/** K's acceptance where an acceptance owner is a key (lit-v1 §4): the demand, the owner, the deadline, K's signature and the
 * owner key's, each over the acceptance bytes. */
export interface KeyedAcceptance {
  readonly domain: Uint8Array; readonly demand: Uint8Array; readonly owner: Uint8Array; readonly deadline: bigint; readonly signature: Uint8Array;
  readonly ownerSignature: Uint8Array;
}
/** A receipt of a construction without a scope root or proof digest (lit-v1 §5). */
export interface KeyedReceipt {
  readonly domain: Uint8Array; readonly segment: Uint8Array; readonly position: bigint; readonly statementHash: Uint8Array;
  readonly historyHash: Uint8Array; readonly signatureHash: Uint8Array; readonly after: bigint;
  readonly operator: Uint8Array; readonly signature: Uint8Array;
}
/** A note to spend: its opening and its owner's secret (the caller zeroes it). */
export interface KeyedInput { readonly opening: KeyedOpening; readonly secret: Uint8Array }
/** What the one wallet reads and builds for a construction whose notes are held by owner keys (lit-v1 §8). */
export interface KeyedWalletFrames {
  /** §8's look-ahead: 256 indices. */
  readonly lookAhead: bigint;
  /** The scan window of a backing whose found index is `h` (−1 for none). */
  window(h: bigint): bigint;
  keyring(seed: Uint8Array, domain: Uint8Array): Keyring;
  /** The replay's witness predicate over each held backing's window (hex name to window). */
  witness(seed: Uint8Array, domain: Uint8Array, windows: ReadonlyMap<string, bigint>, keyring: Keyring): WitnessPredicate;
  /** The wallet's unspent notes of `backing` (spent ones too with `spent`) in a state replayed with its predicate, each
   * mark checked against its output and the seed's keys (KeptStateMismatch otherwise). */
  notes(seed: Uint8Array, domain: Uint8Array, backing: Uint8Array, state: StateHandle, keyring: Keyring, spent?: boolean): KeyedNote[];
  /** Per held backing (hex): §8's `h` and the highest index found in an output of it, spent ones included. */
  found(seed: Uint8Array, domain: Uint8Array, state: StateHandle, keyring: Keyring): Map<string, { readonly reached: bigint; readonly top: bigint }>;
  /** Whether the note's creating statement consumed notes, all of them the wallet's own. */
  ownFunded(state: StateHandle, note: KeyedNote): boolean;
  /** The note's spend secret, checked against its owner (KeptStateMismatch otherwise). */
  noteSecret(seed: Uint8Array, domain: Uint8Array, keyring: Keyring, note: KeyedNote): Uint8Array;
  /** A demand's presenter secret from its tags in input order, instant and deadline. */
  presentSecret(seed: Uint8Array, domain: Uint8Array, tags: readonly Uint8Array[], instant: bigint, deadline: bigint): Uint8Array;
  /** An owned request checked against the payer's agreed domain, backing and amount; EncodingError otherwise. */
  request(input: KeyedRequest, expected: { readonly domain: Uint8Array; readonly backing: Uint8Array; readonly value: bigint }): KeyedRequest;
  /** A spend's record signed by each input's owner in input order. */
  spend(domain: Uint8Array, segment: Uint8Array, inputs: readonly KeyedInput[], outputs: readonly KeyedOutput[]): Uint8Array;
  /** A burn of `quantity` from `inputs`, the rest to `change` (none where nothing is left), signed by their owners. */
  burn(domain: Uint8Array, segment: Uint8Array, quantity: bigint, inputs: readonly KeyedInput[], change: KeyedOutput | undefined): Uint8Array;
  /** A demand presenting `inputs` under `presenter` (a key), signed by their owners. */
  demand(domain: Uint8Array, segment: Uint8Array, inputs: readonly KeyedInput[], presenter: Uint8Array, instant: bigint, deadline: bigint): Uint8Array;
  /** A withdrawal of `demand` signed by the presenter secret (the caller zeroes it). */
  withdraw(domain: Uint8Array, segment: Uint8Array, demand: Uint8Array, presenter: Uint8Array): Uint8Array;
  /** A settlement of the acceptance's demand to its owner, the release signed by the presenter secret (the caller zeroes it). */
  settle(domain: Uint8Array, segment: Uint8Array, acceptance: KeyedAcceptance, presenter: Uint8Array): Uint8Array;
  /** K's issue nonce for `output`, from the backer wallet's seed (lit-v1 §8 leaves the derivation to K). */
  issueNonce(seed: Uint8Array, domain: Uint8Array, output: KeyedOutput): Uint8Array;
  /** An issue of `output` under `nonce`: the bytes K signs, the derived output's commitment, and the record carrying K's signature. */
  issue(domain: Uint8Array, segment: Uint8Array, output: KeyedOutput, nonce: Uint8Array):
    { readonly message: Uint8Array; readonly cm: bigint; record(signature: Uint8Array): Uint8Array };
  /** Whether an output with this opening is one this seed's issue nonce derives (lit-v1 §8: an issue the wallet made). */
  ownIssue(seed: Uint8Array, domain: Uint8Array, opening: KeyedOpening): boolean;
  /** K's acceptance owner for `demand` and `deadline`: `acceptSecret`'s key (lit-v1 §8). */
  acceptOwner(seed: Uint8Array, domain: Uint8Array, demand: Uint8Array, deadline: bigint): Uint8Array;
  /** The owner key's signature over the acceptance bytes, by `acceptSecret` of its demand and deadline (lit-v1 §§4, 8). */
  acceptSignature(seed: Uint8Array, acceptance: Omit<KeyedAcceptance, "signature" | "ownerSignature">): Uint8Array;
  /** The acceptance bytes K and the owner key sign (lit-v1 §4); EncodingError where a field is malformed. */
  acceptance(acceptance: Omit<KeyedAcceptance, "signature" | "ownerSignature">): Uint8Array;
  /** Publication kind 1, 3 or 4 of a demand, settlement or withdrawal record, or kind 2 of an acceptance, routed to `backing`. */
  publication(domain: Uint8Array, backing: Uint8Array, body: { readonly kind: 1 | 3 | 4; readonly record: Uint8Array } |
    { readonly kind: 2; readonly acceptance: KeyedAcceptance }): Uint8Array;
  /** A spend record's segment, inputs and outputs; EncodingError where the bytes are no spend. */
  spendOf(bytes: Uint8Array): { readonly segment: Uint8Array; readonly inputs: readonly KeyedOpening[]; readonly outputs: readonly KeyedOutput[] };
  /** A record's derived outputs in statement order, each with its commitment (a settlement's needs its demand: none here). */
  outputs(domain: Uint8Array, bytes: Uint8Array): { readonly cm: bigint; readonly opening: KeyedOpening }[];
  /** A note's commitment from its opening. */
  commitment(domain: Uint8Array, opening: KeyedOpening): bigint;
}

/** A receipt's fields (§7.2) as the journal names them for any construction: pool-v3's name its scope root and the
 * record's evidence triple, lit-v1's neither the scope root nor a proof digest (lit-v1 §5). */
export interface ReceiptFieldsOf {
  readonly domain: Uint8Array;
  readonly segment: Uint8Array;
  /** Pool-v3's scope root; undefined for a construction whose segment identity binds its scope. */
  readonly scopeRoot: bigint | undefined;
  readonly position: bigint;
  readonly digests: EvidenceDigests;
  readonly historyHash: Uint8Array;
  readonly after: bigint;
}
/** What an operator's journal (store.ts) writes of a construction besides the frames the readers read (slice 14 M14f). */
export interface JournalFrames<R = unknown> {
  /** A decoded record's canonical bytes, which the journal admits and keeps. */
  encode(record: R): Uint8Array;
  /** Its statement identity, by which an exact replay is answered (invariant 26). */
  identity(record: R): Uint8Array;
  /** The configuration bytes a package's kind-1 item carries: a fresh copy. */
  configuration(): Uint8Array;
  /** The receipt record for `fields` under `operator`'s key; `sign` signs the receipt message with its secret. */
  receipt(fields: ReceiptFieldsOf, operator: Uint8Array, sign: (message: Uint8Array) => Uint8Array): Uint8Array;
  /** The receipt records it writes, as a submitter reads them: the service's reply and a wallet's kept receipt (slice 14 M14g3). */
  readonly receipts: ReceiptCodec;
}
/** An operator's receipt record (§7.2) of either construction: pool-v3's names its scope root and proof digest, lit-v1's neither (lit-v1 §5). */
export type OperatorReceipt = Receipt | KeyedReceipt;
/** A construction's receipt codec, as a submitter reads the receipt an operator returns. */
export interface ReceiptCodec {
  /** EncodingError where the bytes are no receipt of this construction. */
  decode(bytes: Uint8Array): OperatorReceipt;
  encode(receipt: OperatorReceipt): Uint8Array;
  /** Whether `operator` signed it under `domain` in `segment`, under `scopeRoot` where the construction's receipts name one
   * (pool-v3) and none where they do not (lit-v1). */
  verify(authority: { readonly domain: Uint8Array; readonly segment: Uint8Array; readonly scopeRoot: bigint | undefined; readonly operator: Uint8Array },
    receipt: OperatorReceipt): boolean;
}

/** A receipt (§7.2) as a receipt walk reads it: the fields every construction's receipt names, and its checks. */
export interface ReceiptView {
  readonly segment: Uint8Array;
  readonly position: bigint;
  readonly after: bigint;
  readonly operator: Uint8Array;
  /** The exact signed fields under the segment's authority, read from its authenticated header. */
  verify(authority: { readonly domain: Uint8Array; readonly header: SegmentHeader; readonly operator: Uint8Array }): boolean;
  /** Whether its inclusion fields are an event's, already authenticated in a valid checkpoint of its segment. */
  matches(event: ReceiptEvent): boolean;
}
/** A publication (§6) as the walk routes it: kinds 1, 3, 4 and 5 carry a record, given as its canonical bytes. */
export interface PublicationView {
  readonly domain: Uint8Array;
  readonly backing: Uint8Array;
  readonly kind: 1 | 2 | 3 | 4 | 5;
  readonly record: Uint8Array | undefined;
}
/** An acceptance as C3.8's reading holds it (dishonour.ts), published on its own or carried by a release: decoded,
 * with its signatures checked only by `signed`, over the bytes it was decoded from (its fields are copies). */
export interface AcceptanceView {
  readonly demand: Uint8Array;
  readonly deadline: bigint;
  /** Pool-v3's field element, lit-v1's key. */
  readonly owner: bigint | Uint8Array;
  readonly id: Uint8Array;
  /** Whether it is an acceptance under K at all: K's strict signature, and lit-v1's owner key's as well (§§4, 7). */
  signed(obligor: Uint8Array): boolean;
}
/** A release (publication kind 3) as an answer carries it, besides its force verdict: the segment its settlement names
 * and, in pool-v3, C3.5's disclosure (the output with its `rho_out`, the presenter's signature with the exact message
 * it must sign). Lit-v1 has none (§7: §2's derivation replaces C3.5's count). The proof is not kept. */
export interface ReleaseView {
  readonly segment: Uint8Array;
  readonly disclosure: { readonly output: bigint; readonly rho: bigint; readonly releaseMessage: Uint8Array; readonly releaseSignature: Uint8Array } | undefined;
}
/** A publication of kind 2 (an acceptance) or 3 (a release carrying one), routed to `backing`. */
export interface AnswerView {
  readonly domain: Uint8Array;
  readonly backing: Uint8Array;
  readonly acceptance: AcceptanceView;
  readonly release: ReleaseView | undefined;
}
/** A request (publication kind 5) as C2b.5.2's count reads it. */
export interface RequestView {
  /** The statement identity (hex): variants of one statement count once. */
  readonly identity: string;
  readonly tag: bigint;
  /** Whether what it reads is in the canonical state: pool-v3's anchor, lit's input commitment as an output. */
  reads(state: Pick<StateView, "hasAnchor" | "hasOutput">): boolean;
  /** Its check in the proof's place: pool-v3's request proof, lit's owner signature. */
  holds(verifier: ProofCheck): Promise<boolean> | boolean;
}
/** One §9 observation of a fault-evidence target; pool-v3's `PROOF`, lit-v1's `ARITHMETIC`, either's signatures. */
export type FaultObservation = { readonly check: "PROOF" | "ARITHMETIC"; readonly authorizationRole?: never } | AuthorizationFault;
/** A decoded §9 fault-evidence item: its authenticated fields, and what its target shows. */
export interface FaultTarget {
  readonly snapshot: Snapshot;
  readonly position: bigint;
  readonly length: bigint;
  /** The target's digests as §5/§7.1 hash them: lit names no proof digest. */
  readonly digests: { readonly statementHash: Uint8Array; readonly proofHash?: Uint8Array; readonly signatureHash: Uint8Array };
  /** A demand statement the target carries (by hex identity), which another target's authorization facts may read. */
  readonly demand: { readonly id: string; readonly statement: unknown } | undefined;
  verify(expected: ExpectedSnapshot, maxSuffixEntries: bigint): boolean;
  /** The target's facts in report order, each marked where §9.1 lets it exclude (an intrinsic failure). A verifier's own
   * failure propagates wrapped, never as a verdict. */
  observe(context: { readonly domain: Uint8Array; readonly scopedTerms: ReadonlyMap<string, RootTerms>;
    readonly demands: ReadonlyMap<string, unknown>; readonly verifier: ProofCheck }): Promise<{ readonly observation: FaultObservation; readonly intrinsic: boolean }[]>;
}
/** What the package reader and the one walk (scope-reader.ts) read of a construction besides its records: its
 * configuration, verifier, transport frames, snapshots, receipts, terms, publications, requests and fault evidence. */
export interface ReaderFrames {
  /** The specification revision the readers implement for it, which names kept state (§14). */
  readonly specification: string;
  /** The configuration hash a reader selects it by: every statement's and object's domain. A fresh copy. */
  domain(): Uint8Array;
  /** Whether a package's configuration bytes (kind 1) are exactly the configuration's. */
  verifyConfiguration(bytes: Uint8Array): boolean;
  /** A reader's verifier identities checked against the configuration, as the copy kept state names; a TypeError otherwise. */
  verifierIdentities(identities: VerifierIdentities | undefined): VerifierIdentities;
  /** Whether its records carry proofs: a reader without them needs no verifier. */
  readonly proofs: boolean;
  /** The scope root a record and receipt name (pool-v3); undefined where the segment identity binds the scope. */
  scopeRoot(header: SegmentHeader): bigint | undefined;
  readonly header: SegmentHeaderCodec;
  readonly trail: TrailCodec & { readonly maxRecordBytes: number };
  readonly package: PackageCodec;
  /** Root terms under its construction clause. Lit's silence clause names no challenge window; the walk reads the duration alone. */
  readonly terms: TermsCodec<RootTerms>;
  readonly snapshot: { bytes(snapshot: Snapshot): Uint8Array; digest(snapshot: Snapshot): Uint8Array; decode(bytes: Uint8Array): Snapshot };
  /** EncodingError where the bytes are no receipt record. */
  receipt(bytes: Uint8Array): ReceiptView;
  /** A record's evidence digests; EncodingError where it does not decode. */
  digests(record: Uint8Array): EvidenceDigests;
  /** EncodingError where the bytes are no publication. */
  publication(bytes: Uint8Array): PublicationView;
  /** A publication's answer where it is of kind 2 or 3, undefined for another kind; EncodingError where malformed. */
  answer(bytes: Uint8Array): AnswerView | undefined;
  /** A request record's view (kind 7); EncodingError where it is none. */
  request(record: Uint8Array): RequestView;
  /** EncodingError where malformed; FaultEvidenceLimitError past the suffix budget. */
  fault(payload: Uint8Array, maxSuffixEntries: bigint): FaultTarget;
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
    settlement: () => {
      const auth = settlementAuthorization(record);
      return { deadline: auth.acceptance.deadline, signed: (issuer: Uint8Array, presenter: Uint8Array): boolean =>
        verifySignatureStrict(auth.acceptance.signature, auth.acceptanceMessage, issuer) &&
        verifySignatureStrict(auth.releaseSignature, auth.releaseMessage, presenter) };
    },
  };
}

/** Pool-v3 §9's target: the proof checked by the reader's verifier (cached per item) and §6's signature facts. */
function v3FaultTarget(payload: Uint8Array, maxSuffixEntries: bigint): FaultTarget {
  const value = decodeFaultEvidence(payload, maxSuffixEntries);
  let statement: Statement | undefined;
  try { statement = decodeStatement(value.statement); }
  catch (error) { if (!(error instanceof EncodingError)) throw error; }
  let rejected: boolean | undefined;
  return {
    snapshot: value.snapshot, position: value.position, length: value.length,
    digests: hashEvidenceFields(sha256(value.statement), value.proof, value.authorization),
    demand: statement?.kind === 4 ? { id: hex(sha256(value.statement)), statement } : undefined,
    verify: (expected, max) => verifyFaultEvidence(expected, value, max),
    async observe({ domain, scopedTerms, demands, verifier }) {
      if (statement === undefined || !same(statement.domain, domain)) return [];
      if (rejected === undefined) {
        rejected = false;
        if ([1, 2, 3, 4, 6].includes(statement.kind) && value.proof.length > 0 && value.proof.length % 32 === 0) {
          try { rejected = await verifier.verify(statement.kind, [...statement.publicInputs], new Uint8Array(value.proof)) === false; }
          catch (cause) {
            rejected = undefined;
            // Never let a verifier's error class enter classification catches.
            throw new Error("compact proof verifier failed", { cause });
          }
        }
      }
      // Scope-derived signers are resolved per mapping. An absent signer is never cached as validity or rejection.
      const observations: FaultObservation[] = [...(rejected ? [{ check: "PROOF" as const }] : []),
        ...authorizationFaults(statement, value, scopedTerms, demands as ReadonlyMap<string, Statement>)];
      // §9.1: a failing proof or K's issue signature is intrinsic; the other signatures need the demand's standing.
      return observations.map(observation => ({ observation, intrinsic: observation.check === "PROOF" || observation.authorizationRole === "issue" }));
    },
  };
}

/** C3.8's acceptance: K's strict signature over its bytes, fixed when the view is made. */
function v3Acceptance(a: SignedAcceptance): AcceptanceView {
  const message = acceptanceBytes(a);
  return { demand: new Uint8Array(a.demand), deadline: a.deadline, owner: a.owner, id: acceptanceId(a),
    signed: obligor => verifySignatureStrict(a.signature, message, obligor) };
}

const V3_READER: ReaderFrames = Object.freeze({
  specification: "pool-v3 e7f7f24",
  domain: adoptedDomain,
  verifyConfiguration,
  verifierIdentities: requireConfigurationVerifier,
  proofs: true,
  scopeRoot: (header: SegmentHeader) => new ScopeTree(header.entries).root(),
  header: V3_HEADERS,
  trail: Object.freeze({ ...V3_TRAILS, maxRecordBytes: MAX_TRAIL_RECORD_BYTES }),
  package: V3_PACKAGES,
  terms: V3_TERMS,
  snapshot: Object.freeze({ bytes: snapshotBytes, digest: snapshotDigest, decode: decodeSnapshot }),
  receipt: (bytes: Uint8Array): ReceiptView => {
    const receipt = decodeReceipt(bytes);
    return { segment: receipt.segment, position: receipt.position, after: receipt.after, operator: receipt.operator,
      verify: ({ domain, header, operator }) => verifyReceipt({ domain, segment: receipt.segment, scopeRoot: new ScopeTree(header.entries).root(), operator }, receipt),
      matches: event => receiptMatchesEvent(receipt, event) };
  },
  digests: (record: Uint8Array) => evidenceHashes(decodeRecord(record)),
  publication: (bytes: Uint8Array): PublicationView => {
    const p = decodePublication(bytes);
    return { domain: p.domain, backing: p.backing, kind: p.kind, record: p.kind === 2 ? undefined : encodeRecord(p.record) };
  },
  answer: (bytes: Uint8Array): AnswerView | undefined => {
    const p = decodePublication(bytes), { domain, backing } = p;
    if (p.kind === 2) return { domain, backing, acceptance: v3Acceptance(p.acceptance), release: undefined };
    if (p.kind !== 3) return undefined;
    const { acceptance, releaseMessage, releaseSignature } = settlementAuthorization(p.record), q = p.record.publicInputs;
    return { domain, backing, acceptance: v3Acceptance(acceptance),
      release: { segment: identifierOf(q[2]!, q[3]!), disclosure: { output: q[14]!, rho: q[9]!, releaseMessage, releaseSignature } } };
  },
  request: (bytes: Uint8Array): RequestView => {
    const record = decodeRecord(bytes);
    if (record.kind !== 7) throw new EncodingError("not a request");
    const p = record.publicInputs, anchor = p[4]!;
    return { identity: hex(statementHash(record)), tag: p[5]!, reads: state => state.hasAnchor(anchor),
      holds: async verifier => await verifier.verify(7, [...p], new Uint8Array(record.proof)) === true };
  },
  fault: v3FaultTarget,
});

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
  settledDemand: (bytes: Uint8Array) => recoveryEffect(decodeRecord(bytes)).ended!,
  // A capsule output, or a settlement's (C4.7), whose owner the record's acceptance names.
  scanOutput: (record: Record, view: StatementView, cm: bigint, i: number): ScanOutput =>
    (record.kind === 6 ? { cm, settlement: record } : { cm, capsule: view.capsules[i] }),
  reader: V3_READER,
  journal: Object.freeze({
    encode: encodeRecord,
    identity: (record: Record) => statementHash(record),
    configuration: adoptedConfigurationBytes,
    receipt: ({ digests, scopeRoot, ...rest }: ReceiptFieldsOf, operator: Uint8Array, sign: (message: Uint8Array) => Uint8Array): Uint8Array => {
      if (scopeRoot === undefined) throw new TypeError("a pool-v3 receipt names its scope root");
      const fields = { ...rest, scopeRoot, statementHash: digests.statementHash, proofHash: digests.proofHash, signatureHash: digests.signatureHash };
      return encodeReceipt({ ...fields, operator, signature: sign(receiptBytes(fields)) });
    },
    receipts: Object.freeze({
      decode: decodeReceipt,
      encode: (receipt: OperatorReceipt) => encodeReceipt(receipt as Receipt),
      verify: ({ scopeRoot, ...authority }: Parameters<ReceiptCodec["verify"]>[0], receipt: OperatorReceipt) =>
        scopeRoot !== undefined && verifyReceipt({ ...authority, scopeRoot }, receipt as Receipt),
    }),
  }),
});

