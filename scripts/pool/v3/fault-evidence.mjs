// §9 facts, with §9.1 intrinsic failures available only to dependency-resolved reads.
import { createHash } from "node:crypto";
import { compareBytes, EncodingError } from "../../../dist/bytes.js";
import { EvidenceRefusal } from "../delivery/evidence-reader.mjs";
import { authorizationFaults } from "./authorization-evidence.mjs";

const same = (a, b) => compareBytes(a, b) === 0;
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = bytes => Buffer.from(bytes).toString("hex");
const heldKey = held => `${hex(held.commitment.operator)}:${held.commitment.sequence}:${hex(held.commitment.root)}:${held.index}`;
export const FAULT_LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxItems: 32n, maxSuffixEntries: 1024n });

// Called before replay's ownership copy. Inspect intrinsic byte widths rather
// than shadowable properties of typed-array subclasses.
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const lengthOf = Object.getOwnPropertyDescriptor(typed, "byteLength").get;
const bufferOf = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const offsetOf = Object.getOwnPropertyDescriptor(typed, "byteOffset").get;
const allocationOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
export function boundFaultInputs(faults = []) {
  if (!Array.isArray(faults)) throw new EncodingError("invalid compact evidence inventory");
  const count = faults.length;
  if (!Number.isSafeInteger(count) || count < 0 || BigInt(count) > FAULT_LIMITS.maxItems) throw new EvidenceRefusal("resource-refusal");
  let bytes = 0n;
  const views = [];
  // Indexed reads avoid a caller-supplied iterator, and capture each entry once.
  for (let i = 0; i < count; i++) {
    const payload = faults[i];
    if (!(payload instanceof Uint8Array) || bufferOf.call(payload) instanceof SharedArrayBuffer) {
      throw new EncodingError("invalid compact evidence bytes");
    }
    // Cloning a subview also copies its backing allocation.
    bytes += BigInt(allocationOf.call(bufferOf.call(payload)));
    if (bytes > FAULT_LIMITS.maxBytes || BigInt(lengthOf.call(payload)) > FAULT_LIMITS.maxBytes) {
      throw new EvidenceRefusal("resource-refusal");
    }
    views.push(new Uint8Array(bufferOf.call(payload), offsetOf.call(payload), lengthOf.call(payload)));
  }
  return views.map(view => new Uint8Array(view));
}

export function faultObserver(payloads = [], selection, verifier, codec) {
  const evidence = [], checked = new Map(), facts = new Map(), demands = new Map(), intrinsic = new Map();
  for (const payload of payloads) {
    try {
      const value = codec.decodeFaultEvidence(payload, FAULT_LIMITS.maxSuffixEntries);
      let statement;
      try { statement = codec.decodeStatement(value.statement); }
      catch (error) { if (!(error instanceof codec.CodecEncodingError)) throw error; }
      evidence.push({ id: hex(hash(payload)), value, statement });
      if (statement?.kind === 4 && same(statement.domain, selection.domain)) demands.set(hex(hash(value.statement)), statement);
    } catch (error) {
      if (error instanceof codec.FaultEvidenceLimitError) throw new EvidenceRefusal("resource-refusal");
      if (!(error instanceof codec.CodecEncodingError)) throw error;
    }
  }
  return {
    result() { return facts.size === 0 ? {} : { faultEvidence: [...facts.values()] }; },
    // This supplies only the intrinsic failure. Callers must first resolve the
    // valid opening, last-valid state, original record prefix and adoption context.
    // The initial implementation supports single-backing non-silence continuations.
    intrinsicFailure(held, scope) {
      if (scope.header.entries.length !== 1 || held.commitment.sequence <= scope.header.sequence ||
          codec.decodeRootTerms(scope.terms[0].terms).silence !== undefined) return undefined;
      return intrinsic.get(`${heldKey(held)}:${hex(hash(codec.segmentBytes(scope.header)))}`);
    },
    async inspect(held, directory, scope) {
      if (evidence.length === 0) return;
      const { header, terms } = scope, c = held.commitment;
      if (!same(header.domain, selection.domain) || !same(header.venue, selection.venue) ||
          !same(header.operator, c.operator) || header.sequence > c.sequence) return;
      // checkpointScope already authenticated the header and every signed term.
      const scopedTerms = new Map();
      for (let i = 0; i < terms.length; i++) {
        const signed = terms[i];
        const term = codec.decodeRootTerms(signed.terms);
        if (!same(term.configuration, selection.domain) || !same(term.venue, selection.venue)) return;
        scopedTerms.set(hex(header.entries[i].backing), term);
      }
      for (const { id, value: e, statement } of evidence) {
        const entry = directory.find(item => same(item.name, e.snapshot.backing));
        if (entry === undefined || !header.entries.some(item => same(item.backing, entry.name)) ||
            !same(hash(codec.segmentBytes(header)), e.snapshot.segment) ||
            !codec.verifyFaultEvidence({ backing: entry.name, segment: e.snapshot.segment, digest: entry.digest }, e, FAULT_LIMITS.maxSuffixEntries)) continue;
        if (!checked.has(id)) {
          let rejected = false;
          if (statement !== undefined && [1, 2, 3, 4, 6].includes(statement.kind) &&
              same(statement.domain, selection.domain) && e.proof.length > 0 && e.proof.length % 32 === 0) {
            try { rejected = await verifier.verify(statement.kind, [...statement.publicInputs], new Uint8Array(e.proof)) === false; }
            catch (cause) {
              // Never let a verifier's error class enter classification catches.
              throw new Error("compact proof verifier failed", { cause });
            }
          }
          checked.set(id, rejected);
        }
        const observations = checked.get(id) ? [{ check: "PROOF" }] : [];
        // Scope-derived signer dependencies are resolved for each mapping;
        // an absent signer is never cached as validity or rejection.
        if (statement !== undefined && same(statement.domain, selection.domain)) {
          observations.push(...authorizationFaults(statement, e, scopedTerms, demands, codec));
        }
        for (const observation of observations) {
          if (observation.check === "PROOF" || observation.authorizationRole === "issue") {
            // The §9 codec already bounds the proof field at §5's maximum;
            // strict-false proof verification above also requires its length shape.
            // Prefer PROOF if both independent intrinsic failures are available.
            const key = `${heldKey(held)}:${hex(e.snapshot.segment)}`, prior = intrinsic.get(key);
            if (prior === undefined || observation.check === "PROOF") intrinsic.set(key, observation.check);
          }
        }
        const key = `${hex(c.operator)}:${c.sequence}:${hex(c.root)}:${id}`;
        for (const observation of observations) facts.set(`${key}:${observation.check}:${observation.authorizationRole ?? ""}`, {
          operator: hex(c.operator), sequence: c.sequence.toString(), root: hex(c.root), index: held.index.toString(),
          backing: hex(entry.name), segment: hex(e.snapshot.segment), position: e.position.toString(), length: e.length.toString(),
          evidence: id, configuration: hex(selection.domain), ...observation, classification: "not-established",
          ...Object.fromEntries(Object.entries(codec.hashEvidenceFields(hash(e.statement), e.proof, e.authorization)).map(([k, v]) => [k, hex(v)])) });
      }
    },
  };
}
