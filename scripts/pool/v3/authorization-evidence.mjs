// Narrow §6 signature facts. Demand identity is a hash preimage, not standing.
import { compareBytes } from "../../../dist/bytes.js";
import { identifierOf } from "../../../dist/pool/field.js";
import { isValidPublicKey, verifySignatureStrict } from "../../../dist/keys.js";

const same = (a, b) => compareBytes(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");

export function authorizationFaults(statement, evidence, scopedTerms, demands, codec) {
  if (statement === undefined) return [];
  const { kind, domain, publicInputs: p } = statement, authorization = evidence.authorization;
  const facts = [];
  const reject = (role, signature, message, signer, backing, demand) => {
    if (!verifySignatureStrict(signature, message, signer)) facts.push({ check: "SIGNATURE", authorizationRole: role,
      signer: hex(signer), authorizationBacking: hex(backing), ...(demand === undefined ? {} : { demand: hex(demand) }) });
  };
  if (kind === 1 && authorization.length === 64) {
    const backing = identifierOf(p[5], p[6]), terms = scopedTerms.get(hex(backing));
    if (terms !== undefined) reject("issue", authorization, evidence.statement, terms.obligor, backing);
  }
  if (kind !== 5 && kind !== 6) return facts;
  if (authorization.length !== (kind === 5 ? 64 : 136)) return facts;
  const i = kind === 5 ? 5 : 15, demandId = identifierOf(p[i], p[i + 1]);
  const demand = demands.get(hex(demandId));
  // The authenticated target names this exact statement preimage. Its enclosing
  // compact opening need not authenticate and supplies no demand-state claim.
  const demandBacking = demand === undefined ? undefined : identifierOf(demand.publicInputs[5], demand.publicInputs[6]);
  const presenter = demand === undefined ? undefined : identifierOf(demand.publicInputs[12], demand.publicInputs[13]);
  const named = demand !== undefined && same(demand.domain, domain) && scopedTerms.has(hex(demandBacking)) && isValidPublicKey(presenter);
  if (kind === 5) {
    if (named) reject("withdrawal", authorization, codec.withdrawalBytes(statement), presenter, demandBacking, demandId);
    return facts;
  }
  const backing = identifierOf(p[5], p[6]), terms = scopedTerms.get(hex(backing));
  // Zero owner has no canonical §6 acceptance message. This reporter does not
  // turn malformed message structure into a signature-verification verdict.
  if (terms === undefined || p[8] === 0n) return facts;
  const deadline = new DataView(authorization.buffer, authorization.byteOffset, authorization.byteLength).getBigUint64(0, false);
  const acceptance = { domain, demand: demandId, owner: p[8], deadline };
  reject("acceptance", authorization.subarray(8, 72), codec.acceptanceBytes(acceptance), terms.obligor, backing, demandId);
  if (named && same(demandBacking, backing)) {
    const release = codec.releaseBytes(domain, demandId, codec.acceptanceId(acceptance), codec.statementHash(statement));
    reject("release", authorization.subarray(72), release, presenter, backing, demandId);
  }
  return facts;
}
