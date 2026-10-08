// Slice 13 (e) probe tooling, disposable: dist/cli/backend.js with M11c2's load verifier. A proof among the kept real
// proofs (MOE_DEPTH_PROOFS, v8-serialized { kind, inputs, proof }[], read once it exists) is verified as it is; any
// other, once that file exists, is a stand-in and verifies the next kept real proof in its place: real verification
// load and memory, not the stand-ins' verdicts. Before the file exists every proof is verified as it is.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { deserialize } from "node:v8";

const real = await import(process.env.MOE_DEPTH_BACKEND);
const file = process.env.MOE_DEPTH_PROOFS, countsFile = process.env.MOE_DEPTH_COUNTS;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
let proofs, genuine, next = 0;
const counts = { standIns: 0, genuine: 0 };
const load = () => {
  if (proofs !== undefined || file === undefined || !existsSync(file)) return;
  proofs = deserialize(readFileSync(file));
  genuine = new Set(proofs.map(p => digest(p.proof)));
};
if (countsFile !== undefined) process.on("exit", () => appendFileSync(countsFile, `${JSON.stringify({ pid: process.pid, ...counts })}\n`));

function wrap(verifier) {
  return { identities: verifier.identities, parallel: verifier.parallel, close: () => verifier.close(),
    async verify(kind, inputs, proof) {
      load();
      if (proofs === undefined || genuine.has(digest(proof))) { counts.genuine++; return verifier.verify(kind, inputs, proof); }
      const p = proofs[next++ % proofs.length]; counts.standIns++;
      if (!(await verifier.verify(p.kind, p.inputs, p.proof))) throw new Error("a kept real proof failed");
      return true;
    } };
}

export const verifierCount = args => real.verifierCount(args);
export async function openVerifier(directory, instances) { return wrap(await real.openVerifier(directory, instances)); }
export async function directoryVerifier(directory, args) {
  const verifier = await real.directoryVerifier(directory, args);
  return verifier === undefined ? undefined : wrap(verifier);
}
