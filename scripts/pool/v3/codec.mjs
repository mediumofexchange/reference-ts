// The runtime's v3 codecs, the §13 range codec and, for the Ergo adapter, the
// Ergo profile, as the one codec object the replay harness passes around.
import * as faultEvidence from "../../../dist/pool/v3/fault-evidence.js";
import * as evidencePackage from "../../../dist/pool/v3/package.js";
import * as recordRange from "../../../dist/record-range.js";
import * as ergoProfile from "../../../dist/ergo-profile.js";
import { evidenceCodecs } from "../delivery/evidence-reader.mjs";
import { configurationCodecs } from "./candidate.mjs";

export const v3Codec = Object.freeze({ ...evidenceCodecs, ...configurationCodecs, ...faultEvidence, ...evidencePackage, ...recordRange });
export const v3ErgoCodec = Object.freeze({ ...v3Codec, ...ergoProfile });
