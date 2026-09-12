// Conditional initial-segment experiment, not an adopted v3 runtime.
// pool-v3 §§3,5,7,10; pool-v2 §8 host checks; pool-spent C1.2.8–9.
import { compareBytes, EncodingError } from "../../../dist/bytes.js";
import { verifySignatureStrict } from "../../../dist/keys.js";
import { fieldToBytes, identifierOf, VALUE_BOUND } from "../../../dist/pool/field.js";
import { NoteTree, EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { createCapsuleScanner, CapsuleAssociationError, CapsuleFormatError } from "../delivery/crypto.mjs";
import { EvidenceRefusal, readLocalEvidence } from "../delivery/evidence-reader.mjs";

const same = (a, b) => compareBytes(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");
class ReplayRefusal extends Error {
  constructor(check) { super(check); this.check = check; }
}
const requireReplay = (value, check) => { if (!value) throw new ReplayRefusal(check); };

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
    if (!ArrayBuffer.isView(value)) pending.push(...Object.values(value));
  }
  return copy;
}

/** verifier.configuration is independently selected and its six keys checked
 * by the harness. Issuer identity comes from signed scoped terms (§11).
 * No approved configuration, complete opening or finality verdict.
 * Nothing is exposed until every record and terminal assertion passes. */
export async function replayLocalPackage(input, verifier, codec) {
  const flags = { fullV3Replay: false, currentRangeAuthenticated: false,
    candidateConfigurationChecked: false, signedTermsAuthenticated: false,
    termsAuthorityAuthenticated: false, completenessClaim: false, noMatchesMeansZeroBalance: false,
    unresolvedCoverage: true, spendable: false };
  const refused = (status, check = null) => ({ status, check, ...flags, audit: null, candidates: [] });
  try {
    // Own selection, seed and supplied bytes before any asynchronous verifier.
    const owned = ownInputs(input);
    if (owned === null || typeof owned !== "object") throw new EncodingError("invalid replay input");
    const { selection, package: supplied, seed } = owned;
    // Do not silently keep the retired issuer override as an alternate input.
    requireReplay(Object.keys(owned).sort().join(",") === (seed === undefined ? "package,selection" : "package,seed,selection"), "INPUT_FIELDS");
    requireReplay(codec.verifyConfiguration(supplied?.configuration, verifier.configuration), "CONFIGURATION");
    const domain = codec.configurationHash(codec.decodeConfiguration(supplied.configuration));
    requireReplay(selection?.domain instanceof Uint8Array && same(domain, selection.domain), "CONFIGURATION");
    const { snapshot, trail, header } = readLocalEvidence(selection, supplied, codec);
    const signed = trail.terms[0], terms = codec.decodeRootTerms(signed.terms);
    requireReplay(codec.verifyRootTermsSignature(signed.terms, signed.signature), "TERMS_SIGNATURE");
    requireReplay(same(codec.rootTermsName(signed.terms), header.entries[0].backing), "TERMS_NAME");
    requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
    // Local fixture is limited to original operator/genesis link. This is no
    // proof of absent replacement, revocation or previous commitments.
    requireReplay(same(terms.operator, header.operator) && same(header.entries[0].link, selection.backing), "TERMS_INITIAL_SCOPE");
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
    return { status: selection.mode === "historical-fixture" ? "historical-local-replay" : "selected-local-replay",
      ...flags, candidateConfigurationChecked: true, signedTermsAuthenticated: true,
      audit: { records: position.toString(), issued: issued.toString(), burned: burned.toString(),
        outstanding: (issued - burned).toString(), noteRoot: tree.root().toString(), spentRoot: hex(spent.root()),
        historyHash: hex(history), evidenceHash: hex(snapshot.evidenceHash) }, candidates };
  } catch (error) {
    if (error instanceof ReplayRefusal) return refused("invalid-local-replay", error.check);
    if (error instanceof EvidenceRefusal) return refused(error.status);
    if (error instanceof codec.TrailLimitError) return refused("resource-refusal");
    if (error instanceof EncodingError || error instanceof codec.CodecEncodingError ||
      error instanceof CapsuleFormatError || error instanceof CapsuleAssociationError) return refused("unresolved-evidence");
    throw error;
  }
}
