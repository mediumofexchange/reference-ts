// The wallet's flows in a browser engine (slice 41, check.mjs --wallet): a holder's `moe wallet` commands run in the
// page's command workers (src/browser/wallet.html, src/browser/command.ts) over the origin's file pool, with real
// proofs, against parties that run `moe` as processes here: the synthetic Ergo node, an operator serving a backer's
// terms, the backer issuing, and a shop selling. The holder creates its wallet from the venue file, keeps the terms and
// the service file, asks the backer for funds (request), receives them (fulfill, sync), pays the shop (pay, proved in
// the browser), and restores from its seed alone into a new directory that finds the same holdings; the shop fulfills
// the holder's payment. Refusals keep their names in the browser (a substituted request, a second command on the pool
// while one holds it, an exact retry's replay), and the files a command writes are read back from the pool.
//
// `command(request)` runs one command in the page (`moeCommand`); `route(port)` lets the page's worker reach a loopback
// port through the check's server (wallet-worker.mjs). Requires `npm run build` (dist/) and the proving parameters.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveSyntheticNode } from "../pool/v3/synthetic-node.mjs";

const DEPTH = "2", SILENCE = "16", BUDGET = "50000000", FUND = 1_000_000_000n;
const pause = ms => new Promise(done => setTimeout(done, ms));

export async function drill({ command, route, log, parameters, root }) {
  const scratch = realpathSync(mkdtempSync(join(root, "scratch", "wallet-drill-")));
  const moeBin = join(root, "dist/cli/moe.js"), checks = [], commands = [], servers = [];
  const node = await serveSyntheticNode(), nodeUrl = node.url;
  route(Number(new URL(nodeUrl).port));
  const call = async (path, body) => {
    const response = await fetch(`${nodeUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const advance = count => call("/synthetic/mine", { count });
  const nextRound = async () => { await advance(Number(DEPTH) + 2); await pause(400); };
  const check = async (label, fn) => { const began = Date.now(); await fn(); checks.push({ label, ms: Date.now() - began }); log(`passed: ${label}`); };

  /** `moe` as a process here (the holder's counterparties). */
  const moe = (args, input) => new Promise((done, failed) => {
    const child = spawn(process.execPath, [moeBin, ...args], { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", failed);
    child.on("close", status => done({ status, stdout, stderr }));
  });
  const ok = async args => {
    const result = await moe(args);
    assert.equal(result.status, 0, `moe ${args.join(" ")}: ${result.stderr}`);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };

  /** One holder command in the browser, timed: its exit code, its one JSON object, its refusal and the files read back. */
  const browser = async (argv, options = {}) => {
    const began = Date.now(), result = await command({ argv: ["wallet", ...argv], ...options });
    commands.push({ command: argv[0] === "terms" || argv[0] === "service" ? argv.slice(0, 2).join(" ") : argv[0], code: result.code, ms: Date.now() - began });
    let json, refusal;
    try { json = result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout.trim().split("\n").at(-1)); } catch { json = undefined; }
    try { refusal = result.code === 1 ? JSON.parse(result.stderr.trim().split("\n").at(-1)) : undefined; } catch { refusal = undefined; }
    return { ...result, json, refusal };
  };
  const done = async (argv, options) => {
    const result = await browser(argv, options);
    assert.equal(result.code, 0, `browser: moe wallet ${argv.join(" ")}: ${result.stderr}`);
    // One JSON object on stdout and nothing else, as from a process.
    assert.equal(result.stdout.split("\n").filter(line => line !== "").length, 1, result.stdout);
    return result.json;
  };
  const refusedIn = async (argv, code, options) => {
    const result = await browser(argv, options);
    assert.equal(result.code, 1, `browser: moe wallet ${argv.join(" ")} exited ${result.code}: ${result.stderr}`);
    assert.equal(result.refusal?.code, code, result.stderr);
    return result.refusal;
  };

  const OP = join(scratch, "operator"), BK = join(scratch, "backer"), SH = join(scratch, "shop");
  const common = ["--node", nodeUrl, "--parameters", parameters];
  const holder = "/holder", restored = "/restored", files = { venue: "/in/venue.json", service: "/in/service.json", terms: "/in/terms.bin",
    signature: "/in/terms.sig", g1: "/parameters/bn254_g1.dat", g2: "/parameters/bn254_g2.dat" };
  const leading = (path, length) => readFileSync(path).subarray(0, length);
  let backing, inputs, serving;
  const holdings = view => view.holdings.map(h => [h.value, h.status]).sort();
  /** Mine and rerun until `until` holds of a command's output, a few rounds at most. */
  const settled = async (run, until, rounds = 12) => {
    for (let round = 0; ; round++) {
      await nextRound();
      const result = await run();
      if (result.code === 0 && until(result.json)) return result.json;
      assert(round < rounds, `did not settle: ${result.stdout}${result.stderr}`);
    }
  };
  const node$ = (verb, directory, ...rest) => ["wallet", ...verb.split(" "), "--dir", directory, ...rest];
  const submit = async (directory, alias) => {
    for (let round = 0; ; round++) {
      const result = await moe(node$("submit", directory, alias, backing));
      if (result.status === 0) return;
      assert(round < 12 && result.stderr.includes("SCHEDULE"), `moe wallet submit ${alias}: ${result.stderr}`);
      await advance(1); await pause(300);
    }
  };

  try {
    await check("an operator, a backer's terms and a shop as processes; serve listens", async () => {
      await advance(Number(DEPTH) + 2);
      const operator = await ok(["operator", "init", "--dir", OP, ...common, "--budget", BUDGET]);
      await call("/synthetic/fund", { tree: operator.fundingTree, value: String(FUND) });
      await ok(["operator", "venue", "create", "--dir", OP, "--synthetic", "--depth", DEPTH]);
      await advance(Number(DEPTH) + 1);
      await ok(["wallet", "init", "--dir", BK, "--backer", "--venue", join(OP, "venue.json"), ...common]);
      const created = await ok(node$("terms create", BK, "--operator", operator.operator, "--thing", "drill units", "--per-unit", "1",
        "--interval", "80", "--silence", SILENCE, "--challenge", "5"));
      backing = created.backing;
      await ok(["operator", "open", "--dir", OP, "--id", "genesis", backing, "--terms", created.terms, "--signature", created.signature, "--synthetic"]);
      await advance(Number(DEPTH) + 2);
      serving = spawn(process.execPath, [moeBin, "operator", "serve", "--dir", OP, "--interval", "2", "--poll-ms", "100"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      servers.push(serving);
      const listening = await new Promise((resolve, reject) => {
        let out = "", err = "";
        serving.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0])); });
        serving.stderr.on("data", chunk => { err += chunk; });
        serving.on("close", status => reject(new Error(`serve exited ${status}: ${err}`)));
      });
      const service = JSON.parse(readFileSync(join(OP, "service.json"), "utf8"));
      route(Number(new URL(service.url).port));
      assert.equal(listening.status, "serving");
      await ok(["wallet", "init", "--dir", SH, "--venue", join(OP, "venue.json"), ...common]);
      await ok(node$("terms add", SH, backing, "--terms", join(BK, "terms", backing), "--signature", join(BK, "terms", `${backing}.sig`), "--synthetic"));
      for (const directory of [BK, SH]) await ok(node$("service add", directory, backing, join(OP, "service.json")));
      inputs = {
        [files.venue]: readFileSync(join(OP, "venue.json")), [files.service]: readFileSync(join(OP, "service.json")),
        [files.terms]: readFileSync(join(BK, "terms", backing)), [files.signature]: readFileSync(join(BK, "terms", `${backing}.sig`)),
        // The parameters a directory caches are the leading points (parameter-files.ts), copied in as --parameters names them.
        [files.g1]: leading(join(parameters, "bn254_g1.dat"), 64 * 32768), [files.g2]: leading(join(parameters, "bn254_g2.dat"), 128),
      };
    });

    const holderInit = ["--venue", files.venue, "--node", nodeUrl, "--parameters", "/parameters"];
    await check("the holder's wallet in the browser: init, terms and service kept, a request whose frame is read back", async () => {
      const init = await done(["init", "--dir", holder, ...holderInit], { files: inputs });
      assert.deepEqual([init.status, init.role], ["created", "wallet"]);
      // An exact rerun of init over the directory it finished replays, as under Node.
      assert.equal((await done(["init", "--dir", holder, ...holderInit])).replay, true);
      await done(["terms", "add", "--dir", holder, backing, "--terms", files.terms, "--signature", files.signature, "--synthetic"]);
      await done(["service", "add", "--dir", holder, backing, files.service]);
    });

    let fund;
    await check("receive: the backer issues to the browser's request; fulfill reads it final and sync holds it", async () => {
      const made = await browser(["request", "--dir", holder, "fund", backing, "10", "--out", "/fund.request"], { read: ["/fund.request"] });
      assert.equal(made.code, 0, made.stderr);
      fund = { ...made.json, frame: made.files["/fund.request"] };
      assert.equal(fund.frame?.length, 246, "the request frame is read back from the pool");
      // An exact retry yields the same frame and digest.
      const again = await done(["request", "--dir", holder, "fund", backing, "10", "--out", "/fund-2.request"]);
      assert.equal(again.digest, fund.digest);
      const frameFile = join(scratch, "fund.request");
      writeFileSync(frameFile, fund.frame);
      await ok(node$("issue", BK, "issue-1", backing, "--request", frameFile, "--digest", fund.digest, "--value", "10"));
      await submit(BK, "issue-1");
      const fulfilled = await settled(() => browser(["fulfill", "--dir", holder, "fund", backing]), () => true);
      assert.deepEqual([fulfilled.status, fulfilled.value], ["final", "10"]);
      // fulfill is never replayed as a new credit: a rerun exits 4 with the saved result.
      const replay = await browser(["fulfill", "--dir", holder, "fund", backing]);
      assert.equal(replay.code, 4, replay.stderr);
      assert.deepEqual(holdings(await done(["sync", "--dir", holder, backing])), [["10", "available"]]);
    });

    await check("pay: the browser proves a payment to the shop's request; a substituted request is refused; the shop fulfills it", async () => {
      const invoiceFile = join(scratch, "invoice.request");
      const invoice = await ok(node$("request", SH, "invoice", backing, "3", "--out", invoiceFile));
      const frame = { "/in/invoice.request": readFileSync(invoiceFile) };
      await refusedIn(["pay", "--dir", holder, "pay-x", backing, "--request", "/in/invoice.request", "--digest", "00".repeat(32), "--value", "3"], "REQUEST", { files: frame });
      const paid = await done(["pay", "--dir", holder, "pay-1", backing, "--request", "/in/invoice.request", "--digest", invoice.digest, "--value", "3"]);
      assert.deepEqual([paid.status, paid.kind, paid.value], ["pending", "payment", "3"]);
      assert.notEqual(paid.receipt, null, "submitted to the operator's service from the browser");
      for (let round = 0; ; round++) {
        await nextRound();
        const result = await moe(node$("fulfill", SH, "invoice", backing));
        if (result.status === 0) { const json = JSON.parse(result.stdout.trim()); assert.deepEqual([json.status, json.value], ["final", "3"]); break; }
        assert(round < 12, `the shop's fulfill did not settle: ${result.stderr}`);
      }
      await nextRound();
      assert.deepEqual(holdings(await done(["sync", "--dir", holder, backing])), [["7", "available"]]);
      assert.equal((await done(["status", "--dir", holder, "pay-1"])).status, "final");
    });

    await check("one command at a time: a second command while one holds the pool is refused BUSY", async () => {
      const [first, second] = await Promise.all([browser(["sync", "--dir", holder, backing]), browser(["status", "--dir", holder, "pay-1"])]);
      const codes = [first, second].map(result => result.code === 1 ? result.refusal?.code : result.code).sort();
      assert.deepEqual(codes, [0, "BUSY"].sort(), JSON.stringify([first.stderr, second.stderr]));
    });

    await check("restore: the seed shown in the browser restores into a new directory that finds the same holdings", async () => {
      const { seed } = await done(["seed", "--dir", holder, "--show"]);
      assert.match(seed, /^[0-9a-f]{64}$/);
      await done(["restore-seed", "--dir", restored, ...holderInit], { stdin: new TextEncoder().encode(`${seed}\n`) });
      await done(["terms", "add", "--dir", restored, backing, "--terms", files.terms, "--signature", files.signature, "--synthetic"]);
      await done(["service", "add", "--dir", restored, backing, files.service]);
      assert.deepEqual(holdings(await done(["sync", "--dir", restored, backing])), [["7", "available"]]);
    });
  } finally {
    for (const child of servers) child.kill("SIGTERM");
    await Promise.all(servers.map(child => child.exitCode !== null ? undefined : new Promise(resolve => child.once("close", resolve))));
    await node.close?.();
  }
  rmSync(scratch, { recursive: true, force: true });
  return { checks, commands };
}
