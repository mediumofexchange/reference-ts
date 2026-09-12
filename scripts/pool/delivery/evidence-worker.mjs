// Bounded local fixture IPC, not a protocol wire or user wallet interface.
import { deserialize } from "node:v8";
import { inspectRestorationEvidence, loadEvidenceCodecs } from "./evidence-reader.mjs";

try {
  const codec = await loadEvidenceCodecs(process.argv[2]);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_097_152) throw new Error("fixture IPC limit");
    chunks.push(chunk);
  }
  const input = deserialize(Buffer.concat(chunks));
  if (Object.keys(input).sort().join(",") !== "package,seed,selection") throw new Error("unexpected fixture inputs");
  process.stdout.write(JSON.stringify(inspectRestorationEvidence(input.seed, input.selection, input.package, codec)));
} catch {
  // No exception message or fixture contents: both could contain wallet data.
  process.stderr.write("restoration fixture failed\n");
  process.exitCode = 1;
}
