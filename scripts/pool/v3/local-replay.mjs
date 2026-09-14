// Conditional initial-segment experiment, not an adopted v3 runtime.
// pool-v3 §§3,5,7,10,12,13; pool-v2 §8 host checks; pool-spent C1.2.8–9.
import { compareBytes, copyBytes, EncodingError } from "../../../dist/bytes.js";
import { decodeCommitment, directoryRoot } from "../../../dist/commitment.js";
import { verifySignatureStrict } from "../../../dist/keys.js";
import { fieldToBytes, identifierOf, isValue, VALUE_BOUND } from "../../../dist/pool/field.js";
import { NoteTree, EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { createCapsuleScanner, CapsuleAssociationError, CapsuleFormatError } from "../delivery/crypto.mjs";
import { EvidenceRefusal, readLocalEvidence } from "../delivery/evidence-reader.mjs";

const same = (a, b) => compareBytes(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");
export const PACKAGE_LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxItems: 1024n });
export const RANGE_LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxEntries: 4096n });
const flags = Object.freeze({ fullV3Replay: false, currentRangeAuthenticated: false,
  candidateConfigurationChecked: false, signedTermsAuthenticated: false,
  termsAuthorityAuthenticated: false, completenessClaim: false, noMatchesMeansZeroBalance: false,
  unresolvedCoverage: true, spendable: false, rangeEvidence: "none" });
const refused = (status, check = null) => ({ status, check, ...flags, audit: null, candidates: [] });
class ReplayRefusal extends Error {
  constructor(check) { super(check); this.check = check; }
}
const requireReplay = (value, check) => { if (!value) throw new ReplayRefusal(check); };
const INPUT_SHAPES = ["package,selection", "package,seed,selection", "package,selection,venue", "package,seed,selection,venue"];

function ownInputs(input) {
  const copy = structuredClone(input), pending = [copy], seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    // structuredClone copies ordinary buffers but aliases shared storage.
    // Refuse it before inspecting contents or invoking an asynchronous verifier.
    if (value instanceof SharedArrayBuffer || (ArrayBuffer.isView(value) && value.buffer instanceof SharedArrayBuffer)) {
      throw new EncodingError("shared replay input");
    }
    // Containers Object.values cannot enumerate would hide shared storage from this scan.
    if (value instanceof Map || value instanceof Set) throw new EncodingError("unsupported replay input container");
    if (!ArrayBuffer.isView(value)) pending.push(...Object.values(value));
  }
  return copy;
}

/** §13 reads against the reader's independently selected verifier: the held
 * commitments of the original operator through t (C2.3.3), every other held
 * commitment's directory (C2.4.2) for the empty opening and currency (C2.7.3,
 * C2.7.5), the replacement chain (C2.5) and K's revocation (C2b.1). The
 * verifier's clock fixes the present; a supplied answer is never evidence.
 * A later carrying checkpoint needs its own classification: unsupported here. */
async function readRecordRanges(selection, terms, directories, record, codec) {
  const t = selection.judgingIndex, now = await record.witnessedIndex();
  if (typeof now !== "bigint" || t > now || (selection.mode === "current-fixture" && t !== now)) {
    throw new EvidenceRefusal("unresolved-evidence");
  }
  const ask = async (kind, subject) => {
    const request = Object.freeze({ venue: copyBytes(selection.venue), kind, subject: copyBytes(subject), fromIndex: 0n, toIndex: t });
    const bytes = await record.range(request);
    if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
    if (!(bytes instanceof Uint8Array)) throw new EncodingError("range answer");
    return codec.decodeRangeAnswer(bytes, request, RANGE_LIMITS);
  };
  // The chain first: with an admitted replacement the party in force at an
  // earlier index is not established here, so no opening verdict may follow.
  if (codec.admittedReplacements(await ask(2, selection.backing), terms.replacementRule).length > 0) {
    throw new EvidenceRefusal("unsupported-scope");
  }
  const revokedAt = codec.revocationIndex(await ask(3, terms.obligor));
  const { held } = codec.heldCommitments(await ask(1, selection.operator));
  const selected = held.findIndex(h => h.commitment.sequence === selection.sequence && same(h.commitment.root, selection.root));
  if (selected < 0) throw new EvidenceRefusal("selection-mismatch");
  for (const [i, h] of held.entries()) {
    if (i === selected) continue;
    const directory = directories.get(hex(h.commitment.root));
    if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
    if (!directory.some(entry => same(entry.name, selection.backing))) continue;
    // The record pins an earlier state the header's empty opening denies.
    if (i < selected) throw new ReplayRefusal("OPENING");
    throw new EvidenceRefusal("unsupported-scope");
  }
  return { judgingIndex: t, checkpointIndex: held[selected].index, revokedAt, heldBefore: selected, heldAfter: held.length - selected - 1 };
}

/** verifier.configuration is independently selected and its six keys checked
 * by the harness. Issuer identity comes from signed scoped terms (§11).
 * With a fixture venue and verifier.record, §13 ranges fix the checkpoint's
 * record prefix and currency against that fixture only.
 * No approved configuration, complete opening or finality verdict.
 * Nothing is exposed until every record and terminal assertion passes. */
export async function replayLocalPackage(input, verifier, codec) {
  try {
    // Own selection, seed, venue and supplied bytes before any asynchronous verifier.
    const owned = ownInputs(input);
    if (owned === null || typeof owned !== "object") throw new EncodingError("invalid replay input");
    const { selection, package: supplied, seed, venue } = owned;
    // Do not silently keep the retired issuer override as an alternate input.
    requireReplay(INPUT_SHAPES.includes(Object.keys(owned).sort().join(",")), "INPUT_FIELDS");
    requireReplay(codec.verifyConfiguration(supplied?.configuration, verifier.configuration), "CONFIGURATION");
    const domain = codec.configurationHash(codec.decodeConfiguration(supplied.configuration));
    requireReplay(selection?.domain instanceof Uint8Array && same(domain, selection.domain), "CONFIGURATION");
    const { snapshot, trail, header } = readLocalEvidence(selection, supplied, codec);
    const signed = trail.terms[0], terms = codec.decodeRootTerms(signed.terms);
    requireReplay(codec.verifyRootTermsSignature(signed.terms, signed.signature), "TERMS_SIGNATURE");
    requireReplay(same(codec.rootTermsName(signed.terms), header.entries[0].backing), "TERMS_NAME");
    requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
    // Local fixture is limited to original operator/genesis link. Without
    // ranges this is no proof of absent replacement, revocation or commitments.
    requireReplay(same(terms.operator, header.operator) && same(header.entries[0].link, selection.backing), "TERMS_INITIAL_SCOPE");
    let ranges = null;
    if (venue !== undefined) {
      if (typeof verifier.record !== "function") throw new EvidenceRefusal("unresolved-evidence");
      const others = supplied.directories === undefined ? [] : supplied.directories;
      if (!Array.isArray(others)) throw new EncodingError("invalid directories");
      const directories = new Map([supplied.directory, ...others].map(entries => [hex(directoryRoot(entries)), entries]));
      ranges = await readRecordRanges(selection, terms, directories, verifier.record(venue), codec);
    }
    const issuerKey = terms.obligor;
    const scope = new ScopeTree(header.entries).root();
    const tree = new NoteTree(), spent = new RadixSpentSet(), anchors = new Set([EMPTY_NOTE_ROOT]);
    const statements = new Set(), outputPositions = new Map();
    let issued = 0n, burned = 0n, position = 0n;
    let history = codec.genesisHistoryHash(snapshot.segment);
    const scanOutputs = [];
    for (const bytes of trail.records) {
      const record = codec.decodeRecord(bytes), p = record.publicInputs, kind = record.kind;
      if (![1, 2, 3].includes(kind)) return refused("unsupported-scope");
      requireReplay(same(record.domain, selection.domain) && same(identifierOf(p[2], p[3]), snapshot.segment), "CONTEXT");
      requireReplay(p[4] === scope, "SCOPE");
      const identity = codec.statementHash(record), id = hex(identity);
      requireReplay(!statements.has(id), "REPEATED_STATEMENT");
      // Issuance finalized at or after K's revocation is void (C2b.1).
      if (kind === 1 && ranges !== null) requireReplay(ranges.revokedAt === undefined || ranges.revokedAt > ranges.checkpointIndex, "REVOKED");
      requireReplay(await verifier.verify(kind, [...p], new Uint8Array(record.proof)) === true, "PROOF");
      if (kind !== 2) {
        requireReplay(same(identifierOf(p[5], p[6]), selection.backing), "BACKING");
        if (kind === 1) {
          requireReplay(verifySignatureStrict(record.authorization, codec.statementBytes(record), issuerKey), "SIGNATURE");
          requireReplay(issued + p[7] < VALUE_BOUND, "SUPPLY");
        } else requireReplay(p[7] <= issued - burned, "SUPPLY");
      }
      const nfs = kind === 1 ? [] : kind === 2 ? p.slice(7, 9) : p.slice(10, 12);
      const roots = kind === 1 ? [] : kind === 2 ? p.slice(5, 7) : p.slice(8, 10);
      const outputs = kind === 1 ? [p[8]] : kind === 2 ? p.slice(9, 13) : [p[12]];
      requireReplay(roots.every(root => anchors.has(root)), "ANCHOR");
      requireReplay(new Set(nfs).size === nfs.length && nfs.every(nf => nf !== 0n && !spent.has(fieldToBytes(nf))), "SPENT");
      requireReplay(new Set(outputs).size === outputs.length && outputs.every(cm => cm !== 0n && !tree.has(cm)), "OUTPUT");
      requireReplay(tree.size + BigInt(outputs.length) <= NOTE_TREE_CAPACITY && position + 1n < VALUE_BOUND, "CAPACITY");
      // All guards read the same pre-state. This local state is never returned
      // on failure, including a verifier rejection later in the supplied trail.
      const positions = tree.appendAll(outputs);
      outputs.forEach((cm, i) => {
        outputPositions.set(cm, positions[i]); scanOutputs.push({ cm, capsule: record.capsules[i] });
      });
      nfs.forEach(nf => spent.insert(fieldToBytes(nf)));
      if (kind === 1) issued += p[7];
      if (kind === 3) burned += p[7];
      position += 1n;
      anchors.add(tree.root()); statements.add(id);
      history = codec.nextHistoryHash(history, identity, tree.root(), spent.root(), position);
    }
    requireReplay(same(history, snapshot.historyHash) && issued === snapshot.issued && burned === snapshot.burned, "SNAPSHOT");
    const candidates = [];
    if (seed !== undefined) {
      const scanner = createCapsuleScanner(seed, selection.domain);
      for (const output of scanOutputs) {
        const note = scanner.tryRecover(output.cm, output.capsule);
        if (note === null) continue;
        requireReplay(same(note.opening.backing, selection.backing), "BACKING");
        if (note.opening.value > 0n && !spent.has(fieldToBytes(note.nf))) {
          const leaf = outputPositions.get(note.cm), path = tree.path(leaf);
          candidates.push({ cm: note.cm.toString(), nf: note.nf.toString(), value: note.opening.value.toString(),
            leaf: leaf.toString(), anchor: tree.root().toString(), siblings: path.siblings.map(String), right: [...path.right],
            pathScope: "replayed-local-tree-only", spendable: false });
        }
      }
    }
    const historical = selection.mode === "historical-fixture";
    return { status: historical ? "historical-local-replay" : "selected-local-replay",
      ...flags, candidateConfigurationChecked: true, signedTermsAuthenticated: true,
      ...(ranges === null ? {} : { currentRangeAuthenticated: !historical, termsAuthorityAuthenticated: true, rangeEvidence: "fixture-verifier" }),
      audit: { records: position.toString(), issued: issued.toString(), burned: burned.toString(),
        outstanding: (issued - burned).toString(), noteRoot: tree.root().toString(), spentRoot: hex(spent.root()),
        historyHash: hex(history), evidenceHash: hex(snapshot.evidenceHash),
        range: ranges === null ? null : { judgingIndex: ranges.judgingIndex.toString(), checkpointIndex: ranges.checkpointIndex.toString(),
          revokedAt: ranges.revokedAt === undefined ? null : ranges.revokedAt.toString(),
          heldBefore: ranges.heldBefore, heldAfter: ranges.heldAfter } }, candidates };
  } catch (error) {
    if (error instanceof ReplayRefusal) return refused("invalid-local-replay", error.check);
    if (error instanceof EvidenceRefusal) return refused(error.status);
    if (error instanceof codec.TrailLimitError || error instanceof codec.RangeLimitError) return refused("resource-refusal");
    if (error instanceof EncodingError || error instanceof codec.CodecEncodingError ||
      error instanceof CapsuleFormatError || error instanceof CapsuleAssociationError) return refused("unresolved-evidence");
    throw error;
  }
}

/** Portable §12 boundary for the bounded local experiment. Select exactly one
 * config/commitment/snapshot/trail and the directory preimages the §13 range
 * read needs; fault/range witnesses, imports and other kinds require a later
 * reader. No first-match lookup can silently discard conflicting or unsupported
 * evidence. The same replay engine then authenticates every relationship
 * against selection and, with a fixture venue, against the record ranges. */
export async function replayEvidencePackage(input, verifier, codec) {
  try {
    if (input === null || typeof input !== "object") throw new EncodingError("invalid package input");
    requireReplay(INPUT_SHAPES.includes(Object.keys(input).sort().join(",")), "INPUT_FIELDS");
    // Decode synchronously before ownership copying: the codec checks the byte
    // and item budgets before copying payloads. structuredClone would copy even
    // the unused backing allocation of a small subview before checking bounds.
    const items = codec.decodeEvidencePackage(input.package, PACKAGE_LIMITS);
    const source = input.selection;
    if (source === null || typeof source !== "object" ||
        Object.keys(source).sort().join(",") !== "backing,domain,judgingIndex,mode,operator,root,sequence,venue" ||
        !isValue(source.sequence) || source.sequence === 0n || !isValue(source.judgingIndex) ||
        !["current-fixture", "historical-fixture"].includes(source.mode)) throw new EncodingError("invalid selection");
    const fields = ["backing", "domain", "operator", "root", "venue"];
    const fixed = fields.map(key => source[key]);
    if (input.seed !== undefined) fixed.push(input.seed);
    if (fixed.some(value => !(value instanceof Uint8Array) || value.length !== 32 || value.buffer instanceof SharedArrayBuffer)) {
      throw new EncodingError("invalid or shared selection/seed bytes");
    }
    const selection = { mode: source.mode, sequence: source.sequence, judgingIndex: source.judgingIndex,
      ...Object.fromEntries(fields.map(key => [key, copyBytes(source[key])])) };
    const owned = { selection, ...(input.seed === undefined ? {} : { seed: copyBytes(input.seed) }),
      ...(input.venue === undefined ? {} : { venue: input.venue }) };
    const single = [1, 2, 4, 6];
    if (items.some(item => ![...single, 3].includes(item.kind)) ||
        single.some(kind => items.filter(item => item.kind === kind).length > 1)) return refused("unsupported-scope");
    if (single.some(kind => !items.some(item => item.kind === kind)) || !items.some(item => item.kind === 3)) return refused("unresolved-evidence");
    const payload = kind => items.find(item => item.kind === kind).payload;
    const directories = items.filter(item => item.kind === 3).map(item => codec.decodeEvidenceDirectory(item.payload, PACKAGE_LIMITS));
    // The packaged commitment's own directory; whether it is the selection is readLocalEvidence's check.
    const root = decodeCommitment(payload(2)).root;
    const directory = directories.find(entries => same(directoryRoot(entries), root));
    if (directory === undefined) return refused("unresolved-evidence");
    const others = directories.filter(entries => entries !== directory);
    if (others.length > 0 && input.venue === undefined) return refused("unsupported-scope");
    return await replayLocalPackage({ ...owned, package: { configuration: payload(1), commitment: payload(2),
      directory, directories: others, snapshot: payload(4), trail: payload(6) } }, verifier, codec);
  } catch (error) {
    if (error instanceof ReplayRefusal) return refused("invalid-local-replay", error.check);
    if (error instanceof codec.PackageLimitError) return refused("resource-refusal");
    if (error instanceof EncodingError || error instanceof codec.CodecEncodingError) return refused("unresolved-evidence");
    throw error;
  }
}
