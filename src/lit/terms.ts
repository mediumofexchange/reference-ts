// Root terms for lit-v1 §9: pool-v3 §11.2's MOEB frame, name hash and backing
// signature, construction `moe/lit/v1`, and the silence clause as tag 6 with
// the duration alone (tag 1 refused). Terms decode under at most one
// construction, since tag 5 names it. No registration, currentness or adoption.
import { termsCodec, type RootTerms } from "../pool/v3/terms.js";
import { CONSTRUCTION } from "./configuration.js";

export interface LitRootTerms extends Omit<RootTerms, "silence"> {
  readonly silence?: { readonly noCommitmentDuration: bigint };
}
export const LIT_TERMS = termsCodec<LitRootTerms>({ construction: CONSTRUCTION, silenceTag: 6 });
const LIT = LIT_TERMS;
/** §9's bound: 1296 bytes. */
export const MAX_LIT_TERMS_BYTES = LIT.maxBytes;
export const encodeLitTerms = LIT.encodeRootTerms, decodeLitTerms = LIT.decodeRootTerms, litTermsName = LIT.rootTermsName,
  litTermsSignatureMessage = LIT.rootTermsSignatureMessage, verifyLitTermsSignature = LIT.verifyRootTermsSignature;
