// Slice 38 (succinct-read §§2–3, Next 12 step 4): holders and a reader reading succinctly through the `moe` commands,
// with real proofs, on the synthetic Ergo node. An operator serves a backing whose backer issues two notes to a complete
// holder; a replica (`reader serve --prove`) proves check proofs over its kept trail under the shipped check set (a
// test set), natively where bb.js bundles a native backend and on WebAssembly elsewhere (slice 42); a holder restored from the same seed with `--read succinct` syncs and reads the same holdings from the
// covers, fetching no proof; it pays a succinct shop, which fulfills, reading the tail natively; a succinct reader's
// supply equals a complete reader's. A succinct directory serves no replica (SUCCINCT), and no process that proves
// nothing loads `@noir-lang`. The replica also proves the venue's exhaustion (`--prove-exhaustion`, succinct-read §4,
// slice 43) under the circuit set the package ships (a test set), natively where bb.js bundles a native backend: each
// succinct directory's view reads its backing's subjects below the replica's fold, no section there, and sections
// natively above it; restarted without proving, the replica serves its kept fold again. A second replica that proves
// nothing, keeping the first, takes its fold and serves it; the succinct reader reads only through it. Where the host has no native
// backend (Windows), `--prove-exhaustion` is refused (PROVER) and the views read every section. The commands run from
// the build (`dist/cli/moe.js`); the release's own install drill is command-drill.mjs.
//
// Usage: [NARGO=<nargo 1.0.0-beta.26>] node scripts/pool/v3/succinct-drill.mjs   (after npm run build and
// scripts/pool/prepare-crs.mjs). The replica compiles the exhaustion circuits once with NARGO (about ten minutes),
// unless scratch/exhaustion-programs holds them from an earlier run, where the drill keeps them after.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { prepareCheckSetParameters, prepareExhaustionParameters } from "../../../dist/pool/parameter-files.js";
import { nativeRefusal } from "../../../dist/pool/proof-verifier.js";
import { PARAMETER_DIRECTORY } from "../prepare-crs.mjs";
import { serveSyntheticNode } from "./synthetic-node.mjs";

const root = resolve(import.meta.dirname, "../../.."), MOE = join(root, "dist", "cli", "moe.js");
const RSS_HOOK = new URL("./rss-hook.mjs", import.meta.url).href, DEPTH = "2", SILENCE = "40", BUDGET = "50000000", FUND = 1_000_000_000n;
const started = performance.now(), checks = [], processes = [], children = [];
/** Where the replica's compiled exhaustion programs are kept between runs (CI caches it). */
const PROGRAMS = join(root, "scratch", "exhaustion-programs"), native = nativeRefusal() === undefined;
const copyPrograms = (from, to) => {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  // Each circuit's kept crate (its sources and nargo's compiled program, which its witnesses reuse).
  // Each replaces what was there: a file left from another layout would make nargo compile again at a witness.
  for (const name of readdirSync(from).filter(n => /^[a-z-]+$/.test(n))) {
    rmSync(join(to, name), { recursive: true, force: true });
    cpSync(join(from, name), join(to, name), { recursive: true });
  }
};
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "succinct-drill-")));
const pause = ms => new Promise(done => setTimeout(done, ms));
const check = async (label, fn) => { const began = performance.now(); await fn(); checks.push({ label, seconds: Number(((performance.now() - began) / 1000).toFixed(1)) });
  process.stderr.write(`passed: ${label}\n`); };

const node = await serveSyntheticNode();
const call = async (path, body) => {
  const response = await fetch(`${node.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const advance = count => call("/synthetic/mine", { count });
const nextRound = async () => { await advance(Number(DEPTH) + 2); await pause(400); };

/** One `moe` process: exit code, stdout's last JSON line, stderr, and whether it loaded `@noir-lang`. */
function moe(args, { input, env = {} } = {}) {
  return new Promise((done, failed) => {
    const rss = join(scratch, `rss-${processes.length}-${process.hrtime.bigint()}.json`), began = performance.now();
    const child = spawn(process.execPath, ["--import", RSS_HOOK, MOE, ...args], { cwd: root, windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, ...env, MOE_DRILL_RSS: rss } });
    if (input !== undefined) child.stdin.end(input);
    const out = [], err = [];
    child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk));
    child.on("error", failed);
    child.on("close", status => {
      const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
      let maxRssKb = null, noir = null;
      try { ({ maxRssKb, noir } = JSON.parse(readFileSync(rss, "utf8"))); rmSync(rss); } catch { /* died before its exit handler */ }
      processes.push({ command: args.slice(0, 2).join(" "), status, elapsedMs: Math.round(performance.now() - began), maxRssKb, noir });
      let json, refusal;
      try { json = stdout.trim() === "" ? undefined : JSON.parse(stdout.trim().split("\n").at(-1)); } catch { json = undefined; }
      try { refusal = status === 1 ? JSON.parse(stderr.trim().split("\n").at(-1)) : undefined; } catch { refusal = undefined; }
      done({ status, json, stdout, stderr, refusal, noir });
    });
  });
}
const ok = async (args, options) => {
  const result = await moe(args, options);
  assert.equal(result.status, 0, `moe ${args.join(" ")}: ${result.stderr}`);
  return result.json;
};
const refused = async (args, code, options) => {
  const result = await moe(args, options);
  assert.equal(result.status, 1, `moe ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  assert.equal(result.refusal?.code, code, result.stderr);
};
/** A background `moe` (serve): each stdout line as JSON, a wait for a line, and a stop. */
function background(args) {
  const child = spawn(process.execPath, [MOE, ...args], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const lines = [], waiters = [];
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
    for (let at; (at = stdout.indexOf("\n")) >= 0; stdout = stdout.slice(at + 1)) {
      lines.push(JSON.parse(stdout.slice(0, at)));
      for (const waiter of [...waiters]) if (waiter.until(lines.at(-1))) { waiters.splice(waiters.indexOf(waiter), 1); waiter.done(lines.at(-1)); }
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(done => child.on("close", status => done(status)));
  return {
    lines, log: () => stderr,
    /** The first line, past or future, `until` holds of, within `ms`. */
    line(until, ms) {
      const seen = lines.find(until);
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise((done, failed) => {
        const timer = setTimeout(() => failed(new Error(`moe ${args.slice(0, 2).join(" ")}: no line within ${ms} ms: ${stderr.slice(-2000)}`)), ms);
        waiters.push({ until, done: line => { clearTimeout(timer); done(line); } });
        exited.then(status => { clearTimeout(timer); failed(new Error(`moe ${args.slice(0, 2).join(" ")} exited ${status}: ${stderr.slice(-2000)}`)); });
      });
    },
    async stop() { child.kill("SIGTERM"); await exited; },
  };
}

let completed = false;
try {
  const OP = join(scratch, "operator"), BK = join(scratch, "backer"), HD = join(scratch, "holder"), RP = join(scratch, "replica");
  const HS = join(scratch, "holder-succinct"), SS = join(scratch, "shop-succinct"), RC = join(scratch, "reader"), RS = join(scratch, "reader-succinct");
  const common = ["--node", node.url, "--parameters", PARAMETER_DIRECTORY], SYN = ["--synthetic"];
  const wallet = (verb, directory, ...rest) => ["wallet", ...verb.split(" "), "--dir", directory, ...rest];
  const holdings = view => view.holdings.map(h => [h.value, h.status, h.presented.length]).sort();
  await advance(Number(DEPTH) + 2);

  let backing, terms, signature, operatorUrl;
  await check("an operator serves a backer's backing; a complete holder and reader keep its terms", async () => {
    const operator = await ok(["operator", "init", "--dir", OP, ...common, "--budget", BUDGET]);
    await call("/synthetic/fund", { tree: operator.fundingTree, value: String(FUND) });
    await ok(["operator", "venue", "create", "--dir", OP, ...SYN, "--depth", DEPTH]);
    await advance(Number(DEPTH) + 1);
    await ok(wallet("init", BK, "--backer", "--venue", join(OP, "venue.json"), ...common));
    const created = await ok(wallet("terms create", BK, "--operator", operator.operator, "--thing", "drill units", "--per-unit", "1", "--interval", "80",
      "--silence", SILENCE, "--challenge", "5"));
    ({ backing, terms, signature } = { backing: created.backing, terms: created.terms, signature: created.signature });
    await ok(["operator", "open", "--dir", OP, "--id", "genesis", backing, "--terms", terms, "--signature", signature, ...SYN]);
    await advance(Number(DEPTH) + 2);
    await ok(wallet("init", HD, "--venue", join(OP, "venue.json"), ...common));
    await ok(["reader", "init", "--dir", RC, "--venue", join(OP, "venue.json"), ...common]);
    await ok(["reader", "init", "--dir", RP, "--venue", join(OP, "venue.json"), ...common]);
    for (const directory of [HD]) await ok(wallet("terms add", directory, backing, "--terms", terms, "--signature", signature, ...SYN));
    for (const directory of [RC, RP]) await ok(["reader", "terms", "add", "--dir", directory, backing, "--terms", terms, "--signature", signature, ...SYN]);
  });

  const serving = background(["operator", "serve", "--dir", OP, "--interval", "2", "--poll-ms", "100"]);
  operatorUrl = (await serving.line(line => line.status === "serving", 120_000)).url;
  void operatorUrl;
  const finalOf = async (directory, alias, rounds = 24) => {
    for (let round = 0; ; round++) {
      await nextRound();
      await ok(wallet("sync", directory, backing));
      if ((await ok(wallet("status", directory, alias))).status === "final") return;
      assert(round < rounds, `${alias} did not become final`);
    }
  };
  const submit = async (directory, alias) => {
    for (let round = 0; ; round++) {
      const result = await moe(wallet("submit", directory, alias, backing));
      if (result.status === 0) return result.json;
      assert(round < 12 && result.refusal?.code === "SCHEDULE", `moe wallet submit ${alias}: ${result.stderr}`);
      await advance(1); await pause(300);
    }
  };
  const request = async (directory, alias, value) => {
    const out = join(scratch, `${alias}.request`), made = await ok(wallet("request", directory, alias, backing, String(value), "--out", out));
    return ["--request", out, "--digest", made.digest];
  };

  await check("the backer issues two notes to the complete holder, final by sync", async () => {
    for (const directory of [BK, HD]) await ok(wallet("service add", directory, backing, join(OP, "service.json")));
    for (const directory of [RC, RP]) await ok(["reader", "service", "add", "--dir", directory, backing, join(OP, "service.json")]);
    for (const [alias, value] of [["issue-1", 10], ["issue-2", 4]]) {
      await ok(wallet("issue", BK, alias, backing, ...await request(HD, `fund-${alias}`, value), "--value", String(value)));
      await submit(BK, alias);
      await finalOf(BK, alias);
    }
    assert.deepEqual(holdings(await ok(wallet("sync", HD, backing))), [["10", "available", 0], ["4", "available", 0]]);
  });

  let replica, provedLines = [], folds = [], periods = [];
  await check("a replica proves covers over its kept trail (reader serve --prove); a succinct directory serves none", async () => {
    // The check set's parameters, the leading 2^21 points, in the checks' shared parameter directory.
    await prepareCheckSetParameters(PARAMETER_DIRECTORY, { log: line => process.stderr.write(`${line}\n`) });
    // --prover names a backend for --prove only, native or wasm; native where the host has none is refused by name.
    for (const args of [["--prover", "wasm"], ["--prove", "--prover", "gpu"]]) {
      const usage = await moe(["reader", "serve", "--dir", RP, ...args]);
      assert.equal(usage.status, 2, usage.stderr);
    }
    const refusal = nativeRefusal();
    if (refusal !== undefined) await refused(["reader", "serve", "--dir", RP, "--prove", "--prover", "native"], "PROVER");
    // Anywhere, natively on a binary other than the package's.
    await refused(["reader", "serve", "--dir", RP, "--prove", "--prover", "native"], "PROVER", { env: { BB_BINARY_PATH: process.execPath } });
    // --nargo goes with --prove-exhaustion only; the exhaustion is proved natively only.
    assert.equal((await moe(["reader", "serve", "--dir", RP, "--nargo", "nargo"])).status, 2);
    if (!native) await refused(["reader", "serve", "--dir", RP, "--prove-exhaustion"], "PROVER");
    // The exhaustion's parameters, the leading 2^22 points, in the same directory (one copy serves both sets).
    if (native) await prepareExhaustionParameters(PARAMETER_DIRECTORY, { log: line => process.stderr.write(`${line}\n`) });
    copyPrograms(PROGRAMS, join(RP, "exhaustion-circuits"));
    replica = background(["reader", "serve", "--dir", RP, "--poll-ms", "500", "--prove", "--parameters", PARAMETER_DIRECTORY,
      ...(native ? ["--prove-exhaustion", ...(process.env.NARGO ? ["--nargo", process.env.NARGO] : [])] : [])]);
    const serving = await replica.line(line => line.status === "serving", 1_800_000);
    assert.equal(serving.exhaustion.proving, native);
    copyPrograms(join(RP, "exhaustion-circuits"), PROGRAMS);
    // Two issues: two leaves and their node, proved once the replica's read serves the selection holding them (`proved`
    // counts the proved records its walk has read, `made` the covers it made). Within the CI job's 30 minutes.
    const proved = await replica.line(line => line.status === "proved" && Number(line.proved) >= 2, 1_200_000);
    assert.equal(Number(proved.made), 3);
    // A fold of the venue through the issues' indices, proved while the covers waited (one proof at a time).
    if (native) {
      const fold = await replica.line(line => line.status === "exhaustion" && line.how === "proved", 1_200_000);
      assert.equal(fold.set, serving.exhaustion.set);
    }
    assert.equal(proved.testSet, true);
    assert.equal(proved.backend, refusal === undefined ? "native" : "wasm");
    await ok(["reader", "init", "--dir", RS, "--read", "succinct", "--venue", join(OP, "venue.json"), ...common]);
    await refused(["reader", "serve", "--dir", RS], "SUCCINCT");
    const lit = await moe(["reader", "init", "--dir", join(scratch, "lit"), "--read", "succinct", "--construction", "moe/lit/v1", "--venue", join(OP, "venue.json"), ...common]);
    assert.equal(lit.status, 2, lit.stderr);
  });

  const replicaUrl = JSON.parse(readFileSync(join(RP, "replica.json"), "utf8")).url;
  await check("a holder restored from the seed with --read succinct reads the same holdings from covers, fetching no proof", async () => {
    const { seed } = await ok(wallet("seed", HD, "--show"));
    const restored = await ok(["wallet", "restore-seed", "--dir", HS, "--read", "succinct", "--venue", join(OP, "venue.json"), ...common], { input: `${seed}\n` });
    assert.equal(restored.read, "succinct");
    await ok(wallet("terms add", HS, backing, "--terms", terms, "--signature", signature, ...SYN));
    await ok(wallet("service add", HS, backing, join(OP, "service.json")));
    await ok(wallet("replica add", HS, backing, replicaUrl));
    const complete = await ok(wallet("sync", HD, backing)), view = await moe(wallet("sync", HS, backing));
    assert.equal(view.status, 0, view.stderr);
    assert.deepEqual(holdings(view.json), holdings(complete));
    assert.deepEqual(view.json.checkpoint, complete.checkpoint);
    assert.equal(view.json.read.judgment, "succinct"); assert.equal(view.json.read.testSet, true);
    assert(Number(view.json.read.coversTaken) >= 1, JSON.stringify(view.json.read));
    assert.equal(view.json.read.proofsFetched, 0);
    assert.equal(view.noir, false, "a succinct read loads no prover");
    // The venue below the replica's fold was read succinctly under the set the replica serves: the backing, its
    // operator and its obligor followed.
    const set = replica.lines.find(line => line.status === "serving").exhaustion.set;
    assert.equal(view.json.read.venue.exhaustionSet, set);
    assert.equal(view.json.read.venue.followed, 3);
    // Below a proved fold where the host proves one; every section natively where it cannot.
    if (native) assert(Number(view.json.read.venue.succinctIndices) >= 1, JSON.stringify(view.json.read.venue));
    else assert.equal(Number(view.json.read.venue.succinctIndices), 0, JSON.stringify(view.json.read.venue));
  });

  await check("the succinct holder pays a succinct shop, which fulfills over the tail's fetched proof", async () => {
    // The replica serves on without proving, so the payment is the tail no cover reaches: its proof is fetched.
    provedLines = replica.lines.filter(line => line.status === "proved");
    // The folds it proved, and each period's proving as the pool logged it: each proof's witness and proof seconds, then
    // the period's leaves, nodes and seconds.
    folds = replica.lines.filter(line => line.status === "exhaustion");
    periods = replica.log().split("\n").filter(line => /^period to \d+: /.test(line));
    await replica.stop();
    const lastFold = replica.lines.filter(line => line.status === "exhaustion").at(-1);
    replica = background(["reader", "serve", "--dir", RP, "--poll-ms", "500", "--port", new URL(replicaUrl).port]);
    assert.equal((await replica.line(line => line.status === "serving", 300_000)).exhaustion.proving, false);
    // Without proving, the replica serves the fold it kept, verified and checked against its map again.
    if (native) assert.equal((await replica.line(line => line.status === "exhaustion", 300_000)).foldIndex, lastFold.foldIndex);
    await ok(wallet("init", SS, "--read", "succinct", "--venue", join(OP, "venue.json"), ...common));
    await ok(wallet("terms add", SS, backing, "--terms", terms, "--signature", signature, ...SYN));
    await ok(wallet("service add", SS, backing, join(OP, "service.json")));
    await ok(wallet("replica add", SS, backing, replicaUrl));
    const paid = await ok(wallet("pay", HS, "pay-1", backing, ...await request(SS, "invoice", 3), "--value", "3"));
    assert.equal(paid.kind, "payment");
    let fulfilled;
    for (let round = 0; ; round++) {
      await nextRound();
      const result = await moe(wallet("fulfill", SS, "invoice", backing));
      if (result.status === 0) { fulfilled = result.json; break; }
      assert(round < 24, `the shop did not fulfill: ${result.stdout}${result.stderr}`);
    }
    assert.deepEqual([fulfilled.status, fulfilled.value, fulfilled.read.judgment], ["final", "3", "succinct"]);
    // Its earlier tries read and kept the covered issues (pool-v3 §14), so this read asks about the payment alone.
    assert(Number(fulfilled.read.proofsFetched) >= 1, JSON.stringify(fulfilled.read));
    await finalOf(HS, "pay-1");
    // 10 + 4 held, 3 paid: whichever note the payment spent, 11 remain available.
    const after = await ok(wallet("sync", HS, backing));
    assert.equal(after.available, "11");
    assert.equal(after.read.judgment, "succinct");
    assert.equal(Number(after.read.venue.succinctIndices) >= 1, native, JSON.stringify(after.read.venue));
  });

  let taken = [];
  await check("a second replica that proves nothing takes the first's fold; a succinct reader of it alone reads the supply a complete reader does, and reads it natively once it drops the set", async () => {
    const complete = await ok(["reader", "supply", "--dir", RC, backing]);
    // The complete reader becomes a replica keeping the first one: it takes the fold the first proved, checked against
    // its own view's map, and serves it.
    await ok(["reader", "replica", "add", "--dir", RC, backing, replicaUrl]);
    const second = background(["reader", "serve", "--dir", RC, "--poll-ms", "500"]);
    try {
      assert.equal((await second.line(line => line.status === "serving", 300_000)).exhaustion.proving, false);
      if (native) {
        const fold = await second.line(line => line.status === "exhaustion" && line.how === "taken", 300_000);
        assert.equal(fold.from, new URL(replicaUrl).href);
        assert(Number(fold.foldIndex) >= 0, JSON.stringify(fold));
      }
      taken = second.lines.filter(line => line.status === "exhaustion");
      const secondUrl = JSON.parse(readFileSync(join(RC, "replica.json"), "utf8")).url;
      await ok(["reader", "terms", "add", "--dir", RS, backing, "--terms", terms, "--signature", signature, ...SYN]);
      await ok(["reader", "service", "add", "--dir", RS, backing, join(OP, "service.json")]);
      await ok(["reader", "replica", "add", "--dir", RS, backing, secondUrl]);
      const read = await moe(["reader", "supply", "--dir", RS, backing]);
      assert.equal(read.status, 0, read.stderr);
      const same = value => ({ issued: value.issued, burned: value.burned, supply: value.supply, checkpoint: value.checkpoint, judgingIndex: value.judgingIndex });
      assert.deepEqual(same(read.json), same(complete));
      assert.equal(read.json.read.judgment, "succinct");
      assert.equal(Number(read.json.read.venue.succinctIndices) >= 1, native, JSON.stringify(read.json.read.venue));
      assert.equal(read.noir, false);
      // A set the directory dropped (succinct-read §2 rule 7) serves no read: the next reads its trail's proofs and its
      // venue's sections natively, to the same supply, and its output names no succinct judgment.
      writeFileSync(join(RS, "exhaustion.json"), `${JSON.stringify({ dropped: [read.json.read.set] })}\n`);
      const dropped = await moe(["reader", "supply", "--dir", RS, backing]);
      assert.equal(dropped.status, 0, dropped.stderr);
      assert.deepEqual(same(dropped.json), same(complete));
      assert.equal(dropped.json.read, undefined, JSON.stringify(dropped.json.read));
    } finally { await second.stop(); }
  });

  await replica.stop(); await serving.stop();
  const report = { status: "passed", checks, processes, proved: provedLines, exhaustion: { native, folds, periods, taken },
    elapsedMs: Math.round(performance.now() - started) };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  completed = true;
} finally {
  for (const child of children) child.kill("SIGTERM");
  await node.close?.();
  if (completed) { assert(scratch.startsWith(realpathSync(join(root, "scratch")) + sep)); rmSync(scratch, { recursive: true, force: true }); }
  else process.stderr.write(`succinct drill scratch retained after failure: ${scratch}\n`);
}
