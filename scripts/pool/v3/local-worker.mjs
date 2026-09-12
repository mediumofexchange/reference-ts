// Fresh local fixture process. Artifact paths/pins are harness-owned inputs,
// never read from the supplied record package. No witness or original journal.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deserialize } from "node:v8";
import { Barretenberg, BackendType, UltraHonkVerifierBackend } from "@aztec/bb.js";
import { loadEvidenceCodecs } from "../delivery/evidence-reader.mjs";
import { replayLocalPackage } from "./local-replay.mjs";
import { field } from "../fixtures.mjs";

let api;
try {
  const codec = await loadEvidenceCodecs(process.argv[2]);
  const manifest = JSON.parse(readFileSync(new URL("pins.json", process.argv[2]), "utf8"));
  const keys = new Map();
  for (const [kind, pin] of Object.entries(manifest.keys)) {
    const key = readFileSync(new URL(`${kind}.vk`, process.argv[2]));
    if (createHash("sha256").update(key).digest("hex") !== pin) throw new Error("fixture key identity");
    keys.set(Number(kind), new Uint8Array(key));
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_097_152) throw new Error("fixture IPC limit");
    chunks.push(chunk);
  }
  const input = deserialize(Buffer.concat(chunks));
  const fields = Object.keys(input).sort().join(",");
  if (fields !== "issuerKey,package,selection" && fields !== "issuerKey,package,seed,selection") throw new Error("unexpected fixture input");
  api = await Barretenberg.new({ backend: BackendType.WasmWorker, threads: 1 });
  const backend = new UltraHonkVerifierBackend(api);
  const verifier = { verify: (kind, publicInputs, proof) => backend.verifyProof({
    proof, publicInputs: publicInputs.map(field), verificationKey: keys.get(kind),
  }, { verifierTarget: "noir-recursive" }) };
  process.stdout.write(JSON.stringify(await replayLocalPackage(input, verifier, codec)));
} catch {
  process.stderr.write("local replay fixture failed\n");
  process.exitCode = 1;
} finally {
  if (api) await api.destroy();
}
