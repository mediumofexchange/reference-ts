// Harness compatibility: scope authentication lives in the runtime.
import * as scope from "../../../dist/pool/v3/scope-evidence.js";
import { decodeRootTerms } from "../../../dist/pool/v3/terms.js";
export const resolveTerms = (_codec, ...args) => scope.resolveTerms(...args);
export const rootTermsOf = (_codec, signed) => decodeRootTerms(signed.terms);
export const authenticatedScope = (trails, segment, _codec) => scope.authenticatedScope(trails, segment);
export const checkpointScope = (trails, backing, digest, snapshot, _codec) => scope.checkpointScope(trails, backing, digest, snapshot);
