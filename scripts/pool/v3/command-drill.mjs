// Slice 10 M10c1: the `moe` reader and operator commands in fresh processes on separate data directories, over the
// synthetic Ergo node through the node REST clients (M10b item 5). The operator creates the venue, opens a backing
// under terms a fixture obligor signs, and serves; a reader keeps the terms and the service file and reads the
// supply at its own view's witnessed index. Serve checkpoints on the witnessed index, a second command on a
// directory serve holds refuses BUSY, and after serve stops past the terms' silence the operator returns and adopts.
// Hostile cases: a shared directory, another role's directory, terms under another name, forged or without --synthetic,
// an interrupted venue create, a publication past the spend budget, SQLite's temporary files kept in the directory.
// Statements, the commit-on-admission rule and each command's peak RSS come in M10c2 with the wallet commands.
//
// Usage: node scripts/pool/v3/command-drill.mjs  (after npm run build and scripts/pool/prepare-crs.mjs)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { parseVenue } from "../../../dist/cli/venue.js";
import { adoptedDomain } from "../../../dist/pool/v3/configuration.js";
import { V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../../../dist/pool/v3/terms.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";
import { serveSyntheticNode } from "./synthetic-node.mjs";

const root = resolve(import.meta.dirname, "../../.."), MOE = join(root, "dist/cli/moe.js");
const hex = bytes => Buffer.from(bytes).toString("hex");
const obligorSecret = new Uint8Array(32).fill(41), obligor = ed25519.getPublicKey(obligorSecret);
const SILENCE = 16n, DEPTH = "2";
/** Root terms naming `operator` on `venue`, signed by the fixture obligor, as files. */
function signTerms(name, operator, venue) {
  const terms = encodeRootTerms({ obligor, operator: Buffer.from(operator, "hex"), configuration: adoptedDomain(), venue: Buffer.from(venue, "hex"),
    interval: 80n, payout: { thing: "drill units", quantumExponent: 0, perUnit: 1n }, silence: { noCommitmentDuration: SILENCE, challengeWindow: 5n } });
  const files = { terms: join(scratch, `${name}.bin`), signature: join(scratch, `${name}.sig`), backing: hex(rootTermsName(terms)) };
  writeFileSync(files.terms, terms); writeFileSync(files.signature, ed25519.sign(rootTermsSignatureMessage(terms), obligorSecret));
  return files;
}
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "command-drill-")));
const checks = [], processes = [];
const check = async (label, fn) => { await fn(); checks.push(label); process.stderr.write(`passed: ${label}\n`); };

const node = await serveSyntheticNode();
const call = async (path, body) => {
  const response = await fetch(`${node.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const mine = count => call("/synthetic/mine", { count });

/** One `moe` process: its exit code, stdout's JSON and stderr. While it runs, `mining` mines a block per interval. */
function moe(args, { mining } = {}) {
  return new Promise((done, failed) => {
    const began = performance.now(), child = spawn(process.execPath, [MOE, ...args], { cwd: scratch, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk));
    const timer = mining === undefined ? undefined : setInterval(() => { mine(1).catch(() => {}); }, mining);
    child.on("error", failed);
    child.on("close", status => {
      clearInterval(timer);
      const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
      processes.push({ command: args.slice(0, 2).join(" "), status, elapsedMs: Math.round(performance.now() - began) });
      let json;
      try { json = stdout.trim() === "" ? undefined : JSON.parse(stdout.trim().split("\n").at(-1)); } catch { json = undefined; }
      let refusal;
      try { refusal = status === 1 ? JSON.parse(stderr.trim().split("\n").at(-1)) : undefined; } catch { refusal = undefined; }
      done({ status, json, stdout, stderr, refusal });
    });
  });
}
const ok = async (args, options) => {
  const result = await moe(args, options);
  assert.equal(result.status, 0, `moe ${args.join(" ")}: ${result.stderr}`);
  // One JSON object on stdout and nothing else: the backend's logs never reach it.
  assert.equal(result.stdout.split("\n").filter(line => line !== "").length, 1, result.stdout);
  return result.json;
};
const refused = async (args, code) => {
  const result = await moe(args);
  assert.equal(result.status, 1, `moe ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  assert.equal(result.refusal?.code, code, result.stderr);
  return result.refusal;
};

/** `moe operator serve` in the background: resolves with its first line once listening, and a stop. */
function serve(directory) {
  const child = spawn(process.execPath, [MOE, "operator", "serve", "--dir", directory, "--interval", "2", "--poll-ms", "100"],
    { cwd: scratch, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(done => child.on("close", status => done(status)));
  const listening = new Promise((done, failed) => {
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("\n")) done(JSON.parse(stdout.split("\n")[0])); });
    exited.then(status => failed(new Error(`serve exited ${status}: ${stderr}`)));
  });
  return { listening, log: () => stderr, async stop() { child.kill("SIGTERM"); const status = await exited; assert.equal(status, 0, stderr); } };
}

/** Mine one block at a time until `until()` holds, at most `count` blocks. */
async function mineUntil(until, count = 200) {
  for (let i = 0; i < count; i++) {
    if (await until()) return;
    await mine(1); await new Promise(done => setTimeout(done, 150));
  }
  assert.fail("the condition did not hold within the blocks mined");
}

let completed = false;
try {
  const OP = join(scratch, "operator"), RD = join(scratch, "reader"), common = ["--node", node.url, "--parameters", PARAMETER_DIRECTORY];
  await mine(Number(DEPTH) + 2);

  let operatorKey, fundingTree, venue, backing, termsFile, signatureFile;
  await check("operator init, funding, synthetic venue create (rerun prints the same file)", async () => {
    const init = await ok(["operator", "init", "--dir", OP, ...common, "--budget", "50000000"]);
    assert.equal(init.status, "created");
    operatorKey = init.operator; fundingTree = init.fundingTree;
    assert.equal(statSync(OP).mode & 0o777, process.platform === "win32" ? statSync(OP).mode & 0o777 : 0o700);
    await call("/synthetic/fund", { tree: fundingTree, value: "1000000000" });
    await refused(["operator", "venue", "create", "--dir", OP, "--depth", DEPTH], "VENUE");
    const created = await ok(["operator", "venue", "create", "--dir", OP, "--synthetic", "--depth", DEPTH]);
    assert.equal(created.status, "created");
    const again = await ok(["operator", "venue", "create", "--dir", OP, "--synthetic", "--depth", DEPTH]);
    assert.deepEqual([again.status, again.venue], ["existing", created.venue]);
    venue = created.venue;
    await mine(Number(DEPTH) + 1);
    if (process.platform !== "win32") for (const file of readdirSync(OP)) assert.equal(statSync(join(OP, file)).mode & 0o077, 0, `${file} is owner-only`);
  });

  await check("operator open under terms a fixture obligor signed, published and witnessed", async () => {
    ({ backing, terms: termsFile, signature: signatureFile } = signTerms("terms", operatorKey, venue));
    const files = ["--terms", termsFile, "--signature", signatureFile];
    await refused(["operator", "open", "--dir", OP, "--id", "genesis", backing, ...files], "SYNTHETIC");
    await refused(["operator", "open", "--dir", OP, "--id", "genesis", hex(new Uint8Array(32).fill(9)), ...files, "--synthetic"], "NAME");
    const opened = await ok(["operator", "open", "--dir", OP, "--id", "genesis", backing, ...files, "--synthetic"]);
    assert.deepEqual([opened.status, opened.commitment.sequence, opened.commitment.operator], ["pending", "1", operatorKey]);
    const again = await ok(["operator", "open", "--dir", OP, "--id", "genesis", backing, ...files, "--synthetic"]);
    assert.deepEqual(again.commitment, opened.commitment, "an exact rerun prints the saved commitment");
    await mine(Number(DEPTH) + 2);
  });

  const reader = ["--dir", RD];
  /** Serve publishes on its own poll after it commits: mine past the depth and read until `until` holds, a few
   * rounds at most, so the drill does not race serve's publication on a slow runner. */
  const supplyUntil = async (until, rounds = 8) => {
    for (let round = 0; ; round++) {
      await mine(Number(DEPTH) + 2); await new Promise(done => setTimeout(done, 400));
      const read = await ok(["reader", "supply", ...reader, backing]);
      if (read.checkpoint !== undefined && until(read)) return read;
      assert(round < rounds, `the reader's supply did not reach the expected checkpoint: ${JSON.stringify(read.checkpoint)}`);
    }
  };
  await check("reader init with the operator's venue file, terms add with --synthetic, terms show", async () => {
    const init = await ok(["reader", "init", ...reader, "--venue", join(OP, "venue.json"), ...common]);
    assert.equal(init.venue, venue);
    await refused(["reader", "terms", "add", ...reader, backing, "--terms", termsFile, "--signature", signatureFile], "SYNTHETIC");
    const forged = join(scratch, "forged.sig"); writeFileSync(forged, new Uint8Array(64).fill(3));
    await refused(["reader", "terms", "add", ...reader, backing, "--terms", termsFile, "--signature", forged, "--synthetic"], "SIGNATURE");
    const added = await ok(["reader", "terms", "add", ...reader, backing, "--terms", termsFile, "--signature", signatureFile, "--synthetic"]);
    assert.deepEqual([added.backing, added.obligor, added.operator, added.silence.noCommitmentDuration], [backing, hex(obligor), operatorKey, String(SILENCE)]);
    assert.match(added.notes.join(" "), /synthetic reference chain.*no real work/);
    assert.deepEqual(await ok(["reader", "terms", "show", ...reader, backing]), added);
  });

  const served = serve(OP), packageFile = join(scratch, "package.bin");
  let first, viaService;
  await check("operator serve listens, publishes and keeps the checkpoint alive at half silence; a second command refuses BUSY", async () => {
    const listening = await served.listening;
    assert.equal(listening.status, "serving"); assert.equal(listening.silence, String(SILENCE));
    await refused(["operator", "open", "--dir", OP, "--id", "genesis", backing, "--terms", termsFile, "--signature", signatureFile, "--synthetic"], "BUSY");
    await ok(["reader", "service", "add", ...reader, backing, join(OP, "service.json")]);
    first = await ok(["reader", "supply", ...reader, backing]);
    assert.deepEqual([first.status, first.supply, first.issued, first.burned, first.checkpoint.sequence], ["final", "0", "0", "0", "1"]);
    // No statement is admitted: serve commits again at half the silence duration after the canonical checkpoint.
    await mineUntil(async () => /"event":"committed"/.test(served.log()));
    const later = await supplyUntil(read => BigInt(read.checkpoint.sequence) > 1n);
    // The whole package as any transport could carry it, read back below with the service stopped.
    const service = JSON.parse(readFileSync(join(OP, "service.json"), "utf8")), { reference } = parseVenue(JSON.parse(readFileSync(join(OP, "venue.json"), "utf8")));
    const whole = await new V3ServiceClient(service.url, service.walletToken, { operator: Buffer.from(operatorKey, "hex"), reference }).package(Buffer.from(backing, "hex"));
    writeFileSync(packageFile, whole.package);
    await refused(["reader", "presentation", ...reader, backing, hex(new Uint8Array(32).fill(7))], "ABSENT");
    viaService = await ok(["reader", "supply", ...reader, backing]);
  });
  await served.stop();

  await check("with the service stopped, a reader reads the package file on one verifier instance", async () => {
    const offline = await ok(["reader", "supply", ...reader, backing, "--package", packageFile, "--verifiers", "1"]);
    assert.deepEqual({ ...offline, sync: undefined }, { ...viaService, sync: undefined });
    assert.equal((await moe(["reader", "supply", ...reader, backing, "--verifiers", "7"])).status, 2);
  });

  await check("past the terms' silence the operator returns and adopts, then serves again", async () => {
    await mine(Number(SILENCE) + 4);
    const returned = await ok(["operator", "return", "--dir", OP, "--id", "return-1", "--poll-ms", "100"], { mining: 300 });
    assert.equal(returned.status, "pending");
    const adopted = await ok(["operator", "adopt", "--dir", OP, "--poll-ms", "100"], { mining: 300 });
    assert.deepEqual([adopted.status, adopted.receipts], ["final", []]);
    await refused(["reader", "supply", ...reader, backing], "UNAVAILABLE");
    const again = serve(OP);
    await again.listening;
    await ok(["reader", "service", "add", ...reader, backing, join(OP, "service.json")]);
    const after = await supplyUntil(read => BigInt(read.checkpoint.sequence) >= BigInt(returned.commitment.sequence));
    assert.equal(after.supply, "0");
    await again.stop();
  });

  await check("an interrupted venue create anchors again over a stale context; a publication past the spend budget refuses BUDGET", async () => {
    const OP2 = join(scratch, "operator-2");
    const init = await ok(["operator", "init", "--dir", OP2, ...common, "--budget", "1000"]);
    await call("/synthetic/fund", { tree: init.fundingTree, value: "1000000000" });
    // A context an earlier, interrupted run kept for another anchor.
    copyFileSync(join(OP, "anchor.json"), join(OP2, "anchor.json"));
    await mine(3);
    const created = await ok(["operator", "venue", "create", "--dir", OP2, "--synthetic", "--depth", DEPTH]);
    assert.notEqual(created.venue, venue);
    assert.notDeepEqual(readFileSync(join(OP2, "anchor.json")), readFileSync(join(OP, "anchor.json")));
    await mine(Number(DEPTH) + 1);
    const signed = signTerms("terms-2", init.operator, created.venue);
    const over = await refused(["operator", "open", "--dir", OP2, "--id", "genesis", signed.backing, "--terms", signed.terms, "--signature", signed.signature,
      "--synthetic"], "BUDGET");
    assert.match(over.message, /spend budget of 1000 nanoErg/);
  });

  await check("hostile directories: shared modes, another role, an interrupted init, an existing directory", async () => {
    if (process.platform !== "win32") {
      chmodSync(RD, 0o750);
      await refused(["reader", "supply", ...reader, backing], "MODE");
      chmodSync(RD, 0o700);
    }
    await refused(["operator", "serve", "--dir", RD, "--interval", "2"], "ROLE");
    const partial = join(scratch, "partial"); mkdirSync(partial, { mode: 0o700 });
    await refused(["reader", "supply", "--dir", partial, backing], "INCOMPLETE");
    await refused(["reader", "init", "--dir", RD, "--venue", join(OP, "venue.json"), ...common], "EXISTS");
    const usage = await moe(["reader", "supply", ...reader]);
    assert.equal(usage.status, 2);
  });

  await check("SQLite's temporary files stay in the directory (Linux)", async () => {
    if (process.platform !== "linux") return;
    // The command's own opening path: openDirectory sets SQLITE_TMPDIR before the process's first SQLite open (its lock).
    const probe = join(scratch, "tmpdir-probe.mjs");
    writeFileSync(probe, `import { openDirectory } from ${JSON.stringify(new URL("../../../dist/cli/common.js", import.meta.url).href)};
import { DatabaseSync } from "node:sqlite"; import { readdirSync, readlinkSync } from "node:fs";
const directory = openDirectory(process.argv[2], "reader");
const db = new DatabaseSync(directory.file("probe.db")); db.exec("PRAGMA temp_store=FILE; PRAGMA cache_size=2; CREATE TABLE t(x BLOB)");
db.exec("BEGIN"); for (let i = 0; i < 3000; i++) db.prepare("INSERT INTO t VALUES(randomblob(1000))").run(); db.exec("COMMIT");
db.exec("CREATE TEMP TABLE u AS SELECT * FROM t ORDER BY x");
const open = readdirSync("/proc/self/fd").map(fd => { try { return readlinkSync("/proc/self/fd/" + fd); } catch { return ""; } });
console.log(JSON.stringify(open.filter(path => path.includes("etilqs_"))));`);
    const temporary = await new Promise(done => {
      const child = spawn(process.execPath, [probe, RD], { stdio: ["ignore", "pipe", "inherit"] }); let out = "";
      child.stdout.on("data", chunk => { out += chunk; }); child.on("close", () => done(JSON.parse(out)));
    });
    assert(temporary.length > 0 && temporary.every(path => path.startsWith(RD + sep)), JSON.stringify(temporary));
  });

  console.log(JSON.stringify({ status: "passed", checks, processes }, null, 2));
  completed = true;
} finally {
  await node.close();
  if (completed) { assert(scratch.startsWith(realpathSync(join(root, "scratch")) + sep)); rmSync(scratch, { recursive: true, force: true }); }
  else process.stderr.write(`command drill scratch retained after failure: ${scratch}\n`);
}
