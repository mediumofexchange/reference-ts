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
//
// Usage: node scripts/pool/v3/command-drill.mjs  (after npm run build and scripts/pool/prepare-crs.mjs)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { openView, parseVenue } from "../../../dist/cli/venue.js";
import { readParameters } from "../../../dist/pool/parameter-files.js";
import { startBackend } from "../../../dist/pool/proof-verifier.js";
import { prepareExactOutput } from "../../../dist/pool/v3/capsules.js";
import { openV3Prover } from "../../../dist/pool/v3/prover.js";
import { V3Wallet } from "../../../dist/pool/v3/wallet-store.js";
import { adoptedDomain } from "../../../dist/pool/v3/configuration.js";
import { V3ServiceClient } from "../../../dist/pool/v3/service-client.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../../../dist/pool/v3/terms.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";
import { serveSyntheticNode } from "./synthetic-node.mjs";

const root = resolve(import.meta.dirname, "../../.."), RSS_HOOK = new URL("./rss-hook.mjs", import.meta.url).href;
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
  return { bin, tarballBytes: statSync(join(scratch, packed.filename)).size, files: packed.entryCount };
}
const packed = installPacked(), MOE = packed.bin;
const check = async (label, fn) => { await fn(); checks.push(label); process.stderr.write(`passed: ${label}\n`); };

const node = await serveSyntheticNode();
const call = async (path, body) => {
  const response = await fetch(`${node.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const mine = count => call("/synthetic/mine", { count });

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
      if (mining !== "waiting") return;
      const seen = Buffer.concat(err).toString().split("\n").filter(line => line.includes('"event":"waiting"')).length;
      for (; waits < seen; waits++) mine(1).catch(() => {});
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
  const child = spawn(process.execPath, ["--import", RSS_HOOK, MOE, "operator", "serve", "--dir", directory, "--interval", "2", "--poll-ms", "100"],
    { cwd: scratch, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MOE_DRILL_RSS: rss } });
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
    await mine(1); await new Promise(done => setTimeout(done, 150));
  }
  assert.fail("the condition did not hold within the blocks mined");
}

let completed = false;
try {
  const OP = join(scratch, "operator"), RD = join(scratch, "reader"), common = ["--node", node.url, "--parameters", PARAMETER_DIRECTORY];
  await mine(Number(DEPTH) + 2);

  let operatorKey, fundingTree, venue, backing, termsFile, signatureFile;
  await check("operator init, funding, synthetic venue create (rerun prints the same file, refuses other flags)", async () => {
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
    // A rerun asking for another context or depth than the file's is refused, not answered "existing".
    await refused(["operator", "venue", "create", "--dir", OP, "--depth", DEPTH], "VENUE");
    await refused(["operator", "venue", "create", "--dir", OP, "--synthetic", "--depth", String(Number(DEPTH) + 1)], "VENUE");
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
  /** A reader command whose kept replay file fails its digest, so it is discarded and the read replays in full. */
  const full = args => { writeFileSync(join(RD, "replay.db.sha256"), "00".repeat(32)); return ok(args); };
  /** Serve publishes on its own poll after it commits: mine past the depth and read until `until` holds, a few
   * rounds at most, so the drill does not race serve's publication on a slow runner. */
  const supplyUntil = async (until, rounds = 8, which = backing) => {
    for (let round = 0; ; round++) {
      await mine(Number(DEPTH) + 2); await new Promise(done => setTimeout(done, 400));
      const read = await ok(["reader", "supply", ...reader, which]);
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
  await check("operator serve listens, publishes and keeps the checkpoint alive within silence less the lag; a second command refuses BUSY", async () => {
    const listening = await served.listening;
    assert.equal(listening.status, "serving"); assert.equal(listening.silence, String(SILENCE));
    await refused(["operator", "open", "--dir", OP, "--id", "genesis", backing, "--terms", termsFile, "--signature", signatureFile, "--synthetic"], "BUSY");
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
    assert.deepEqual({ ...offline, sync: undefined }, { ...viaService, sync: undefined });
    assert.equal((await moe(["reader", "supply", ...reader, backing, "--verifiers", "7"])).status, 2);
  });

  await check("past the terms' silence the operator returns and adopts, then serves again", async () => {
    await mine(Number(SILENCE) + 4);
    const returned = await ok(["operator", "return", "--dir", OP, "--id", "return-1", "--poll-ms", "100"], { mining: "waiting" });
    assert.equal(returned.status, "pending");
    const adopted = await ok(["operator", "adopt", "--dir", OP, "--poll-ms", "100"], { mining: "waiting" });
    assert.deepEqual([adopted.status, adopted.receipts], ["final", []]);
    await refused(["reader", "supply", ...reader, backing], "UNAVAILABLE");
    const again = serve(OP);
    await again.listening;
    await ok(["reader", "service", "add", ...reader, backing, join(OP, "service.json")]);
    const after = await supplyUntil(read => BigInt(read.checkpoint.sequence) >= BigInt(returned.commitment.sequence));
    assert.equal(after.supply, "0");
    // Kept across the return's new term: a read replaying in full at the same index answers the same.
    assert.deepEqual({ ...(await full(["reader", "supply", ...reader, backing])), sync: undefined }, { ...after, sync: undefined });
    await again.stop();
  });

  // The wallet and relay commands (M10c2b): a backer's terms on the operator's venue, holders' wallets, a relay.
  const OW = join(scratch, "operator-wallets"), BK = join(scratch, "backer"), HD = join(scratch, "holder"), SH = join(scratch, "shop"), RL = join(scratch, "relay");
  const wallet = (verb, directory, ...rest) => ["wallet", ...verb.split(" "), "--dir", directory, ...rest];
  let backing2, serving, walletOperator;
  /** Mine and rerun `args` until it exits 0 and `until` holds of its output, a few rounds at most. */
  const settled = async (args, until, rounds = 12) => {
    for (let round = 0; ; round++) {
      await mine(Number(DEPTH) + 2); await new Promise(done => setTimeout(done, 400));
      const result = await moe(args);
      if (result.status === 0 && until(result.json)) return result.json;
      assert(round < rounds, `moe ${args.join(" ")} did not settle: ${result.stdout}${result.stderr}`);
    }
  };
  /** Mine, sync and read the saved record under `alias` until it is final: sync resolves saved records. */
  const finalOf = async (directory, alias, rounds = 12) => {
    for (let round = 0; ; round++) {
      await mine(Number(DEPTH) + 2); await new Promise(done => setTimeout(done, 400));
      await ok(wallet("sync", directory, backing2));
      const saved = await ok(wallet("status", directory, alias));
      if (saved.status === "final") return saved;
      assert(round < rounds, `${alias} did not become final: ${JSON.stringify(saved)}`);
    }
  };
  /** A submission, retried while serve waits out its reopening lag (C2.8.2) and refuses SCHEDULE. */
  const submit = async (directory, alias) => {
    for (let round = 0; ; round++) {
      const result = await moe(wallet("submit", directory, alias, backing2));
      if (result.status === 0) return result.json;
      assert(round < 12 && result.refusal?.code === "SCHEDULE", `moe wallet submit ${alias}: ${result.stderr}`);
      await mine(1); await new Promise(done => setTimeout(done, 300));
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
    const operator = await ok(["operator", "init", "--dir", OW, "--venue", join(OP, "venue.json"), ...common, "--budget", "50000000"]);
    await call("/synthetic/fund", { tree: operator.fundingTree, value: "1000000000" });
    walletOperator = operator.operator;
    const init = await ok(wallet("init", BK, "--backer", "--venue", join(OP, "venue.json"), ...common));
    assert.match(init.backer, /^[0-9a-f]{64}$/);
    await refused(wallet("terms create", HD), "ABSENT");
    const created = await ok(wallet("terms create", BK, "--operator", operator.operator, "--thing", "drill units", "--per-unit", "1", "--interval", "80",
      "--silence", String(SILENCE), "--challenge", "5"));
    backing2 = created.backing;
    await ok(["operator", "open", "--dir", OW, "--id", "genesis", backing2, "--terms", created.terms, "--signature", created.signature, "--synthetic"]);
    for (const directory of [HD, SH]) {
      await ok(wallet("init", directory, "--venue", join(OP, "venue.json"), ...common));
      await refused(wallet("issue", directory, "x", backing2), "ABSENT");
      const added = await ok(wallet("terms add", directory, backing2, "--terms", created.terms, "--signature", created.signature, "--synthetic"));
      assert.equal(added.obligor, init.backer);
    }
    // A backer's venue create makes the wallet database in the run that creates the venue; a rerun over a lost one
    // refuses rather than making a fresh seed.
    const BK2 = join(scratch, "backer-2");
    await ok(wallet("init", BK2, "--backer", ...common));
    await ok(wallet("venue create", BK2, "--synthetic", "--depth", DEPTH));
    assert.equal((await ok(wallet("venue create", BK2, "--synthetic", "--depth", DEPTH))).status, "existing");
    for (const file of readdirSync(BK2).filter(name => name.startsWith("wallet.db"))) rmSync(join(BK2, file));
    await refused(wallet("venue create", BK2, "--synthetic", "--depth", DEPTH), "ABSENT");
    // A holder's wallet holds no K: the backer's commands refuse it.
    await refused(wallet("burn", HD, "x", backing2, "1"), "ROLE");
    const relay = await ok(["relay", "init", "--dir", RL, "--venue", join(OP, "venue.json"), ...common, "--budget", "50000000"]);
    await call("/synthetic/fund", { tree: relay.fundingTree, value: "1000000000" });
    await mine(Number(DEPTH) + 2);
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
    await ok(["reader", "terms", "add", ...reader, backing2, "--terms", join(BK, "terms", backing2), "--signature", join(BK, "terms", `${backing2}.sig`), "--synthetic"]);
    await ok(["reader", "service", "add", ...reader, backing2, join(OW, "service.json")]);
    const read = await supplyUntil(read => read.burned === "3", 8, backing2);
    assert.deepEqual([read.issued, read.burned, read.supply], ["10", "3", "7"]);
    // The reader's C3.8 reading of the settled demand, on its kept file and replayed in full at the same index.
    const presented = await ok(["reader", "presentation", ...reader, backing2, demanded.demand]);
    assert.deepEqual([presented.status, presented.ended.by, presented.acceptances.length], ["final", "settlement", 1]);
    assert.deepEqual({ ...(await full(["reader", "presentation", ...reader, backing2, demanded.demand])), sync: undefined }, { ...presented, sync: undefined });
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
    await ok(wallet("terms add", H2, backing2, "--terms", join(BK, "terms", backing2), "--signature", join(BK, "terms", `${backing2}.sig`), "--synthetic"));
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
    await ok(wallet("terms add", H3, backing2, "--terms", join(BK, "terms", backing2), "--signature", join(BK, "terms", `${backing2}.sig`), "--synthetic"));
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

  const BULK = 70;
  let readerReplay;
  await check(`past the old 67-statement ceiling: ${BULK} real-proof issues to the holder's seed, synced by the holder and the reader; ` +
      "the reader's next process rests on its kept replay file, and one whose file fails its digest replays in full to the same answer", async () => {
    const { seed } = await ok(wallet("seed", H3, "--show"));
    await bulkIssue(BULK, Buffer.from(seed, "hex"));
    const read = await supplyUntil(read => read.issued === String(10 + BULK), 12, backing2);
    assert(BigInt(read.position) > 67n, `position ${read.position}`);
    // Nothing is mined between these reads, so each judges at the same index (item (w), M11b6).
    const same = answer => assert.deepEqual({ ...answer, sync: undefined }, { ...read, sync: undefined });
    for (const file of ["replay.db", "replay.db.sha256"]) assert(statSync(join(RD, file)).isFile(), `the reader keeps ${file}`);
    same(await ok(["reader", "supply", ...reader, backing2]));
    const keptMs = processes.at(-1).elapsedMs;
    same(await full(["reader", "supply", ...reader, backing2]));
    readerReplay = { position: read.position, keptMs, fullMs: processes.at(-1).elapsedMs };
    // The full replay verifies every statement's proof again, the kept read none (2.8 s against 5.4 s locally at 78).
    assert(readerReplay.keptMs < readerReplay.fullMs, `the kept read was not faster: ${JSON.stringify(readerReplay)}`);
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
    await mine(Number(SILENCE) + 4);
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
    await ok(["operator", "return", "--dir", OW, "--id", "return-1", "--poll-ms", "100"], { mining: "waiting" });
    await ok(["operator", "adopt", "--dir", OW, "--poll-ms", "100"], { mining: "waiting" });
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

  console.log(JSON.stringify({ status: "passed", package: { tarballBytes: packed.tarballBytes, files: packed.files }, checks, readerReplay, processes }, null, 2));
  completed = true;
} finally {
  await node.close();
  if (completed) { assert(scratch.startsWith(realpathSync(join(root, "scratch")) + sep)); rmSync(scratch, { recursive: true, force: true }); }
  else process.stderr.write(`command drill scratch retained after failure: ${scratch}\n`);
}
