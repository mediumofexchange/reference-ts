// Narrow §6 signature facts. Demand identity is a hash preimage, not standing.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import { isValidPublicKey, verifySignatureStrict } from "../../keys.js";
import { identifierOf } from "../field.js";
import type { FaultEvidence } from "./fault-evidence.js";
import { acceptanceBytes, acceptanceId, releaseBytes, statementHash, withdrawalBytes, type Statement } from "./records.js";
import type { RootTerms } from "./terms.js";

export interface AuthorizationFault {
  readonly check: "SIGNATURE";
  /** Pool-v3's four roles; lit-v1 §6 adds an input's owner. */
  readonly authorizationRole: "issue" | "withdrawal" | "acceptance" | "release" | "owner";
  readonly signer: string;
  readonly authorizationBacking: string;
  readonly demand?: string;
}
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** Decoded statements and authenticated scoped terms, owned by the observer. */
export function authorizationFaults(statement: Statement | undefined, evidence: FaultEvidence,
  scopedTerms: ReadonlyMap<string, RootTerms>, demands: ReadonlyMap<string, Statement>): AuthorizationFault[] {
  if (statement === undefined) return [];
  const { kind, domain, publicInputs: p } = statement, authorization = evidence.authorization;
  const facts: AuthorizationFault[] = [];
  const reject = (role: AuthorizationFault["authorizationRole"], signature: Uint8Array, message: Uint8Array,
    signer: Uint8Array, backing: Uint8Array, demand?: Uint8Array): void => {
    if (!verifySignatureStrict(signature, message, signer)) facts.push({ check: "SIGNATURE", authorizationRole: role,
      signer: hex(signer), authorizationBacking: hex(backing), ...(demand === undefined ? {} : { demand: hex(demand) }) });
  };
  if (kind === 1 && authorization.length === 64) {
    const backing = identifierOf(p[5]!, p[6]!), terms = scopedTerms.get(hex(backing));
    if (terms !== undefined) reject("issue", authorization, evidence.statement, terms.obligor, backing);
  }
  if (kind !== 5 && kind !== 6) return facts;
  if (authorization.length !== (kind === 5 ? 64 : 136)) return facts;
  const i = kind === 5 ? 5 : 15, demandId = identifierOf(p[i]!, p[i + 1]!);
  const demand = demands.get(hex(demandId));
  // The authenticated target names this exact statement preimage. Its enclosing
  // compact opening need not authenticate and supplies no demand-state claim.
  const demandBacking = demand === undefined ? undefined : identifierOf(demand.publicInputs[5]!, demand.publicInputs[6]!);
  const presenter = demand === undefined ? undefined : identifierOf(demand.publicInputs[12]!, demand.publicInputs[13]!);
  const named = demand !== undefined && demandBacking !== undefined && presenter !== undefined &&
    same(demand.domain, domain) && scopedTerms.has(hex(demandBacking)) && isValidPublicKey(presenter);
  if (kind === 5) {
    if (named) reject("withdrawal", authorization, withdrawalBytes(statement), presenter, demandBacking, demandId);
    return facts;
  }
  const backing = identifierOf(p[5]!, p[6]!), terms = scopedTerms.get(hex(backing));
  // Zero owner has no canonical §6 acceptance message. This reporter does not
  // turn malformed message structure into a signature-verification verdict.
  if (terms === undefined || p[8] === 0n) return facts;
  const deadline = new DataView(authorization.buffer, authorization.byteOffset, authorization.byteLength).getBigUint64(0, false);
  const acceptance = { domain, demand: demandId, owner: p[8]!, deadline };
  reject("acceptance", authorization.subarray(8, 72), acceptanceBytes(acceptance), terms.obligor, backing, demandId);
  if (named && same(demandBacking, backing)) {
    const release = releaseBytes(domain, demandId, acceptanceId(acceptance), statementHash(statement));
    reject("release", authorization.subarray(72), release, presenter, backing, demandId);
  }
  return facts;
}
