// Slice 10 M10c1: the `moe` reader and operator commands in fresh processes on separate data directories, over the
// synthetic Ergo node through the node REST clients (M10b item 5). The operator creates the venue, opens a backing
// under terms a fixture obligor signs, and serves; a reader keeps the terms and the service file and reads the
// supply at its own view's witnessed index. Serve checkpoints on the witnessed index, a second command on a
// directory serve holds refuses BUSY, and after serve stops past the terms' silence the operator returns and adopts.
// Hostile cases: a shared directory, another role's directory, terms under another name, forged or without --synthetic,
// an interrupted venue create, a publication past the spend budget, SQLite's temporary files kept in the directory.
// M10c2b1: the wallet (holder and backer) and relay commands. A backer's wallet creates terms naming a second
// operator directory on the same venue; through fresh processes the backer issues to a holder's exact request, the
// holder pays a shop, serve commits on admission, and the shop fulfills (a rerun exits 4). The shop demands, the
// backer accepts and a relay publishes the acceptance, the shop settles and the backer burns, read final by sync and
// the reader's supply. A withdrawn demand's notes are refused to a payment and freshened; restore-seed and a
// handoff restore the holdings; with the operator offline past silence a demand and its settlement are published
// through the relay and read final by force. Every process's peak RSS is recorded.
// M10c2b2: every command runs from an `npm pack` install in a fresh directory, and no process that proves nothing
// loads a `@noir-lang` module. Past the old 67-statement ceiling (one package in memory), the backer issues 70 notes
// with real proofs to the holder's seed (through the wallet library in this process, to keep the drill's length),
// read by the holder's sync and the reader's supply; then, with the operator offline past silence, a payment
// prepared as it went quiet lapses, the gap redemption runs through the relay, the operator returns and adopts, and
// the lapsed payment is proved again and final, its payee fulfilling it.
// M10d: with --testnet --authorized-testnet the same commands run over the own live testnet node
// (experiments/ergo-range/nodes.mjs, synced), without --synthetic, which there is the hostile switch. The chain moves
// by itself where the synthetic drill mines; each funding directory is paid from the retained testnet wallet and
// swept back to it at the end; the terms' silence is longer for real block times; and the 70-note issue is two notes
// (the old ceiling is a property of one package in memory, not of the chain). It writes
// docs/pool-v3-command-testnet-verification.json.
//
// Usage: node scripts/pool/v3/command-drill.mjs [--testnet --authorized-testnet]
//   (after npm run build and scripts/pool/prepare-crs.mjs)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { openView, parseVenue } from "../../../dist/cli/venue.js";
import { readParameters } from "../../../dist/pool/parameter-files.js";
import { startBackend } from "../../../dist/pool/proof-verifier.js";
import { prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { openV3Prover } from "../../../dist/pool/v3/prover.js";
import { keptFileDigest } from "../../../dist/pool/v3/replay-store.js";
import { V3Wallet } from "../../../dist/pool/v3/wallet-store.js";
import { adoptedDomain } from "../../../dist/pool/v3/configuration.js";
import { V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../../../dist/pool/v3/terms.js";
import { DatabaseSync } from "node:sqlite";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { payToPublicKeyTree } from "../../../dist/ergo-publisher.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";
import { V3_SPECIFICATION, sourceClosure, sourceHashes } from "./provenance.mjs";
import { serveSyntheticNode } from "./synthetic-node.mjs";

const root = resolve(import.meta.dirname, "../../.."), RSS_HOOK = new URL("./rss-hook.mjs", import.meta.url).href;
const hex = bytes => Buffer.from(bytes).toString("hex");
const ARGS = process.argv.slice(2);
assert(ARGS.length === 0 || (ARGS.length === 2 && ARGS[0] === "--testnet" && ARGS[1] === "--authorized-testnet"),
  "command-drill takes no argument, or --testnet --authorized-testnet");
const LIVE = ARGS.length === 2, started = performance.now();
const testnet = LIVE ? await import("./testnet.mjs") : undefined;
// The report binds the drill, the live harness and the commands it runs (their packed build is of these sources).
const SOURCES = sourceClosure(["scripts/pool/v3/command-drill.mjs", "scripts/pool/v3/testnet.mjs", "scripts/pool/v3/rss-hook.mjs", "dist/cli/moe.js",
  "package.json", "package-lock.json"]);
const HASHES = sourceHashes(SOURCES);
const obligorSecret = new Uint8Array(32).fill(41), obligor = ed25519.getPublicKey(obligorSecret);
// Live, a silence of 30 blocks (about 23 minutes at 45 s) leaves serve's keep-alive commitments slack for slow blocks.
const SILENCE = LIVE ? 30n : 16n, DEPTH = "2";
// The synthetic chain's switch; live, the same switch is the hostile one.
const SYN = LIVE ? [] : ["--synthetic"], WRONG = LIVE ? ["--synthetic"] : [];
const POLL = LIVE ? "5000" : "100";
// Each funding directory's key is paid FUND; its config caps what it publishes at BUDGET (serve commits for hours live).
const FUND = 1_000_000_000n, BUDGET = LIVE ? "500000000" : "50000000";
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
const checks = [], processes = [], servers = [];

/** The package exactly as a consumer installs it: packed, installed into a fresh directory outside the checkout's
 * dependency tree, and its `moe` run from there. */
function installPacked() {
  const npm = process.env.npm_execpath, consumer = join(scratch, "consumer");
  const run = (args, cwd) => {
    const result = npm === undefined ? spawnSync("npm", args, { cwd, encoding: "utf8", windowsHide: true, shell: process.platform === "win32", timeout: 300_000 })
      : spawnSync(process.execPath, [npm, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 300_000 });
    assert.equal(result.status, 0, `npm ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
    return result.stdout;
  };
  const [packed] = JSON.parse(run(["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], root));
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "moe-drill-consumer", private: true, type: "module" }));
  run(["install", "--ignore-scripts", "--no-audit", "--no-fund", join(scratch, packed.filename)], consumer);
  const bin = join(consumer, "node_modules", "@mediumofexchange", "reference", "dist", "cli", "moe.js");
  assert(statSync(bin).isFile(), "the packed install carries the moe bin");
  // The consumer resolves the package's dependency ranges itself: its lockfile names what the commands ran on.
  const consumerLock = createHash("sha256").update(readFileSync(join(consumer, "package-lock.json"))).digest("hex");
  return { bin, tarballBytes: statSync(join(scratch, packed.filename)).size, files: packed.entryCount, consumerLock };
}
const packed = installPacked(), MOE = packed.bin;
const check = async (label, fn) => { await fn(); checks.push(label); process.stderr.write(`passed: ${label}\n`); };

const pause = ms => new Promise(done => setTimeout(done, ms));
const node = LIVE ? undefined : await serveSyntheticNode(), NODE_URL = LIVE ? testnet.TESTNET_ENDPOINT : node.url;
if (LIVE) await testnet.testnetInfo(); // The own testnet node, synced.
const call = async (path, body) => {
  const response = await fetch(`${node.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
/** The live node's full height; a node busy for a moment is asked again. */
async function liveHeight() {
  for (let tries = 0; ; tries++) {
    try { return BigInt((await (await fetch(`${NODE_URL}/info`, { signal: AbortSignal.timeout(30_000) })).json()).fullHeight); }
    catch (error) { assert(tries < 10, `testnet /info: ${error.message}`); await pause(10_000); }
  }
}
/** The chain moves `count` blocks: mined on the synthetic node, waited for live (ten minutes a block at most). */
async function advance(count) {
  if (!LIVE) return call("/synthetic/mine", { count });
  const target = (await liveHeight()) + BigInt(count), deadline = Date.now() + 600_000 * Math.max(1, count);
  while (await liveHeight() < target) { assert(Date.now() < deadline, "the testnet did not advance in time"); await pause(10_000); }
}
/** One round of waiting for something serve or the relay publishes: past the depth on the synthetic chain, one block
 * live (each round's caller allows ROUNDS times as many). */
const nextRound = async () => { if (LIVE) await advance(1); else { await advance(Number(DEPTH) + 2); await pause(400); } };
const ROUNDS = LIVE ? Number(DEPTH) + 2 : 1;
/** Pay a funding directory's key: the synthetic node's fund, or live a transfer from the retained testnet wallet. */
const walletKey = LIVE ? testnet.testnetWalletKey() : undefined, transfers = [];
async function fund(tree, value) {
  if (!LIVE) return call("/synthetic/fund", { tree, value: String(value) });
  transfers.push({ to: tree, ...await testnet.testnetTransfer(walletKey, { outputs: [{ tree: Buffer.from(tree, "hex"), value }] }) });
}
let sweptAll = false;
/** Live: what each funding directory under the drill's scratch reserved for its publications (its spend budget's
 * ledger, refused or uncertain broadcasts included), and the sweep of its key back to the retained wallet, confirmed
 * at the venue's lag and read back as leaving at most dust. Only then may the scratch, keys included, be deleted. */
async function sweep() {
  const walletTree = payToPublicKeyTree(secp256k1.getPublicKey(walletKey, true)), lag = Number(DEPTH) + 1;
  const keys = readdirSync(scratch).sort().filter(name => existsSync(join(scratch, name, "funding.key")));
  const out = keys.map(name => {
    let reservedNanoErg = "0";
    try {
      const db = new DatabaseSync(join(scratch, name, "spend.db"), { readOnly: true, readBigInts: true });
      try { reservedNanoErg = String(db.prepare("SELECT COALESCE(SUM(cost),0) AS n FROM spend").get().n); } finally { db.close(); }
    } catch { /* nothing published */ }
    return { directory: name, reservedNanoErg, sweeps: [] };
  });
  // A box a late publication created, or one a dropped ancestor took with it, is found by the next round.
  for (let round = 0; ; round++) {
    let sent = 0;
    for (const entry of out) {
      const key = new Uint8Array(readFileSync(join(scratch, entry.directory, "funding.key")));
      try {
        const swept = await testnet.testnetTransfer(key, { sweepTo: walletTree });
        if (swept !== undefined) { entry.sweeps.push(swept); sent++; }
      } finally { key.fill(0); }
    }
    if (sent === 0) break;
    assert(round < 4, "funding keys still hold value after four sweep rounds");
    for (const entry of out) for (const swept of entry.sweeps) {
      const deadline = Date.now() + 30 * 60_000;
      while (await testnet.testnetConfirmations(swept.id) < lag) { assert(Date.now() < deadline, `sweep ${swept.id} unconfirmed`); await pause(15_000); }
    }
  }
  sweptAll = true;
  return out;
}

/** One `moe` process: its exit code, stdout's JSON and stderr. With `mining: "waiting"`, each wait it logs mines one
 * block, so the chain moves with the command's retries rather than the wall clock (a slow runner would otherwise see
 * more indices pass between two tries than a schedule's window). */
function moe(args, { mining, input } = {}) {
  return new Promise((done, failed) => {
    const rss = join(scratch, `rss-${processes.length}-${process.hrtime.bigint()}.json`);
    const began = performance.now(), child = spawn(process.execPath, ["--import", RSS_HOOK, MOE, ...args],
      { cwd: scratch, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, MOE_DRILL_RSS: rss } });
    if (input !== undefined) child.stdin.end(input);
    const out = [], err = [];
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => {
      err.push(chunk);
      if (mining !== "waiting" || LIVE) return;
      const seen = Buffer.concat(err).toString().split("\n").filter(line => line.includes('"event":"waiting"')).length;
      for (; waits < seen; waits++) advance(1).catch(() => {});
    });
    let waits = 0;
    child.on("error", failed);
    child.on("close", status => {
      const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
      let maxRssKb = null, noir = null;
      try { ({ maxRssKb, noir } = JSON.parse(readFileSync(rss, "utf8"))); rmSync(rss); } catch { /* a process that died before its exit handler */ }
      processes.push({ command: args.slice(0, 2).join(" "), status, elapsedMs: Math.round(performance.now() - began), maxRssKb, noir });
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
  const rss = join(scratch, `rss-serve-${process.hrtime.bigint()}.json`), began = performance.now();
  const child = spawn(process.execPath, ["--import", RSS_HOOK, MOE, "operator", "serve", "--dir", directory, "--interval", "2", "--poll-ms", POLL],
    { cwd: scratch, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MOE_DRILL_RSS: rss } });
  servers.push(child);
  let stdout = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(done => child.on("close", status => done(status)));
  const listening = new Promise((done, failed) => {
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.includes("\n")) done(JSON.parse(stdout.split("\n")[0])); });
    exited.then(status => failed(new Error(`serve exited ${status}: ${stderr}`)));
  });
  return { listening, log: () => stderr, async stop() {
    // POSIX delivers SIGTERM to serve's handler, which drains and exits 0; Windows ends the process outright, and
    // the operating system releases its directory lock either way.
    child.kill("SIGTERM"); const status = await exited;
    if (process.platform !== "win32") assert.equal(status, 0, stderr);
    let maxRssKb = null, noir = null;
    try { ({ maxRssKb, noir } = JSON.parse(readFileSync(rss, "utf8"))); rmSync(rss); } catch { /* ended outright (Windows) */ }
    processes.push({ command: "operator serve (running)", status, elapsedMs: Math.round(performance.now() - began), maxRssKb, noir });
  } };
}

/** Mine one block at a time until `until()` holds, at most `count` blocks. */
async function mineUntil(until, count = 200) {
  for (let i = 0; i < count; i++) {
    if (await until()) return;
    await advance(1); if (!LIVE) await pause(150);
  }
  assert.fail("the condition did not hold within the blocks mined");
}

let completed = false;
try {
  const OP = join(scratch, "operator"), RD = join(scratch, "reader"), common = ["--node", NODE_URL, "--parameters", PARAMETER_DIRECTORY];
  // The synthetic node mines a few blocks before the venue is created; the testnet's tip is already past any depth.
  if (!LIVE) await advance(Number(DEPTH) + 2);

  let operatorKey, fundingTree, venue, backing, termsFile, signatureFile;
  await check("operator init, funding, venue create (rerun prints the same file, refuses other flags)", async () => {
    const init = await ok(["operator", "init", "--dir", OP, ...common, "--budget", BUDGET]);
    assert.equal(init.status, "created");
    operatorKey = init.operator; fundingTree = init.fundingTree;
    assert.equal(statSync(OP).mode & 0o777, process.platform === "win32" ? statSync(OP).mode & 0o777 : 0o700);
    await fund(fundingTree, FUND);
    await refused(["operator", "venue", "create", "--dir", OP, ...WRONG, "--depth", DEPTH], "VENUE");
    const created = await ok(["operator", "venue", "create", "--dir", OP, ...SYN, "--depth", DEPTH]);
    assert.equal(created.status, "created");
    const again = await ok(["operator", "venue", "create", "--dir", OP, ...SYN, "--depth", DEPTH]);
    assert.deepEqual([again.status, again.venue], ["existing", created.venue]);
    // A rerun asking for another context or depth than the file's is refused, not answered "existing".
    await refused(["operator", "venue", "create", "--dir", OP, ...WRONG, "--depth", DEPTH], "VENUE");
    await refused(["operator", "venue", "create", "--dir", OP, ...SYN, "--depth", String(Number(DEPTH) + 1)], "VENUE");
    venue = created.venue;
    await advance(Number(DEPTH) + 1);
    if (process.platform !== "win32") for (const file of readdirSync(OP)) assert.equal(statSync(join(OP, file)).mode & 0o077, 0, `${file} is owner-only`);
  });

  await check("operator open under terms a fixture obligor signed, published and witnessed", async () => {
    ({ backing, terms: termsFile, signature: signatureFile } = signTerms("terms", operatorKey, venue));
    const files = ["--terms", termsFile, "--signature", signatureFile];
    await refused(["operator", "open", "--dir", OP, "--id", "genesis", backing, ...files, ...WRONG], "SYNTHETIC");
    await refused(["operator", "open", "--dir", OP, "--id", "genesis", hex(new Uint8Array(32).fill(9)), ...files, ...SYN], "NAME");
    const opened = await ok(["operator", "open", "--dir", OP, "--id", "genesis", backing, ...files, ...SYN]);
    assert.deepEqual([opened.status, opened.commitment.sequence, opened.commitment.operator], ["pending", "1", operatorKey]);
    const again = await ok(["operator", "open", "--dir", OP, "--id", "genesis", backing, ...files, ...SYN]);
    assert.deepEqual(again.commitment, opened.commitment, "an exact rerun prints the saved commitment");
    await advance(Number(DEPTH) + 2);
  });

  const reader = ["--dir", RD];
  /** A reader command whose kept replay file fails its digest, so it is discarded and the read replays in full. */
  const full = args => { writeFileSync(join(RD, "replay.db.sha256"), "00".repeat(32)); return ok(args); };
  /** A read replaying in full answers as the kept read did. Live, the chain moves by itself, so a pair that judged at
   * two indices is read again, five times at most; the synthetic chain moves only when mined. */
  const alike = async (kept, args) => {
    for (let attempt = 1; ; attempt++) {
      const replayed = await full(args);
      if (LIVE && replayed.judgingIndex !== kept.judgingIndex && attempt < 5) { kept = await ok(args); continue; }
      return assert.deepEqual({ ...replayed, sync: undefined }, { ...kept, sync: undefined });
    }
  };
  /** Serve publishes on its own poll after it commits: mine past the depth and read until `until` holds, a few
   * rounds at most, so the drill does not race serve's publication on a slow runner. */
  const supplyUntil = async (until, rounds = 8, which = backing) => {
    for (let round = 0; ; round++) {
      await nextRound();
      const read = await ok(["reader", "supply", ...reader, which]);
      if (read.checkpoint !== undefined && until(read)) return read;
      assert(round < rounds * ROUNDS, `the reader's supply did not reach the expected checkpoint: ${JSON.stringify(read.checkpoint)}`);
    }
  };
  await check("reader init with the operator's venue file, terms add (the synthetic chain only with --synthetic), terms show", async () => {
    const init = await ok(["reader", "init", ...reader, "--venue", join(OP, "venue.json"), ...common]);
    assert.equal(init.venue, venue);
    await refused(["reader", "terms", "add", ...reader, backing, "--terms", termsFile, "--signature", signatureFile, ...WRONG], "SYNTHETIC");
    const forged = join(scratch, "forged.sig"); writeFileSync(forged, new Uint8Array(64).fill(3));
    await refused(["reader", "terms", "add", ...reader, backing, "--terms", termsFile, "--signature", forged, ...SYN], "SIGNATURE");
    const added = await ok(["reader", "terms", "add", ...reader, backing, "--terms", termsFile, "--signature", signatureFile, ...SYN]);
    assert.deepEqual([added.backing, added.obligor, added.operator, added.silence.noCommitmentDuration], [backing, hex(obligor), operatorKey, String(SILENCE)]);
    // Only the synthetic chain is explained as having no real work.
    assert.equal(/synthetic reference chain.*no real work/.test(added.notes.join(" ")), !LIVE);
    assert.deepEqual(await ok(["reader", "terms", "show", ...reader, backing]), added);
  });

  const served = serve(OP), packageFile = join(scratch, "package.bin");
  let first, viaService;
  await check("operator serve listens, publishes and keeps the checkpoint alive within silence less the lag; a second command refuses BUSY", async () => {
    const listening = await served.listening;
    assert.equal(listening.status, "serving"); assert.equal(listening.silence, String(SILENCE));
    await refused(["operator", "open", "--dir", OP, "--id", "genesis", backing, "--terms", termsFile, "--signature", signatureFile, ...SYN], "BUSY");
    await ok(["reader", "service", "add", ...reader, backing, join(OP, "service.json")]);
    first = await ok(["reader", "supply", ...reader, backing]);
    assert.deepEqual([first.status, first.supply, first.issued, first.burned, first.checkpoint.sequence], ["final", "0", "0", "0", "1"]);
    // No statement is admitted: serve commits again at half the silence less the lag after the canonical checkpoint.
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
    // Live, blocks arrive after serve stopped: the package file is read at the later index, to the same answer.
    const index = LIVE ? { judgingIndex: undefined } : {};
    assert.deepEqual({ ...offline, sync: undefined, ...index }, { ...viaService, sync: undefined, ...index });
    assert(BigInt(offline.judgingIndex) >= BigInt(viaService.judgingIndex));
    assert.equal((await moe(["reader", "supply", ...reader, backing, "--verifiers", "7"])).status, 2);
  });

  await check("past the terms' silence the operator returns and adopts, then serves again", async () => {
    await advance(Number(SILENCE) + 4);
    const returned = await ok(["operator", "return", "--dir", OP, "--id", "return-1", "--poll-ms", POLL], { mining: "waiting" });
    assert.equal(returned.status, "pending");
    const adopted = await ok(["operator", "adopt", "--dir", OP, "--poll-ms", POLL], { mining: "waiting" });
    assert.deepEqual([adopted.status, adopted.receipts], ["final", []]);
    await refused(["reader", "supply", ...reader, backing], "UNAVAILABLE");
    const again = serve(OP);
    await again.listening;
    await ok(["reader", "service", "add", ...reader, backing, join(OP, "service.json")]);
    const after = await supplyUntil(read => BigInt(read.checkpoint.sequence) >= BigInt(returned.commitment.sequence));
    assert.equal(after.supply, "0");
    // Kept across the return's new term: a read replaying in full at the same index answers the same.
    await alike(after, ["reader", "supply", ...reader, backing]);
    await again.stop();
  });

  // The wallet and relay commands (M10c2b): a backer's terms on the operator's venue, holders' wallets, a relay.
  const OW = join(scratch, "operator-wallets"), BK = join(scratch, "backer"), HD = join(scratch, "holder"), SH = join(scratch, "shop"), RL = join(scratch, "relay");
  const wallet = (verb, directory, ...rest) => ["wallet", ...verb.split(" "), "--dir", directory, ...rest];
  let backing2, serving, walletOperator;
  /** Mine and rerun `args` until it exits 0 and `until` holds of its output, a few rounds at most. */
  const settled = async (args, until, rounds = 12) => {
    for (let round = 0; ; round++) {
      await nextRound();
      const result = await moe(args);
      if (result.status === 0 && until(result.json)) return result.json;
      assert(round < rounds * ROUNDS, `moe ${args.join(" ")} did not settle: ${result.stdout}${result.stderr}`);
    }
  };
  /** Mine, sync and read the saved record under `alias` until it is final: sync resolves saved records. */
  const finalOf = async (directory, alias, rounds = 12) => {
    for (let round = 0; ; round++) {
      await nextRound();
      await ok(wallet("sync", directory, backing2));
      const saved = await ok(wallet("status", directory, alias));
      if (saved.status === "final") return saved;
      assert(round < rounds * ROUNDS, `${alias} did not become final: ${JSON.stringify(saved)}`);
    }
  };
  /** A submission, retried while serve waits out its reopening lag (C2.8.2) and refuses SCHEDULE. */
  const submit = async (directory, alias) => {
    for (let round = 0; ; round++) {
      const result = await moe(wallet("submit", directory, alias, backing2));
      if (result.status === 0) return result.json;
      assert(round < 12 && result.refusal?.code === "SCHEDULE", `moe wallet submit ${alias}: ${result.stderr}`);
      await advance(1); if (!LIVE) await pause(300);
    }
  };
  const holdings = view => view.holdings.map(h => [h.value, h.status, h.presented.length]).sort();
  /** A request from `directory`, its frame in a file and its digest. */
  const request = async (directory, alias, value) => {
    const out = join(scratch, `${alias}.request`), made = await ok(wallet("request", directory, alias, backing2, String(value), "--out", out));
    return { made, args: ["--request", out, "--digest", made.digest] };
  };

  await check("a backer's wallet creates terms naming the operator; the operator opens them; holders keep them", async () => {
    // A journal holds one genesis segment: the backer's backing has an operator directory of its own on the same venue.
    const operator = await ok(["operator", "init", "--dir", OW, "--venue", join(OP, "venue.json"), ...common, "--budget", BUDGET]);
    await fund(operator.fundingTree, FUND);
    walletOperator = operator.operator;
    const init = await ok(wallet("init", BK, "--backer", "--venue", join(OP, "venue.json"), ...common));
    assert.match(init.backer, /^[0-9a-f]{64}$/);
    await refused(wallet("terms create", HD), "ABSENT");
    const created = await ok(wallet("terms create", BK, "--operator", operator.operator, "--thing", "drill units", "--per-unit", "1", "--interval", "80",
      "--silence", String(SILENCE), "--challenge", "5"));
    backing2 = created.backing;
    await ok(["operator", "open", "--dir", OW, "--id", "genesis", backing2, "--terms", created.terms, "--signature", created.signature, ...SYN]);
    for (const directory of [HD, SH]) {
      await ok(wallet("init", directory, "--venue", join(OP, "venue.json"), ...common));
      await refused(wallet("issue", directory, "x", backing2), "ABSENT");
      const added = await ok(wallet("terms add", directory, backing2, "--terms", created.terms, "--signature", created.signature, ...SYN));
      assert.equal(added.obligor, init.backer);
    }
    // A backer's venue create makes the wallet database in the run that creates the venue; a rerun over a lost one
    // refuses rather than making a fresh seed.
    const BK2 = join(scratch, "backer-2");
    await ok(wallet("init", BK2, "--backer", ...common));
    await ok(wallet("venue create", BK2, ...SYN, "--depth", DEPTH));
    assert.equal((await ok(wallet("venue create", BK2, ...SYN, "--depth", DEPTH))).status, "existing");
    for (const file of readdirSync(BK2).filter(name => name.startsWith("wallet.db"))) rmSync(join(BK2, file));
    await refused(wallet("venue create", BK2, ...SYN, "--depth", DEPTH), "ABSENT");
    // A holder's wallet holds no K: the backer's commands refuse it.
    await refused(wallet("burn", HD, "x", backing2, "1"), "ROLE");
    // A relay verifies nothing and keeps no proving parameters.
    const relay = await ok(["relay", "init", "--dir", RL, "--venue", join(OP, "venue.json"), "--node", NODE_URL, "--budget", BUDGET]);
    await fund(relay.fundingTree, FUND);
    await advance(Number(DEPTH) + 2);
  });

  await check("issue, payment and fulfillment through wallet commands; serve commits on admission; fulfill is never replayed", async () => {
    serving = serve(OW);
    await serving.listening;
    for (const directory of [BK, HD, SH]) await ok(wallet("service add", directory, backing2, join(OW, "service.json")));
    const fund = await request(HD, "fund", 10);
    assert.equal(fund.made.notes.length, 3, "the first request explains");
    const issued = await ok(wallet("issue", BK, "issue-1", backing2, ...fund.args, "--value", "10"));
    assert.deepEqual([issued.status, issued.kind], ["pending", "issue"]);
    const submitted = await submit(BK, "issue-1");
    assert.equal(submitted.status, "pending");
    // An exact rerun is the library's retry: the saved record, without evidence or a new proof.
    const again = await ok(wallet("issue", BK, "issue-1", backing2, ...fund.args, "--value", "10"));
    assert.deepEqual([again.statement, again.evidence], [issued.statement, "saved"]);
    await finalOf(BK, "issue-1");
    const funded = await ok(wallet("sync", HD, backing2));
    assert.deepEqual(holdings(funded), [["10", "available", 0]]);
    assert.equal(funded.evidence, "served");
    const invoice = await request(SH, "invoice", 3);
    const paid = await ok(wallet("pay", HD, "pay-1", backing2, ...invoice.args, "--value", "3"));
    assert.deepEqual([paid.status, paid.kind, paid.value], ["pending", "payment", "3"]);
    assert.notEqual(paid.receipt, null);
    assert.equal(paid.notes, undefined, "explained once, at the wallet's first request");
    // The payer agrees to the request's exact value; the alias names one order.
    await refused(wallet("pay", HD, "pay-1", backing2, ...invoice.args, "--value", "2"), "INVALID");
    await refused(wallet("pay", HD, "pay-1", backing2, ...(await request(SH, "invoice-b", 3)).args, "--value", "3"), "CONFLICT");
    await refused(wallet("pay", HD, "pay-2", backing2, invoice.args[0], invoice.args[1], "--digest", "00".repeat(32), "--value", "3"), "REQUEST");
    const fulfilled = await settled(wallet("fulfill", SH, "invoice", backing2), () => true);
    assert.deepEqual([fulfilled.status, fulfilled.value], ["final", "3"]);
    const replay = await moe(wallet("fulfill", SH, "invoice", backing2));
    assert.equal(replay.status, 4, replay.stderr);
    const { status: _status, evidence: _evidence, ...saved } = fulfilled;
    assert.deepEqual(JSON.parse(replay.stdout), { status: "replay", ...saved });
    assert.deepEqual(await ok(wallet("fulfillment", SH, "invoice")), { status: "final", ...saved });
    assert.deepEqual(holdings(await ok(wallet("sync", HD, backing2))), [["7", "available", 0]]);
    assert.equal((await ok(wallet("status", HD, "pay-1"))).status, "final");
  });

  let demanded;
  await check("demand, the backer's acceptance relayed, settlement and burn through wallet commands, final by sync and the reader", async () => {
    const shown = await ok(wallet("demand", SH, "redeem", backing2, "3", "--deadline", "+60"));
    assert.deepEqual([shown.status, shown.kind, shown.repeats], ["pending", "demand", []]);
    assert.match(shown.notes[0], /tags become public/);
    demanded = shown;
    // Outside a gap a publication has no force and discloses what it names: refused.
    await refused(wallet("publish", SH, "redeem", backing2, "--out", join(scratch, "early.json")), "GAP");
    await submit(SH, "redeem");
    await finalOf(SH, "redeem");
    const locked = await ok(wallet("sync", SH, backing2));
    assert.deepEqual(holdings(locked), [["3", "locked", 1]]);
    assert.deepEqual(locked.demands.map(d => d.id), [shown.demand]);
    const acceptance = join(scratch, "answer.acceptance"), relayed = join(scratch, "answer.json");
    const accepted = await ok(wallet("accept", BK, "answer", backing2, shown.demand, "--deadline", String(BigInt(shown.deadline) - 10n), "--out", acceptance));
    assert.equal(accepted.demand, shown.demand);
    await ok(wallet("publish-acceptance", BK, "answer", backing2, "--out", relayed));
    // The relay checks the file against its own venue and publishes it with its funding key, keyed by the record.
    const sent = await ok(["relay", "publish", "--dir", RL, relayed]);
    assert.equal(sent.status, "pending"); assert.match(sent.transaction, /^[0-9a-f]{64}$/);
    const witnessed = await settled(["relay", "publish", "--dir", RL, relayed], out => out.status === "final");
    assert.equal(witnessed.record, sent.record);
    const settlement = await ok(wallet("settle", SH, "settle-1", backing2, "--acceptance", acceptance));
    assert.deepEqual([settlement.kind, settlement.demand], ["settlement", shown.demand]);
    await submit(SH, "settle-1");
    await finalOf(SH, "settle-1");
    assert.deepEqual((await ok(wallet("sync", SH, backing2))).holdings, []);
    const reading = await ok(wallet("presentation", HD, backing2, shown.demand));
    assert.deepEqual([reading.status, reading.ended.by, reading.acceptances.length], ["final", "settlement", 1]);
    // The settlement paid K's own owner: the backer's wallet finds the note from its seed and burns it.
    assert.deepEqual(holdings(await ok(wallet("sync", BK, backing2))), [["3", "available", 0]]);
    await ok(wallet("burn", BK, "retire", backing2, "3"));
    await submit(BK, "retire");
    await finalOf(BK, "retire");
    await ok(["reader", "terms", "add", ...reader, backing2, "--terms", join(BK, "terms", backing2), "--signature", join(BK, "terms", `${backing2}.sig`), ...SYN]);
    await ok(["reader", "service", "add", ...reader, backing2, join(OW, "service.json")]);
    const read = await supplyUntil(read => read.burned === "3", 8, backing2);
    assert.deepEqual([read.issued, read.burned, read.supply], ["10", "3", "7"]);
    // The reader's C3.8 reading of the settled demand, on its kept file and replayed in full at the same index.
    const presented = await ok(["reader", "presentation", ...reader, backing2, demanded.demand]);
    assert.deepEqual([presented.status, presented.ended.by, presented.acceptances.length], ["final", "settlement", 1]);
    await alike(presented, ["reader", "presentation", ...reader, backing2, demanded.demand]);
  });

  let withdrawn;
  await check("a withdrawn demand's notes are presented: payment refuses them, freshen moves them to one fresh note", async () => {
    const shown = await ok(wallet("demand", HD, "d2", backing2, "7", "--deadline", "+60"));
    await submit(HD, "d2");
    await finalOf(HD, "d2");
    withdrawn = shown.demand;
    await ok(wallet("withdraw", HD, "w2", backing2, withdrawn));
    await submit(HD, "w2");
    await finalOf(HD, "w2");
    assert.deepEqual(holdings(await ok(wallet("sync", HD, backing2))), [["7", "available", 1]]);
    const invoice = await request(SH, "invoice-2", 2);
    await refused(wallet("pay", HD, "pay-2", backing2, ...invoice.args, "--value", "2"), "FUNDS");
    const fresh = await ok(wallet("freshen", HD, "fresh-2", backing2, withdrawn));
    assert.deepEqual([fresh.kind, fresh.freshens, fresh.value], ["freshen", withdrawn, "7"]);
    await finalOf(HD, "fresh-2");
    assert.deepEqual(holdings(await ok(wallet("sync", HD, backing2))), [["7", "available", 0]]);
  });

  const H2 = join(scratch, "holder-seed"), H3 = join(scratch, "holder-handoff");
  await check("restore-seed finds the holdings from the seed alone; a handoff freezes its source and restores once", async () => {
    const { seed } = await ok(wallet("seed", HD, "--show"));
    assert.match(seed, /^[0-9a-f]{64}$/);
    assert.equal((await moe(wallet("seed", HD))).status, 2, "seed needs --show");
    await ok(["wallet", "restore-seed", "--dir", H2, "--venue", join(OP, "venue.json"), ...common], { input: `${seed}\n` });
    await ok(wallet("terms add", H2, backing2, "--terms", join(BK, "terms", backing2), "--signature", join(BK, "terms", `${backing2}.sig`), ...SYN));
    await ok(wallet("service add", H2, backing2, join(OW, "service.json")));
    assert.deepEqual(holdings(await ok(wallet("sync", H2, backing2))), [["7", "available", 0]]);
    const key = join(scratch, "handoff.key"), out = join(scratch, "handoff.bin");
    await refused(wallet("handoff", HD, "--key", join(HD, "inside.key"), "--out", out), "PATH");
    const frozen = await ok(wallet("handoff", HD, "--key", key, "--out", out));
    assert.deepEqual(await ok(wallet("handoff", HD, "--key", key, "--out", out)), frozen, "a rerun reuses the key and prints the same handoff");
    await refused(wallet("sync", HD, backing2), "FENCED");
    const restoreArgs = ["wallet", "restore", "--dir", H3, "--venue", join(OP, "venue.json"), ...common, "--key", key, "--backup", out, "--digest", frozen.digest];
    await ok(restoreArgs);
    assert.deepEqual((await ok(restoreArgs)).status, "restored");
    await refused([...restoreArgs.slice(0, -1), "0".repeat(64)], "EXISTS");
    // The handoff carries the wallet database; the public terms and service file are kept again.
    await ok(wallet("terms add", H3, backing2, "--terms", join(BK, "terms", backing2), "--signature", join(BK, "terms", `${backing2}.sig`), ...SYN));
    await ok(wallet("service add", H3, backing2, join(OW, "service.json")));
    assert.deepEqual(holdings(await ok(wallet("sync", H3, backing2))), [["7", "available", 0]]);
    assert.deepEqual((await ok(wallet("status", H3, "fresh-2"))).status, "final", "the handoff carries the saved records");
  });

  /** The backer issues `count` notes of one unit to `seed`, each with a real proof, through the wallet library in this
   * process over the backer's own directory (no command holds it meanwhile), submitted to the running service. */
  async function bulkIssue(count, seed) {
    const directory = { path: BK, config: JSON.parse(readFileSync(join(BK, "config.json"), "utf8")), file: name => join(BK, name) };
    const view = openView(directory), api = await startBackend(await readParameters(PARAMETER_DIRECTORY));
    let prover, held, key;
    try {
      await view.sync();
      prover = await openV3Prover(api);
      held = new V3Wallet(join(BK, "wallet.db"), { venue: view.venue, reference: view.file.reference, verifier: prover.verifier });
      const terms = { terms: readFileSync(join(BK, "terms", backing2)), signature: readFileSync(join(BK, "terms", `${backing2}.sig`)) };
      const service = JSON.parse(readFileSync(join(OW, "service.json"), "utf8")), backing = Buffer.from(backing2, "hex"), domain = adoptedDomain();
      const client = new V3ServiceClient(service.url, service.walletToken, { operator: Buffer.from(walletOperator, "hex"), reference: view.file.reference });
      key = readFileSync(join(BK, "backer.key"));
      const evidence = (await held.supply(store => client.sync(backing, store))).package;
      for (let i = 0; i < count; i++) {
        const id = new Uint8Array(32); id[0] = 0xb0; id[31] = i;
        const out = prepareExactOutput(seed, domain, id, backing, 1n);
        await held.issue(`bulk-${i}`, { domain, opening: out.opening, cm: out.cm, capsule: out.capsule }, 1n, evidence, terms,
          task => prover.prove(task), message => ed25519.sign(message, key));
        await held.submit(`bulk-${i}`, client);
      }
    } finally { held?.close(); key?.fill(0); await prover?.close(); await api.destroy(); view.close(); }
  }

  // Live, two notes give the offline check below its one-unit payment; the old ceiling is the synthetic drill's.
  const BULK = LIVE ? 2 : 70;
  let readerReplay;
  await check(`${LIVE ? "" : "past the old 67-statement ceiling: "}${BULK} real-proof issues to the holder's seed, synced by the holder and the reader; ` +
      "the reader's next process rests on its kept replay file, and one whose file fails its digest replays in full to the same answer", async () => {
    const { seed } = await ok(wallet("seed", H3, "--show"));
    await bulkIssue(BULK, Buffer.from(seed, "hex"));
    let read = await supplyUntil(read => read.issued === String(10 + BULK), 12, backing2);
    if (!LIVE) assert(BigInt(read.position) > 67n, `position ${read.position}`);
    // Nothing is mined between these reads, so each judges at the same index (item (w), M11b6). Live, the chain moves
    // by itself: a pair whose second read judged at a later index is read again (moved() below), five times at most.
    const same = answer => assert.deepEqual({ ...answer, sync: undefined }, { ...read, sync: undefined });
    const moved = (answer, attempt) => LIVE && answer.judgingIndex !== read.judgingIndex && attempt < 5;
    // The last read left a keep point: the digest vouches for the file, so the next process opens it as kept.
    const keptFile = () => ({ digest: readFileSync(join(RD, "replay.db.sha256"), "utf8"), digestMtimeMs: statSync(join(RD, "replay.db.sha256")).mtimeMs,
      file: keptFileDigest(join(RD, "replay.db")) });
    let keptMs;
    for (let attempt = 1; ; attempt++) {
      const vouched = keptFile();
      assert.equal(vouched.digest, vouched.file, "the reader's last read left its replay file vouched for by its digest");
      const kept = await ok(["reader", "supply", ...reader, backing2]);
      keptMs = processes.at(-1).elapsedMs;
      if (moved(kept, attempt)) { read = kept; continue; }
      same(kept);
      // At the same index with nothing new, a read resting on the kept state writes nothing; one that discarded it
      // (a failed digest, a kept-state mismatch) rebuilds the file and records a new digest. A count of proofs
      // verified on reopening is pool-v3-kept-state.test.ts's.
      assert.deepEqual(keptFile(), vouched, "the kept read rested on the kept replay file: it neither discarded nor rewrote it");
      break;
    }
    for (let attempt = 1; ; attempt++) {
      const replayed = await full(["reader", "supply", ...reader, backing2]);
      if (moved(replayed, attempt)) { read = await ok(["reader", "supply", ...reader, backing2]); continue; }
      same(replayed);
      break;
    }
    // The full read discarded the file its digest no longer vouched for, replayed and vouched for the rebuilt file.
    const rebuilt = keptFile();
    assert.equal(rebuilt.digest, rebuilt.file, "the full read rebuilt and vouched for its replay file");
    // Wall time is recorded, not asserted: at 78 statements process and verifier startup dominate, and a runner's
    // other processes (serve's own reads) shift either read (2.8 s against 5.1 s on Windows CI at 1915d5d's PR).
    readerReplay = { position: read.position, keptMs, fullMs: processes.at(-1).elapsedMs };
    const view = await settled(wallet("sync", H3, backing2), view => view.holdings.length === BULK + 1);
    assert.equal(view.available, String(7 + BULK));
  });

  await check("with the operator offline past silence, a demand and its settlement are published through the relay and read final by force; " +
      "the operator returns and adopts, and the payment the silence lapsed is proved again and final", async () => {
    // Each party keeps the package of its last sync; serve signs nothing while the chain does not move.
    for (const directory of [H3, BK, SH]) await ok(wallet("sync", directory, backing2));
    await serving.stop();
    // A payment prepared as the operator went quiet: its submission is not answered, and the record stays saved.
    const late = await request(SH, "late", 1);
    await refused(wallet("pay", H3, "late-pay", backing2, ...late.args, "--value", "1"), "UNAVAILABLE");
    assert.equal((await ok(wallet("status", H3, "late-pay"))).status, "pending");
    await advance(Number(SILENCE) + 4);
    const shown = await ok(wallet("demand", H3, "gap", backing2, "7", "--deadline", "+60"));
    assert.equal(shown.evidence, "kept");
    const file = join(scratch, "gap.json");
    const written = await ok(wallet("publish", H3, "gap", backing2, "--out", file));
    assert.equal(written.status, "written");
    await ok(["relay", "publish", "--dir", RL, file]);
    await settled(["relay", "publish", "--dir", RL, file], out => out.status === "final");
    const locked = await settled(wallet("sync", H3, backing2), view => view.holdings[0]?.status === "locked");
    assert.equal(locked.gap, true);
    assert.equal((await ok(wallet("status", H3, "gap"))).status, "final");
    const acceptance = join(scratch, "gap.acceptance");
    await ok(wallet("accept", BK, "gap-answer", backing2, shown.demand, "--deadline", String(BigInt(shown.deadline) - 10n), "--out", acceptance));
    await ok(wallet("settle", H3, "gap-settle", backing2, "--acceptance", acceptance));
    const release = join(scratch, "gap-settle.json");
    await ok(wallet("publish", H3, "gap-settle", backing2, "--out", release));
    await ok(["relay", "publish", "--dir", RL, release]);
    await settled(wallet("sync", H3, backing2), view => !view.holdings.some(h => h.value === "7"));
    assert.equal((await ok(wallet("status", H3, "gap-settle"))).status, "final");
    // The operator returns past the silence and adopts the gap's block; serve starts again.
    await ok(["operator", "return", "--dir", OW, "--id", "return-1", "--poll-ms", POLL], { mining: "waiting" });
    await ok(["operator", "adopt", "--dir", OW, "--poll-ms", POLL], { mining: "waiting" });
    serving = serve(OW);
    await serving.listening;
    for (const directory of [H3, SH]) await ok(wallet("service add", directory, backing2, join(OW, "service.json")));
    // The lapsed payment's segment is no longer canonical: proved again in the returned segment, then final.
    const reproved = await settled(wallet("reprove", H3, "late-pay", backing2), payment => payment.superseded === 1);
    assert.equal(reproved.status, "pending");
    await submit(H3, "late-pay");
    await finalOf(H3, "late-pay");
    assert.equal((await settled(wallet("fulfill", SH, "late", backing2), () => true)).value, "1");
    await serving.stop();
    // A relay refuses a file for another venue.
    const other = JSON.parse(readFileSync(release, "utf8")); other.venue = "00".repeat(32);
    const forged = join(scratch, "other-venue.json"); writeFileSync(forged, JSON.stringify(other));
    await refused(["relay", "publish", "--dir", RL, forged], "VENUE");
    const filed = JSON.parse(readFileSync(release, "utf8")); filed.subject = filed.backing = "00".repeat(32);
    const misfiled = join(scratch, "other-subject.json"); writeFileSync(misfiled, JSON.stringify(filed));
    await refused(["relay", "publish", "--dir", RL, misfiled], "SUBJECT");
  });

  await check("an interrupted venue create anchors again over a stale context; a publication past the spend budget refuses BUDGET", async () => {
    const OP2 = join(scratch, "operator-2");
    const init = await ok(["operator", "init", "--dir", OP2, ...common, "--budget", "1000"]);
    await fund(init.fundingTree, FUND);
    // A context an earlier, interrupted run kept for another anchor.
    copyFileSync(join(OP, "anchor.json"), join(OP2, "anchor.json"));
    await advance(3);
    const created = await ok(["operator", "venue", "create", "--dir", OP2, ...SYN, "--depth", DEPTH]);
    assert.notEqual(created.venue, venue);
    assert.notDeepEqual(readFileSync(join(OP2, "anchor.json")), readFileSync(join(OP, "anchor.json")));
    await advance(Number(DEPTH) + 1);
    const signed = signTerms("terms-2", init.operator, created.venue);
    const over = await refused(["operator", "open", "--dir", OP2, "--id", "genesis", signed.backing, "--terms", signed.terms, "--signature", signed.signature,
      ...SYN], "BUDGET");
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

  await check("from the packed install, no process that proves nothing loads a @noir-lang module; proving ones do", async () => {
    const PROVING = new Set(["wallet pay", "wallet freshen", "wallet reprove", "wallet issue", "wallet demand", "wallet settle", "wallet burn"]);
    const ended = processes.filter(p => p.noir !== null);
    assert(ended.length > 0 && ended.some(p => PROVING.has(p.command) && p.status === 0));
    for (const p of ended) {
      if (p.command.startsWith("reader ") || p.command.startsWith("relay ") || p.command.startsWith("operator ") ||
          (p.command.startsWith("wallet ") && !PROVING.has(p.command))) assert.equal(p.noir, false, `${p.command} loaded @noir-lang`);
      else if (p.status === 0) assert.equal(p.noir, true, `${p.command} proved without the witness generator?`);
    }
  });

  const result = { status: "passed", package: { tarballBytes: packed.tarballBytes, files: packed.files, consumerLockSha256: packed.consumerLock }, checks, readerReplay, processes };
  if (LIVE) {
    const directories = await sweep(), file = JSON.parse(readFileSync(join(OP, "venue.json"), "utf8"));
    assert.deepEqual(sourceHashes(SOURCES), HASHES, "sources changed during the live drill");
    const report = { status: "passed", specification: V3_SPECIFICATION, evidence: "live-testnet-commands-real-proofs",
      live: { endpoint: NODE_URL, venue, context: file.context, anchorHeight: file.anchorHeight, depth: file.depth, silence: String(SILENCE),
        tipHeight: String(await liveHeight()), funding: transfers, fundingDirectories: directories },
      ...result, elapsedMs: Math.round(performance.now() - started), sourceSha256Lf: HASHES };
    writeFileSync(join(root, "docs", "pool-v3-command-testnet-verification.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
  completed = true;
} finally {
  for (const child of servers) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(done => child.once("close", done)); child.kill("SIGTERM"); await exited;
  }
  if (LIVE && !sweptAll) await sweep().catch(error => process.stderr.write(`sweep failed (keys kept in ${scratch}): ${error.message}\n`));
  await node?.close();
  if (completed) { assert(scratch.startsWith(realpathSync(join(root, "scratch")) + sep)); rmSync(scratch, { recursive: true, force: true }); }
  else process.stderr.write(`command drill scratch retained after failure: ${scratch}\n`);
}
