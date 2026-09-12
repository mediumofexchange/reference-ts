// Fixture issuance only; never imported by configured holder commands.
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveWalletField } from '@mediumofexchange/reference/pool/wallet';
import { commitmentOf } from '@mediumofexchange/reference/pool/notes';
import { limbsOf } from '@mediumofexchange/reference/pool/field';
import { ScopeTree } from '@mediumofexchange/reference/pool/scope';
import { ISSUE, statementBytes } from '@mediumofexchange/reference/pool/statement';
import { encodeStoredReceipt } from '@mediumofexchange/reference/pool/store-codec';
import { PoolWalletError } from '@mediumofexchange/reference/pool/wallet-store';
export async function issueFixture({ body, fields, id, quantity, wallet, backing, profile, ensureProofs, client }) {
  const { DOMAIN, HEADER, BACKER_SECRET } = profile;
  let proofs, result;
    const data = fields(body, ['id', 'value']), requestId = id(data.id), value = quantity(data.value);
    const request = wallet.request(requestId, backing, value), opening = { backing, value, owner: request.owner,
      rho: deriveWalletField(BACKER_SECRET, DOMAIN, 'issue-rho', [request.owner]) };
    const authority = wallet.context(), head = [...limbsOf(authority.domain), ...limbsOf(authority.segment), authority.scopeRoot];
    const scope = new ScopeTree(HEADER.entries), path = scope.pathFor(backing);
    const publicInputs = [...head, ...limbsOf(backing), value, commitmentOf(DOMAIN, opening)];
    const witness = { domain: limbsOf(DOMAIN).map(String), segment: limbsOf(authority.segment).map(String), scope: String(authority.scopeRoot),
      link: limbsOf(scope.entry(backing).link).map(String), scope_siblings: path.siblings.map(String), scope_right: [...path.right],
      backing: limbsOf(backing).map(String), quantity: value.toString(), cm: String(commitmentOf(DOMAIN, opening)),
      owner: String(opening.owner), rho: String(opening.rho) };
    let pending;
    try { pending = wallet.pending(requestId); }
    catch (error) { if (!(error instanceof PoolWalletError) || error.code !== 'UNKNOWN') throw error; }
    if (pending === undefined) proofs = await ensureProofs();
    const proof = pending?.statement.proof ?? (proofs ? await proofs.prove(ISSUE, witness, publicInputs) : sha256(statementBytes(DOMAIN, ISSUE, publicInputs)));
    const statement = { kind: ISSUE, publicInputs, proof,
      obligorSignature: ed25519.sign(statementBytes(DOMAIN, ISSUE, publicInputs), BACKER_SECRET) };
    wallet.prepare(requestId, statement, opening);
    const receipt = await wallet.submit(requestId, client);
    result = { kind: 'accepted', id: requestId, receipt: encodeStoredReceipt(receipt) };

  return result;
}
