// The client side of pool-v3-service-client.test.ts's proxy cases (Next 4 (bj)). Node installs its environment proxy
// only at startup, so the client runs in a process of its own, under vite-node (vitest's own runner), with the case's
// proxy. Arguments: the service URL, the operator, the reference label and lag, and the backing (hex). Prints the
// package's selection sequence, or the failure's name, code, message and cause.
import { hexToBytes } from "@noble/hashes/utils.js";
import { LOCAL_REFERENCE } from "../src/record-venue.js";
import { V3ServiceClient, V3ServiceClientError } from "../src/pool/v3/service-client.js";

const [url, operator, label, lag, backing] = process.argv.slice(2) as [string, string, string, string, string];
const started = Date.now();
try {
  const client = new V3ServiceClient(url, "11".repeat(32), { operator: hexToBytes(operator),
    reference: { context: LOCAL_REFERENCE, label: hexToBytes(label), lag: BigInt(lag) } });
  const served = await client.package(hexToBytes(backing));
  process.stdout.write(`${JSON.stringify({ sequence: String(served.selection.sequence), ms: Date.now() - started })}\n`);
} catch (error) {
  const failure = error as Error;
  process.stdout.write(`${JSON.stringify({ name: failure.name, message: failure.message, ms: Date.now() - started,
    ...(error instanceof V3ServiceClientError ? { code: error.code, status: error.status } : {}),
    ...(failure.cause instanceof Error ? { cause: failure.cause.message } : {}) })}\n`);
}
