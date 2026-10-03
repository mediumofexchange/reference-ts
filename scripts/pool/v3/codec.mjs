// The runtime's v3 codecs and the §13 range codec, as the one codec object the
// replay harness passes around.
import * as trailCodec from "../../../dist/pool/v3/trail.js";
import * as recordCodec from "../../../dist/pool/v3/records.js";
import * as headerCodec from "../../../dist/pool/v3/headers.js";
import * as commitmentCodec from "../../../dist/pool/v3/commitments.js";
import * as faultEvidence from "../../../dist/pool/v3/fault-evidence.js";
import * as evidencePackage from "../../../dist/pool/v3/package.js";
import * as recordRange from "../../../dist/record-range.js";
import { configurationCodecs } from "./manifest.mjs";

/** The fixtures' budget for one trail they encode or decode in memory; the runtime reader streams trails with per-object bounds only. */
export const LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxEvents: 1024n });

export const v3Codec = Object.freeze({ ...trailCodec, ...recordCodec, ...headerCodec, ...commitmentCodec,
  ...configurationCodecs, ...faultEvidence, ...evidencePackage, ...recordRange });
