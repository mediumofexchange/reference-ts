import { randomBytes } from "node:crypto";

import {
  SYNTHETIC_VIEW,
  prepareExactOutput,
  restoreSyntheticView,
} from "./crypto.mjs";
import { bytesToField, fieldToHex } from "../../../dist/pool/field.js";

function fromHex(text, length, what) {
  if (typeof text !== "string" || !new RegExp(`^[0-9a-f]{${length * 2}}$`).test(text)) {
    throw new Error(`${what} must be ${length} canonical lowercase hex bytes`);
  }
  return new Uint8Array(Buffer.from(text, "hex"));
}

function field(text, what) {
  try {
    return bytesToField(fromHex(text, 32, what));
  } catch {
    throw new Error(`${what} must be a canonical field encoding`);
  }
}

function decodePayload(payload) {
  if (payload.viewKind !== SYNTHETIC_VIEW) throw new Error("wrong view marker");
  return {
    viewKind: payload.viewKind,
    seed: fromHex(payload.seed, 32, "seed"),
    domain: fromHex(payload.domain, 32, "domain"),
    statements: payload.statements.map((statement) => ({
      deliveryHash: fromHex(statement.deliveryHash, 32, "delivery hash"),
      outputs: statement.outputs.map((output) => ({
        cm: field(output.cm, "output commitment"),
        capsule: fromHex(output.capsule, 89, "capsule"),
      })),
    })),
    spentNullifiers: payload.spentNullifiers.map((nf) => field(nf, "spent nullifier")),
    settlements: payload.settlements.map((settlement) => ({
      createdBy: settlement.createdBy,
      demandStatementHash: fromHex(settlement.demandStatementHash, 32, "demand statement hash"),
      acceptanceDeadline: BigInt(settlement.acceptanceDeadline),
      backing: fromHex(settlement.backing, 32, "settlement backing"),
      value: BigInt(settlement.value),
      owner: field(settlement.owner, "settlement owner"),
      rho: field(settlement.rho, "settlement rho"),
      cm: field(settlement.cm, "settlement commitment"),
    })),
  };
}

function encodeHolding(holding) {
  return {
    source: holding.source,
    cm: fieldToHex(holding.cm),
    nf: fieldToHex(holding.nf),
    backing: Buffer.from(holding.opening.backing).toString("hex"),
    value: holding.opening.value.toString(),
  };
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

try {
  const decoded = decodePayload(JSON.parse(input));
  const result = restoreSyntheticView(decoded);
  const nextRequestId = new Uint8Array(randomBytes(32));
  const nextBacking = result.holdings[0]?.opening.backing ?? new Uint8Array(32);
  const next = prepareExactOutput(decoded.seed, decoded.domain, nextRequestId, nextBacking, 1n);
  process.stdout.write(JSON.stringify({
    ok: true,
    holdings: result.holdings.map(encodeHolding),
    pendingAdoption: result.pendingAdoption.map((note) => ({
      ...encodeHolding(note),
      spendable: note.spendable,
      status: note.status,
    })),
    stats: result.stats,
    evidenceScope: result.evidenceScope,
    authenticatedFullV3Finality: result.authenticatedFullV3Finality,
    completenessClaim: result.completenessClaim,
    noMatchesMeansZeroBalance: result.noMatchesMeansZeroBalance,
    unresolvedCoverage: result.unresolvedCoverage,
    requestGeneration: {
      strategy: "fresh-cryptographic-random-32-bytes",
      requestId: Buffer.from(nextRequestId).toString("hex"),
      cm: fieldToHex(next.cm),
      indexScans: 0,
      randomDraws: 1,
    },
  }));
} catch (error) {
  process.stderr.write(JSON.stringify({
    ok: false,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
}
