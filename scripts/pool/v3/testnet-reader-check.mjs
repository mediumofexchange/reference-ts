// Read-only live acceptance of the retained public testnet bundle. No publisher
// is constructed. Rebuild public bytecode so bundles from the first live run
// can be completed without repeating any transaction or changing its report.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { deserialize } from "node:v8";
import { RELATION_KINDS, loadManifest, checkSources, readKeys } from "./manifest.mjs";
import { publicArtifactFiles } from "./public-artifacts.mjs";
import { sourceClosure, sourceHashes } from "./provenance.mjs";

assert.equal(process.argv.length, 2, "testnet-reader-check takes no arguments");
const root = resolve(import.meta.dirname, "../../.."), scratch = join(root, "scratch");
mkdirSync(scratch, { recursive: true });
const build = mkdtempSync(join(scratch, "pool-v3-reader-"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const livePath = "docs/pool-v3-testnet-verification.json", liveBytes = readFileSync(join(root, livePath));
const live = JSON.parse(liveBytes), bundle = join(scratch, "pool-v3-testnet-reader");
const sources = sourceClosure(["scripts/pool/v3/testnet-reader-check.mjs", "scripts/pool/v3/store-check.mjs",
  "scripts/pool/v3/local-worker.mjs", "scripts/pool/v3/compile.mjs",
  ...["issue", "spend", "burn", "demand", "settle", "request", "notes"].map(name => `scripts/pool/v3/circuits/${name}.nr`),
  "src/pool/circuits/vendor/poseidon2.nr", "package-lock.json"]);
const sourceSha256Lf = sourceHashes(sources);
try {
  assert.equal(live.schema, "moe-v3-testnet-journal-1");
  assert.equal(live.publicBundle.directory, "scratch/pool-v3-testnet-reader");
  for (const [name, digest] of Object.entries(live.publicBundle.sha256)) {
    assert(!name.includes("/") && !name.includes("\\"), "bundle file name");
    assert.equal(sha(readFileSync(join(bundle, name))), digest, `original live bundle: ${name}`);
  }
  const manifest = loadManifest(); checkSources(manifest);
  execFileSync(process.execPath, [join(import.meta.dirname, "compile.mjs"), build],
    { cwd: root, stdio: "inherit", windowsHide: true, timeout: 300_000 });
  for (const [kind] of RELATION_KINDS) writeFileSync(join(build, `${kind}.vk`), readFileSync(join(bundle, `${kind}.vk`)));
  for (const [name, bytes] of publicArtifactFiles(build, manifest)) {
    if (live.publicBundle.sha256[name] !== undefined) assert.equal(sha(bytes), live.publicBundle.sha256[name]);
    writeFileSync(join(bundle, name), bytes);
  }
  readKeys(bundle, manifest);
  const artifactPath = join(build, "issue.json"), original = readFileSync(artifactPath);
  try {
    writeFileSync(artifactPath, JSON.stringify({ bytecode: Buffer.from("altered public bytecode").toString("base64") }));
    assert.throws(() => readKeys(build, manifest), /manifest identity mismatch: issue bytecode/);
  } finally { writeFileSync(artifactPath, original); }
  const expected = ["input.bin", "testnet-reader.json", "ergo-pin.bin", "replay.mjs",
    ...RELATION_KINDS.flatMap(([kind, name]) => [`${kind}.vk`, `${name}.json`])].sort();
  assert.deepEqual(readdirSync(bundle).sort(), expected, "only public reader inputs are retained");
  const input = deserialize(readFileSync(join(bundle, "input.bin")));
  assert.deepEqual(Object.keys(input).sort(), ["package", "selection"]);
  const child = spawnSync(process.execPath, [join(bundle, "replay.mjs")],
    { cwd: root, windowsHide: true, timeout: 310_000, maxBuffer: 1_048_576, encoding: "utf8" });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const replay = JSON.parse(child.stdout);
  assert.deepEqual(replay, live.fresh.audit, "the retained bundle yields the original live public audit");
  assert.equal(replay.status, "selected-local-replay"); assert.equal(replay.audit.outstanding, "5");
  assert.deepEqual(sourceHashes(sources), sourceSha256Lf, "reader-check sources changed during acceptance");
  const files = expected.map(name => [name, readFileSync(join(bundle, name))]);
  const totalBytes = files.reduce((sum, [, bytes]) => sum + bytes.length, 0);
  assert(totalBytes <= 4_194_304);
  const report = { status: "passed", node: process.version, sourceSha256Lf,
    liveObservation: { report: livePath, sha256: sha(liveBytes),
      originalFilesUnchanged: Object.keys(live.publicBundle.sha256).length },
    bundle: { directory: live.publicBundle.directory, totalBytes, sha256: Object.fromEntries(files.map(([name, bytes]) => [name, sha(bytes)])) },
    checks: ["original live input hashes unchanged", "all six bytecode and key identities match the runtime manifest",
      "altered bytecode refused by its specific identity check", "public-only bundle file and input fields",
      "standalone fresh seedless replay exactly matches the original live audit"], replay,
    limits: ["Read-only replay of retained live records; no new transactions or re-execution of the publication flow.",
      "The original live journal report retains its original harness hashes. This report binds the corrected public exporter and current reader."] };
  writeFileSync(join(root, "docs/pool-v3-testnet-reader-verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("PASS: corrected public export, six artifact/key identities, altered-bytecode refusal and standalone seedless supply 5.");
} finally {
  assert(realpathSync(build).startsWith(realpathSync(scratch) + sep), "temporary compiler path escaped scratch");
  rmSync(build, { recursive: true, force: true });
}
