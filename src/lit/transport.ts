// Lit-v1 §6's transport frames: the segment header (pool-v3 §8), the served
// trail (§10) and the evidence package (§12), each the pool's frame under a lit
// context and lit's bounds. Commitments, directories and record ranges are
// shared unchanged. Structure only: no replay, classification or finality.
import { LIT_PACKAGE_CONTEXT, LIT_SEGMENT_CONTEXT, LIT_TRAIL_CONTEXT } from "../contexts.js";
import { segmentHeaderCodec } from "../pool/v3/headers.js";
import { packageCodec } from "../pool/v3/package.js";
import { trailCodec } from "../pool/v3/trail.js";
import { MAX_TARGET_FIELD_BYTES } from "./fault-evidence.js";
import { MAX_LIT_TERMS_BYTES } from "./terms.js";

const header = segmentHeaderCodec(LIT_SEGMENT_CONTEXT);
/** 262 to 8,913,022 bytes: a 126-byte prefix and 136 bytes per scoped backing. */
export const MIN_LIT_HEADER_BYTES = header.minHeaderBytes, MAX_LIT_HEADER_BYTES = header.maxHeaderBytes;
export const litSegmentBytes = header.segmentBytes, litSegmentIdentity = header.segmentIdentity,
  decodeLitSegmentHeader = header.decodeSegmentHeader;

/** A trail record's bound: two fields at the 4096-byte transport bound with their lengths. */
export const MAX_LIT_TRAIL_RECORD_BYTES = 2 * (4 + MAX_TARGET_FIELD_BYTES);
const trail = trailCodec({ context: LIT_TRAIL_CONTEXT, headerContext: LIT_SEGMENT_CONTEXT,
  maxRecordBytes: MAX_LIT_TRAIL_RECORD_BYTES, maxTermsBytes: MAX_LIT_TERMS_BYTES });
export const litTrailReader = trail.trailReader, litTrailHead = trail.trailHead, encodeLitTrail = trail.encodeTrail,
  decodeLitTrail = trail.decodeTrail;

const evidence = packageCodec(LIT_PACKAGE_CONTEXT);
export const litPackageReader = evidence.packageReader, encodeLitPackage = evidence.encodeEvidencePackage,
  decodeLitPackage = evidence.decodeEvidencePackage;
