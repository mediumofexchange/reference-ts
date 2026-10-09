// Slice 14 M14g4: a lit backing through the `moe` commands, each a fresh process
// on its own directory, over the synthetic Ergo node through the node REST clients. Lit directories declare their
// construction at init and keep no proving parameters; nothing here proves or verifies a proof, and no process loads a
// `@noir-lang` module. A backer's wallet creates lit terms naming an operator directory, which opens and serves them;
// the backer issues to a holder's owner-key request, the holder fulfills it and pays a shop, the shop fulfills (a rerun
// exits 4), demands, the backer accepts and a relay publishes the acceptance, the shop settles and the backer burns the
// settled note; a reader's supply reads the totals, and the shop and the reader read the demand settled under C3.8
// (M14g5b). A withdrawn demand's presented note pays as any other (lit has no freshen) and reads withdrawn. With the
// operator stopped past silence, a demand and its settlement are published through the relay and read final by force
// (the holder's sync and C3.8 reading, and the reader on the kept package), then the operator returns and adopts.
// Every holder process (wallet, reader, relay) reaches the operator only as an onion service (M12a): `serve --onion` adds
// a holders' listener, and holders run with Node's environment proxy naming a CONNECT-only proxy here that, as Tor
// does, maps the onion name to that listener and refuses every other target, with the node direct (NO_PROXY);
// a guard ends any holder process that connects anywhere but the proxy and the node, and a holder's sync while the
// service is up must read served evidence. A holder without the proxy, or with a proxy that is down, refuses PROXY.
// A replica (M12b), a reader directory that serves, keeps the backing's evidence behind an onion name of its own; with
// the operator stopped the holder's sync falls to it, and a reader with no operator service reads its supply from the
// replica alone, past a replica that is down. The holder hands its gap demand and release to a third party's relay
// (M12c), `relay serve` behind an onion name of its own, with `relay send` through the proxy: the holder funds nothing;
// a send without the proxy, with a wrong credential or for another venue is refused. A handoff and a seed restoration recover the holdings; the seed-restored wallet's window is full until `move-window`
// is final, after which it requests again. Hostile cases: pool-v3 terms into a lit directory (CONSTRUCTION), a lit
// directory given --parameters or terms given --challenge (usage), freshen (CONSTRUCTION), a pool-v3 request frame to
// a lit payer (REQUEST), a relay file for another venue (VENUE).
//
// Slice 13 M13c: each party is a machine of its own, running `moe` from its own install of the release (packed and
// installed from its install lock, scripts/release.mjs) with its own working, home and temporary directories: the
// operator, the backer, the holder, the shop, a reader, the replica, the relays (one party, two directories) and the
// shop's restorations on a new machine. A command runs on the machine owning the directory it names (`relay send` on
// the holder's), and parties meet only through the venue, the onion services and the files the drill hands across.
// It writes nothing outside its scratch directory.
//
// Slice 13 M13e: the shop's restored wallet, the reader and the relay are lost and their backups restored in place: the
// wallet refuses to act (COPIED) until `restore --copy`, after which its next read exposes every owner key through
// h + 256 and it refuses the request its lost instance credited (RESTORED); the reader reads the same supply over its
// copied view and replay file; `venue audit` refuses a view changed in place (AUDIT); the relay publishes again.
//
// Usage: node scripts/lit/command-drill.mjs   (after npm run build)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect } from "node:net";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { prepareExactOutput } from "../../dist/pool/v3/capsules.js";
import { adoptedDomain } from "../../dist/pool/v3/configuration.js";
import { encodePaymentRequest, paymentRequestDigest } from "../../dist/pool/v3/wallet-request.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../../dist/pool/v3/terms.js";
import { parseVenue } from "../../dist/cli/venue.js";
import { LIT as LIT_CONSTRUCTION } from "../../dist/lit/construction.js";
import { V3ServiceClient } from "../../dist/pool/v3/service-client.js";
import { serveSyntheticNode } from "../pool/v3/synthetic-node.mjs";
import { installParties, packRelease } from "../release.mjs";

const root = resolve(import.meta.dirname, "../..");
const RSS_HOOK = new URL("../pool/v3/rss-hook.mjs", import.meta.url).href, GUARD = new URL("./direct-guard.mjs", import.meta.url).href;
const hex = bytes => Buffer.from(bytes).toString("hex");
const LIT = ["--construction", "moe/lit/v1"], SYN = ["--synthetic"], POLL = "100", DEPTH = "2", SILENCE = 16n;
const FUND = 1_000_000_000n, BUDGET = "50000000";
mkdirSync(join(root, "scratch"), { recursive: true });
const scratch = realpathSync(mkdtempSync(join(realpathSync(join(root, "scratch")), "lit-command-drill-")));
// Module files a party's process resolved outside its own install (M13c).
const checks = [], processes = [], servers = [], strays = [];
const check = async (label, fn) => { await fn(); checks.push(label); process.stderr.write(`passed: ${label}\n`); };
const pause = ms => new Promise(done => setTimeout(done, ms));

const node = await serveSyntheticNode();
// The onion service as Tor's HTTPTunnelPort reaches it: CONNECT only, the onion name to the holders' listener, a 502
// where that does not answer, and every other target refused (Tor refuses internal addresses).
const ONION = `${"m".repeat(55)}d.onion`, REPLICA = `${"r".repeat(55)}d.onion`, DOWN = `${"n".repeat(55)}d.onion`;
const RELAY = `${"l".repeat(55)}d.onion`;
const tor = { holders: 0, replica: 0, relay: 0, tunnels: 0, refused: [] };
const torProxy = createServer((_, response) => response.writeHead(405).end()).on("connect", (request, client, head) => {
  // An onion service that is down answers an error status (Tor answers 500, 503 or 504; moe reads each as UNAVAILABLE).
  if (request.url === `${DOWN}:80`) { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
  const port = request.url === `${ONION}:80` ? tor.holders : request.url === `${REPLICA}:80` ? tor.replica : request.url === `${RELAY}:80` ? tor.relay : 0;
  if (port === 0) { tor.refused.push(request.url); client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
  tor.tunnels++;
  let joined = false;
  const upstream = connect(port, "127.0.0.1", () => {
    joined = true; client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  upstream.on("error", () => { if (!joined) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); else client.destroy(); });
  client.on("error", () => upstream.destroy()); client.on("close", () => upstream.destroy());
});
await new Promise(done => torProxy.listen(0, "127.0.0.1", done));
const torPort = torProxy.address().port, nodePort = new URL(node.url).port;
const PROXY_VARIABLES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "NODE_USE_ENV_PROXY"];
const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROXY_VARIABLES.includes(key)));
let serviceUp = false;
// Every party's machine, its own install of one packed release (M13c), and the machine owning each data directory.
const releaseDirectory = join(scratch, "release");
mkdirSync(releaseDirectory);
const release = packRelease(releaseDirectory).record;
const MACHINES = { operator: ["operator"], backer: ["backer"], holder: ["holder"], shop: ["shop"], reader: ["reader", "reader-replica"],
  replica: ["replica"], relay: ["relay", "relay-third"], restored: ["holder-seed", "holder-handoff"] };
const parties = installParties(releaseDirectory, join(scratch, "machines"), Object.keys(MACHINES), plainEnv);
const OWNER = new Map(Object.entries(MACHINES).flatMap(([party, directories]) => directories.map(directory => [directory, party])));
/** The party whose machine runs `args`: the one owning the directory it names; a holder sends to a third party's relay. */
function partyOf(args) {
  if (args[0] === "relay" && args[1] === "send") return "holder";
  const at = args.indexOf("--dir"), directory = args[at + 1];
  assert(at >= 0 && dirname(directory) === scratch && OWNER.has(basename(directory)), `moe ${args.join(" ")} names a party's directory`);
  return OWNER.get(basename(directory));
}
const call = async (path, body) => {
  const response = await fetch(`${node.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
};
const advance = count => call("/synthetic/mine", { count });
const fund = (tree, value) => call("/synthetic/fund", { tree, value: String(value) });
/** Past the depth, so what serve or the relay published is witnessed. */
const nextRound = async () => { await advance(Number(DEPTH) + 2); await pause(300); };

/** One `moe` process: its exit code, stdout's JSON, stderr and its refusal. With `mining: "waiting"`, each wait it
 * logs mines one block, so the chain moves with the command's retries. */
/** A holder's process: through the proxy, each with its own credential (Tor isolates streams by it), the node direct;
 * the guard ends it at any other connection. */
const holderProcess = (args, { input, proxy = torPort, proxyHost = "127.0.0.1", rss } = {}) => {
  const holder = args[0] !== "operator", party = partyOf(args), machine = parties[party];
  const env = { ...machine.env, MOE_DRILL_RSS: rss, MOE_DRILL_INSTALL: machine.install, ...(holder && proxy !== null ? { NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: `http://drill-${processes.length}-${process.hrtime.bigint()}:x@${proxyHost}:${proxy}`, NO_PROXY: "127.0.0.1" } : {}),
    ...(holder ? { MOE_DRILL_PORTS: `${proxy ?? torPort},${nodePort}` } : {}) };
  const child = spawn(process.execPath, ["--import", RSS_HOOK, ...(holder ? ["--import", GUARD] : []), machine.bin, ...args],
    { cwd: machine.cwd, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env });
  child.party = party;
  return child;
};
function moe(args, { mining, input, proxy = torPort, proxyHost = "127.0.0.1" } = {}) {
  return new Promise((done, failed) => {
    const rss = join(scratch, `rss-${processes.length}-${process.hrtime.bigint()}.json`);
    const child = holderProcess(args, { input, proxy, proxyHost, rss });
    if (input !== undefined) child.stdin.end(input);
    const out = [], err = [];
    let waits = 0;
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => {
      err.push(chunk);
      if (mining !== "waiting") return;
      const seen = Buffer.concat(err).toString().split("\n").filter(line => line.includes('"event":"waiting"')).length;
      for (; waits < seen; waits++) advance(1).catch(() => {});
    });
    child.on("error", failed);
    child.on("close", status => {
      const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
      let noir = null, outside = [];
      try { ({ noir, outside } = JSON.parse(readFileSync(rss, "utf8"))); rmSync(rss); } catch { /* died before its exit handler */ }
      for (const url of outside) strays.push(`${args.slice(0, 2).join(" ")}: ${url}`);
      processes.push({ command: args.slice(0, 2).join(" "), party: child.party, status, noir });
      let json, refusal;
      try { json = stdout.trim() === "" ? undefined : JSON.parse(stdout.trim().split("\n").at(-1)); } catch { json = undefined; }
      try { refusal = status === 1 ? JSON.parse(stderr.trim().split("\n").at(-1)) : undefined; } catch { refusal = undefined; }
      done({ status, json, stdout, stderr, refusal });
    });
  });
}
/** While the service is up, a holder's read takes it from the service, through the proxy, never from what it kept. */
const served = (args, result) => {
  if (serviceUp && result.status === 0 && args[0] === "wallet" && ["sync", "fulfill"].includes(args[1])) {
    assert.equal(result.json.evidence, "served", `moe ${args.join(" ")}`);
  }
};
const ok = async (args, options) => {
  const result = await moe(args, options);
  assert.equal(result.status, 0, `moe ${args.join(" ")}: ${result.stderr}`);
  assert.equal(result.stdout.split("\n").filter(line => line !== "").length, 1, result.stdout);
  served(args, result);
  return result.json;
};
const refused = async (args, code, options) => {
  const result = await moe(args, options);
  assert.equal(result.status, 1, `moe ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  assert.equal(result.refusal?.code, code, result.stderr);
  return result.refusal;
};
/** A usage refusal (exit 2) naming `message`: any other usage error would pass a bare exit check. */
const usage = async (args, message) => {
  const result = await moe(args);
  assert.equal(result.status, 2, `moe ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  assert(result.stderr.includes(message), `moe ${args.join(" ")}: ${result.stderr}`);
  return result.stderr;
};

/** `moe operator serve` in the background: resolves with its first line once listening, and a stop. */
function serve(directory) {
  const machine = parties[partyOf(["operator", "serve", "--dir", directory])];
  const child = spawn(process.execPath, ["--import", RSS_HOOK, machine.bin, "operator", "serve", "--dir", directory, "--interval", "2", "--poll-ms", POLL,
    "--onion", ONION], { cwd: machine.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...machine.env, MOE_DRILL_RSS: join(scratch, `rss-serve-${process.hrtime.bigint()}.json`),
      MOE_DRILL_INSTALL: machine.install } });
  servers.push(child);
  let stdout = "", stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(done => child.on("close", status => done(status)));
  const listening = new Promise((done, failed) => {
    let listened = false;
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (listened || !stdout.includes("\n")) return;
      listened = true;
      const line = JSON.parse(stdout.split("\n")[0]);
      assert.equal(line.holders.url, `http://${ONION}/`); tor.holders = line.holders.port; serviceUp = true; done(line);
    });
    exited.then(status => failed(new Error(`serve exited ${status}: ${stderr}`)));
  });
  return { listening, log: () => stderr, async stop() {
    serviceUp = false; child.kill("SIGTERM"); const status = await exited;
    if (process.platform !== "win32") assert.equal(status, 0, stderr);
  } };
}

/** `moe reader serve` (a replica) or `moe relay serve` in the background, a process behind its own onion name: its
 * lines as they come, and a stop that expects its last line. */
function background(args, rss) {
  const child = holderProcess(args, { rss: join(scratch, `rss-${rss}-${process.hrtime.bigint()}.json`) });
  servers.push(child);
  const lines = [];
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk;
    for (let at = stdout.indexOf("\n"); at >= 0; at = stdout.indexOf("\n")) { lines.push(JSON.parse(stdout.slice(0, at))); stdout = stdout.slice(at + 1); }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(done => child.on("close", status => done(status)));
  return { lines, log: () => stderr, async stop() {
    child.kill("SIGTERM"); const status = await exited;
    if (process.platform !== "win32") { assert.equal(status, 0, stderr); assert.equal(lines.at(-1)?.status, "stopped"); }
  } };
}
const replicaServe = directory => background(["reader", "serve", "--dir", directory, "--onion", REPLICA, "--poll-ms", POLL], "replica");
const relayServe = directory => background(["relay", "serve", "--dir", directory, "--onion", RELAY, "--poll-ms", POLL], "relay");

let completed = false;
try {
  const OP = join(scratch, "operator"), BK = join(scratch, "backer"), HD = join(scratch, "holder"), SH = join(scratch, "shop");
  const RD = join(scratch, "reader"), RL = join(scratch, "relay"), RP = join(scratch, "replica"), RF = join(scratch, "reader-replica"), RT = join(scratch, "relay-third"), H2 = join(scratch, "holder-seed"), H3 = join(scratch, "holder-handoff");
  const nodeArgs = ["--node", node.url], venueFile = join(OP, "venue.json");
  const wallet = (verb, directory, ...rest) => ["wallet", ...verb.split(" "), "--dir", directory, ...rest];
  await advance(Number(DEPTH) + 2);

  let operatorKey, backing, termsFile, signatureFile;
  await check("lit directories declare their construction at init and keep no proving parameters; the operator creates the venue", async () => {
    await usage(["operator", "init", "--dir", OP, ...nodeArgs, "--budget", BUDGET, "--construction", "moe/lit/v2"], "--construction is one of");
    await usage(["operator", "init", "--dir", OP, ...nodeArgs, "--budget", BUDGET, ...LIT, "--parameters", scratch], "keeps no proving parameters");
    const init = await ok(["operator", "init", "--dir", OP, ...nodeArgs, "--budget", BUDGET, ...LIT]);
    // A holders' listener needs a v3 onion name.
    await usage(["operator", "serve", "--dir", OP, "--interval", "2", "--holder-port", "1"], "--holder-port needs --onion");
    await usage(["operator", "serve", "--dir", OP, "--interval", "2", "--onion", `${"m".repeat(56)}.onion`], "--onion takes a v3 onion host");
    assert.deepEqual([init.status, init.construction], ["created", "moe/lit/v1"]);
    assert.equal(JSON.parse(readFileSync(join(OP, "config.json"), "utf8")).construction, "moe/lit/v1");
    operatorKey = init.operator;
    await fund(init.fundingTree, FUND);
    const venue = (await ok(["operator", "venue", "create", "--dir", OP, ...SYN, "--depth", DEPTH])).venue;
    await advance(Number(DEPTH) + 1);
    const backer = await ok(wallet("init", BK, "--backer", "--venue", venueFile, ...nodeArgs, ...LIT));
    assert.match(backer.backer, /^[0-9a-f]{64}$/);
    await usage(wallet("terms create", BK, "--operator", operatorKey, "--thing", "drill units", "--per-unit", "1", "--interval", "80",
      "--silence", String(SILENCE), "--challenge", "5"), "--challenge is not taken");
    const created = await ok(wallet("terms create", BK, "--operator", operatorKey, "--thing", "drill units", "--per-unit", "1", "--interval", "80",
      "--silence", String(SILENCE)));
    backing = created.backing; termsFile = created.terms; signatureFile = created.signature;
    const opened = await ok(["operator", "open", "--dir", OP, "--id", "genesis", backing, "--terms", termsFile, "--signature", signatureFile, ...SYN]);
    assert.deepEqual([opened.status, opened.commitment.sequence], ["pending", "1"]);
    for (const directory of [HD, SH]) {
      await ok(wallet("init", directory, "--venue", venueFile, ...nodeArgs, ...LIT));
      const added = await ok(wallet("terms add", directory, backing, "--terms", termsFile, "--signature", signatureFile, ...SYN));
      assert.deepEqual([added.construction, added.obligor, added.silence.noCommitmentDuration], ["moe/lit/v1", backer.backer, String(SILENCE)]);
      assert.match(added.notes.join(" "), /lit notes .* pseudonymity, not privacy/);
    }
    // Pool-v3 terms on the same venue are another construction's: refused by name.
    const pool = encodeRootTerms({ obligor: ed25519.getPublicKey(new Uint8Array(32).fill(41)), operator: Buffer.from(operatorKey, "hex"),
      configuration: adoptedDomain(), venue: Buffer.from(venue, "hex"),
      interval: 80n, payout: { thing: "drill units", quantumExponent: 0, perUnit: 1n } });
    const poolTerms = join(scratch, "pool.terms"), poolSignature = join(scratch, "pool.sig");
    writeFileSync(poolTerms, pool); writeFileSync(poolSignature, ed25519.sign(rootTermsSignatureMessage(pool), new Uint8Array(32).fill(41)));
    const refusal = await refused(wallet("terms add", HD, hex(rootTermsName(pool)), "--terms", poolTerms, "--signature", poolSignature, ...SYN), "CONSTRUCTION");
    assert.match(refusal.message, /moe\/pool\/v3.*moe\/lit\/v1/);
    await ok(["reader", "init", "--dir", RD, "--venue", venueFile, ...nodeArgs, ...LIT]);
    await ok(["reader", "terms", "add", "--dir", RD, backing, "--terms", termsFile, "--signature", signatureFile, ...SYN]);
    // A relay verifies nothing: it keeps no parameters and serves either construction.
    await usage(["relay", "init", "--dir", RL, "--venue", venueFile, ...nodeArgs, "--budget", BUDGET, "--parameters", scratch], "unknown option --parameters");
    const relay = await ok(["relay", "init", "--dir", RL, "--venue", venueFile, ...nodeArgs, "--budget", BUDGET]);
    await fund(relay.fundingTree, FUND);
    // A third party's relay, which serves holders (M12c).
    await fund((await ok(["relay", "init", "--dir", RT, "--venue", venueFile, ...nodeArgs, "--budget", BUDGET])).fundingTree, FUND);
    await advance(Number(DEPTH) + 2);
  });

  let serving = serve(OP);
  const settled = async (args, until, rounds = 12) => {
    for (let round = 0; ; round++) {
      await nextRound();
      const result = await moe(args);
      served(args, result);
      if (result.status === 0 && until(result.json)) return result.json;
      assert(round < rounds, `moe ${args.join(" ")} did not settle: ${result.stdout}${result.stderr}`);
    }
  };
  const finalOf = async (directory, alias, rounds = 12) => {
    for (let round = 0; ; round++) {
      await nextRound();
      await ok(wallet("sync", directory, backing));
      const saved = await ok(wallet("status", directory, alias));
      if (saved.status === "final") return saved;
      assert(round < rounds, `${alias} did not become final: ${JSON.stringify(saved)}`);
    }
  };
  /** A submission, retried while the journal waits out its reopening lag (C2.8.2) and refuses SCHEDULE. */
  const submit = async (directory, alias) => {
    for (let round = 0; ; round++) {
      const result = await moe(wallet("submit", directory, alias, backing));
      if (result.status === 0) return result.json;
      assert(round < 12 && result.refusal?.code === "SCHEDULE", `moe wallet submit ${alias}: ${result.stderr}`);
      await advance(1); await pause(200);
    }
  };
  const holdings = view => view.holdings.map(h => [h.value, h.status, h.presented.length]).sort();
  const request = async (directory, alias, value) => {
    const out = join(scratch, `${alias}.request`), made = await ok(wallet("request", directory, alias, backing, String(value), "--out", out));
    return { made, args: ["--request", out, "--digest", made.digest] };
  };
  const supply = (...rest) => ok(["reader", "supply", "--dir", RD, backing, ...rest]);

  await check("issue to an owner-key request, its fulfillment, a payment with change and the payee's fulfillment (a rerun exits 4)", async () => {
    await serving.listening;
    for (const directory of [BK, HD, SH]) await ok(wallet("service add", directory, backing, join(OP, "holders.json")));
    await ok(["reader", "service", "add", "--dir", RD, backing, join(OP, "holders.json")]);
    // An onion service without the environment proxy refuses before any connection (the guard allows none to the
    // service); with the proxy down, it is named rather than read as an operator that did not answer.
    assert.match((await refused(wallet("sync", HD, backing), "PROXY", { proxy: null })).message, /environment proxy/);
    const closed = createServer(); await new Promise(done => closed.listen(0, "127.0.0.1", done));
    const deadPort = closed.address().port; await new Promise(done => closed.close(done));
    // Named as `localhost`, the proxy may have two addresses: both refusing is the proxy's failure too.
    for (const proxyHost of ["127.0.0.1", "localhost"]) {
      assert.match((await refused(wallet("sync", HD, backing), "PROXY", { proxy: deadPort, proxyHost })).message, /proxy did not answer/);
    }
    const funding = await request(HD, "fund", 10);
    // Lit-v1 §8's frame: tag, domain, backing, value and owner key.
    assert.equal(funding.made.frame.length, 2 * (25 + 32 + 32 + 8 + 32));
    assert.match(funding.made.notes.join(" "), /Lit notes are public/);
    const issued = await ok(wallet("issue", BK, "issue-1", backing, ...funding.args, "--value", "10"));
    assert.deepEqual([issued.status, issued.kind], ["pending", "issue"]);
    await submit(BK, "issue-1");
    const again = await ok(wallet("issue", BK, "issue-1", backing, ...funding.args, "--value", "10"));
    assert.deepEqual([again.statement, again.evidence], [issued.statement, "saved"]);
    await finalOf(BK, "issue-1");
    const credited = await ok(wallet("fulfill", HD, "fund", backing));
    assert.deepEqual([credited.status, credited.value, credited.owner], ["final", "10", funding.made.frame.slice(-64)]);
    assert.deepEqual(holdings(await ok(wallet("sync", HD, backing))), [["10", "available", 0]]);
    const invoice = await request(SH, "invoice", 3);
    // A pool-v3 request frame for this backing, authenticated by its own digest, is no lit request.
    const out = prepareExactOutput(new Uint8Array(32).fill(3), adoptedDomain(), new Uint8Array(32).fill(4), Buffer.from(backing, "hex"), 3n);
    const frame = encodePaymentRequest({ domain: adoptedDomain(), opening: out.opening, cm: out.cm, capsule: out.capsule });
    const foreign = join(scratch, "foreign.request"); writeFileSync(foreign, frame);
    await refused(wallet("pay", HD, "pay-0", backing, "--request", foreign, "--digest", paymentRequestDigest(frame), "--value", "3"), "REQUEST");
    const paid = await ok(wallet("pay", HD, "pay-1", backing, ...invoice.args, "--value", "3"));
    assert.deepEqual([paid.status, paid.kind, paid.value], ["pending", "payment", "3"]);
    assert.notEqual(paid.receipt, null);
    await refused(wallet("pay", HD, "pay-1", backing, ...invoice.args, "--value", "2"), "INVALID");
    const fulfilled = await settled(wallet("fulfill", SH, "invoice", backing), () => true);
    assert.deepEqual([fulfilled.status, fulfilled.value], ["final", "3"]);
    const replay = await moe(wallet("fulfill", SH, "invoice", backing));
    assert.equal(replay.status, 4, replay.stderr);
    const { status: _status, evidence: _evidence, ...saved } = fulfilled;
    assert.deepEqual(JSON.parse(replay.stdout), { status: "replay", ...saved });
    assert.deepEqual(await ok(wallet("fulfillment", SH, "invoice")), { status: "final", ...saved });
    assert.deepEqual(holdings(await ok(wallet("sync", HD, backing))), [["7", "available", 0]]);
    assert.equal((await ok(wallet("status", HD, "pay-1"))).status, "final");
  });

  await check("demand, the backer's acceptance relayed, settlement and a burn of the settled note; the reader's supply", async () => {
    const shown = await ok(wallet("demand", SH, "redeem", backing, "3", "--deadline", "+60"));
    assert.deepEqual([shown.status, shown.kind], ["pending", "demand"]);
    // Lit-v1 §11: nothing to freshen; the notes say what a lit demand discloses.
    assert.match(shown.notes.join(" "), /is public/); assert.doesNotMatch(shown.notes.join(" "), /freshen/);
    await refused(wallet("publish", SH, "redeem", backing, "--out", join(scratch, "early.json")), "GAP");
    await submit(SH, "redeem");
    await finalOf(SH, "redeem");
    // Next 4 (ab): the same command line rerun after the index moved is the exact retry, its `+n` read as the saved deadline.
    const rerun = await ok(wallet("demand", SH, "redeem", backing, "3", "--deadline", "+60"));
    assert.deepEqual([rerun.demand, rerun.deadline, rerun.status], [shown.demand, shown.deadline, "final"]);
    const locked = await ok(wallet("sync", SH, backing));
    assert.deepEqual(holdings(locked), [["3", "locked", 1]]);
    assert.deepEqual(locked.demands.map(d => d.id), [shown.demand]);
    const acceptance = join(scratch, "answer.acceptance"), relayed = join(scratch, "answer.json");
    const accepted = await ok(wallet("accept", BK, "answer", backing, shown.demand, "--deadline", String(BigInt(shown.deadline) - 10n), "--out", acceptance));
    assert.equal(accepted.demand, shown.demand); assert.match(accepted.owner, /^[0-9a-f]{64}$/);
    const again = await ok(wallet("accept", BK, "answer", backing, shown.demand, "--deadline", "+1", "--out", acceptance));
    assert.deepEqual([again.deadline, again.owner], [accepted.deadline, accepted.owner]);
    await ok(wallet("publish-acceptance", BK, "answer", backing, "--out", relayed));
    const sent = await ok(["relay", "publish", "--dir", RL, relayed]);
    assert.equal(sent.status, "pending");
    await settled(["relay", "publish", "--dir", RL, relayed], out => out.status === "final");
    const settlement = await ok(wallet("settle", SH, "settle-1", backing, "--acceptance", acceptance));
    assert.deepEqual([settlement.kind, settlement.demand], ["settlement", shown.demand]);
    await submit(SH, "settle-1");
    await finalOf(SH, "settle-1");
    assert.deepEqual((await ok(wallet("sync", SH, backing))).holdings, []);
    // C3.8 (lit-v1 §7): the relayed acceptance answers, K's and its owner key's signatures verified; the settlement ends the demand.
    const reading = await ok(wallet("presentation", SH, backing, shown.demand));
    assert.deepEqual([reading.status, reading.ended.by, reading.overdue, reading.acceptances.map(a => a.owner)],
      ["final", "settlement", undefined, [accepted.owner]]);
    const presented = await settled(["reader", "presentation", "--dir", RD, backing, shown.demand], out => out.status === "final");
    assert.deepEqual([presented.ended.by, presented.acceptances.map(a => [a.owner, a.timely, a.taken])], ["settlement", [[accepted.owner, true, false]]]);
    assert.deepEqual(holdings(await ok(wallet("sync", BK, backing))), [["3", "available", 0]]);
    await ok(wallet("burn", BK, "retire", backing, "3"));
    await submit(BK, "retire");
    await finalOf(BK, "retire");
    let read;
    for (let round = 0; ; round++) {
      await nextRound();
      read = await supply();
      if (read.burned === "3") break;
      assert(round < 12, `the reader's supply did not reach the burn: ${JSON.stringify(read)}`);
    }
    assert.deepEqual([read.status, read.issued, read.burned, read.supply], ["final", "10", "3", "7"]);
  });

  await check("a withdrawn demand's presented note pays as any other; lit has no freshen; a read the evidence file leaves unresolved syncs again from nothing", async () => {
    const shown = await ok(wallet("demand", HD, "d2", backing, "7", "--deadline", "+60"));
    await submit(HD, "d2");
    await finalOf(HD, "d2");
    await ok(wallet("withdraw", HD, "w2", backing, shown.demand));
    await submit(HD, "w2");
    await finalOf(HD, "w2");
    const freed = await ok(wallet("sync", HD, backing));
    assert.deepEqual(holdings(freed), [["7", "available", 1]]);
    // Lit spends a presented note as any other: `available` counts it, `presented` names the part a demand presented.
    assert.deepEqual([freed.available, freed.presented], ["7", "7"]);
    const withdrawn = await ok(wallet("presentation", HD, backing, shown.demand));
    assert.deepEqual([withdrawn.status, withdrawn.ended.by, withdrawn.acceptances], ["final", "withdrawal", []]);
    await refused(wallet("freshen", HD, "fresh-2", backing, shown.demand), "CONSTRUCTION");
    const invoice = await request(SH, "invoice-2", 2);
    await ok(wallet("pay", HD, "pay-2", backing, ...invoice.args, "--value", "2"));
    await finalOf(HD, "pay-2");
    assert.deepEqual(holdings(await ok(wallet("sync", HD, backing))), [["5", "available", 0]]);
    assert.equal((await settled(wallet("fulfill", SH, "invoice-2", backing), () => true)).value, "2");
    // A dependency the evidence file lacks past its mark (the segment's terms, as a source that withheld them leaves
    // it): the command's read is unresolved, syncs the operator again from nothing and resolves (audit 30 (au)).
    const file = join(HD, "wallet.db.evidence"), db = new DatabaseSync(file);
    db.exec("DELETE FROM segment_terms"); db.close();
    const repaired = await ok(wallet("sync", HD, backing));
    assert.deepEqual([holdings(repaired), repaired.evidence, repaired.skipped], [[["5", "available", 0]], "served", undefined]);
    assert.equal(existsSync(join(HD, "unresolved.json")), false);
  });

  let replica;
  await check("with the operator stopped past silence, a demand and its release are handed to a third party's relay and read final by force, " +
      "the holder syncing from a replica and a reader reading from it alone; the operator returns and adopts", async () => {
    // A replica of the backing, behind its own onion name, syncing from the operator's holders' listener.
    for (const directory of [RP, RF]) {
      await ok(["reader", "init", "--dir", directory, "--venue", venueFile, ...nodeArgs, ...LIT]);
      await ok(["reader", "terms", "add", "--dir", directory, backing, "--terms", termsFile, "--signature", signatureFile, ...SYN]);
    }
    await ok(["reader", "service", "add", "--dir", RP, backing, join(OP, "holders.json")]);
    await refused(["reader", "replica", "add", "--dir", RF, backing, "http://example.com/"], "INVALID");
    // A reader with replicas only, the first of them down: it keeps no service of the operator's.
    for (const url of [`http://${DOWN}/`, `http://${REPLICA}/`, `http://${REPLICA}/`]) await ok(["reader", "replica", "add", "--dir", RF, backing, url]);
    assert.deepEqual(JSON.parse(readFileSync(join(RF, "replicas", `${operatorKey}.json`), "utf8")).urls, [`http://${DOWN}/`, `http://${REPLICA}/`]);
    await ok(wallet("replica add", HD, backing, `http://${REPLICA}/`));
    replica = replicaServe(RP);
    for (const directory of [HD, BK, SH]) await ok(wallet("sync", directory, backing));
    // The whole package as any transport could carry it, for the reader once the operator is stopped.
    const service = JSON.parse(readFileSync(join(OP, "service.json"), "utf8")), { reference } = parseVenue(JSON.parse(readFileSync(venueFile, "utf8")));
    const whole = await new V3ServiceClient(service.url, service.walletToken, { operator: Buffer.from(operatorKey, "hex"), reference,
      construction: LIT_CONSTRUCTION }).package(Buffer.from(backing, "hex"));
    const packageFile = join(scratch, "package.bin");
    writeFileSync(packageFile, whole.package);
    // The replica serves once its own read finds the operator's latest selection canonical.
    for (let round = 0; ; round++) {
      if (replica.lines.length > 0) tor.replica = replica.lines[0].port;
      const line = replica.lines.findLast(l => l.backing === backing && l.served !== undefined);
      if (line?.served !== undefined && line.served !== null && BigInt(line.served) >= whole.selection.sequence) break;
      assert(round < 40, `the replica did not serve sequence ${whole.selection.sequence}: ${JSON.stringify(replica.lines)}${replica.log()}`);
      await nextRound();
    }
    assert.equal(replica.lines[0].url, `http://${REPLICA}/`);
    assert.equal(JSON.parse(readFileSync(join(RP, "replica.json"), "utf8")).url, `http://${REPLICA}/`);
    await serving.stop();
    await advance(Number(SILENCE) + 4);
    // The operator does not answer: the holder's sync falls to the replica.
    const shown = await ok(wallet("demand", HD, "gap", backing, "5", "--deadline", "+60"));
    assert.deepEqual([shown.evidence, shown.replica, shown.skipped.map(s => s.code)], ["replica", `http://${REPLICA}/`, ["UNAVAILABLE"]]);
    const file = join(scratch, "gap.json"), written = await ok(wallet("publish", HD, "gap", backing, "--out", file));
    assert.equal(written.status, "written");
    assert.match(written.notes.join(" "), /a third party's relay reached as an onion service \(moe relay send\) ties them to its other users' acts, not to your coins/);
    // The holder hands the demand to a third party's relay behind its own onion name: the relay's key funds it.
    const relaying = relayServe(RT);
    for (let round = 0; relaying.lines.length === 0; round++) { assert(round < 100, `relay serve did not listen${relaying.log()}`); await pause(100); }
    assert.deepEqual([relaying.lines[0].status, relaying.lines[0].url], ["serving", `http://${RELAY}/`]);
    tor.relay = relaying.lines[0].port;
    const relayFile = join(RT, "relay.json"), handed = JSON.parse(readFileSync(relayFile, "utf8"));
    assert.deepEqual(Object.keys(handed).sort(), ["token", "url"]);
    // Without the proxy the send refuses before any connection; a wrong credential is refused by the relay.
    await refused(["relay", "send", file, "--to", relayFile], "PROXY", { proxy: null });
    writeFileSync(join(scratch, "wrong-relay.json"), JSON.stringify({ ...handed, token: "11".repeat(32) }));
    await refused(["relay", "send", file, "--to", join(scratch, "wrong-relay.json")], "UNAUTHORIZED");
    const first = await ok(["relay", "send", file, "--to", relayFile]);
    assert.deepEqual([first.status, first.record, first.relay], ["pending", written.record, `http://${RELAY}/`]);
    assert.match(first.transaction, /^[0-9a-f]{64}$/);
    // An exact resend before it is witnessed answers the same transaction.
    assert.equal((await ok(["relay", "send", file, "--to", relayFile])).transaction, first.transaction);
    await settled(["relay", "send", file, "--to", relayFile], out => out.status === "final");
    const locked = await settled(wallet("sync", HD, backing), view => view.holdings[0]?.status === "locked");
    assert.equal(locked.gap, true);
    assert.equal((await ok(wallet("status", HD, "gap"))).status, "final");
    // With the operator stopped a reader without a replica reads the package file: the demand stands by force.
    await refused(["reader", "supply", "--dir", RD, backing], "UNAVAILABLE");
    const forced = await supply("--package", packageFile);
    assert.equal(forced.force.length, 1);
    assert.equal(forced.force[0].kind, 4);
    // A reader that never synced reads the same from the replica alone, past the replica that is down.
    const fromReplica = await ok(["reader", "supply", "--dir", RF, backing]);
    assert.deepEqual([fromReplica.status, fromReplica.evidence, fromReplica.replica, fromReplica.skipped, fromReplica.supply, fromReplica.force.length],
      ["final", "replica", `http://${REPLICA}/`, [{ url: `http://${DOWN}/`, code: "UNAVAILABLE" }], forced.supply, 1]);
    const acceptance = join(scratch, "gap.acceptance");
    await ok(wallet("accept", BK, "gap-answer", backing, shown.demand, "--deadline", String(BigInt(shown.deadline) - 10n), "--out", acceptance));
    await ok(wallet("publish-acceptance", BK, "gap-answer", backing, "--out", join(scratch, "gap-answer.json")));
    await ok(["relay", "publish", "--dir", RL, join(scratch, "gap-answer.json")]);
    await settled(["relay", "publish", "--dir", RL, join(scratch, "gap-answer.json")], out => out.status === "final");
    await ok(wallet("settle", HD, "gap-settle", backing, "--acceptance", acceptance));
    const release = join(scratch, "gap-settle.json");
    await ok(wallet("publish", HD, "gap-settle", backing, "--out", release));
    assert.equal((await ok(["relay", "send", release, "--to", relayFile])).status, "pending");
    await settled(wallet("sync", HD, backing), view => view.holdings.length === 0);
    assert.equal((await ok(wallet("status", HD, "gap-settle"))).status, "final");
    // C3.8 by force on the kept package: the forced settlement reads its forced demand's notes (lit-v1 §3) and ends it;
    // the published acceptance and the release carrying it are one answer.
    const byForce = await settled(["reader", "presentation", "--dir", RD, "--package", packageFile, backing, shown.demand],
      out => out.ended?.by === "settlement");
    assert.deepEqual([byForce.status, byForce.acceptances.length, byForce.acceptances[0].taken], ["final", 1, false]);
    assert.equal((await ok(wallet("presentation", HD, backing, shown.demand))).ended.by, "settlement");
    await ok(["operator", "return", "--dir", OP, "--id", "return-1", "--poll-ms", POLL], { mining: "waiting" });
    const adopted = await ok(["operator", "adopt", "--dir", OP, "--poll-ms", POLL], { mining: "waiting" });
    assert.equal(adopted.status, "final");
    serving = serve(OP);
    await serving.listening;
    for (const directory of [BK, HD, SH]) await ok(wallet("service add", directory, backing, join(OP, "holders.json")));
    await ok(["reader", "service", "add", "--dir", RD, backing, join(OP, "holders.json")]);
    // The settlement paid K's acceptance key: the backer finds the settled note, as outside the gap.
    const backer = await settled(wallet("sync", BK, backing), view => view.status === "final" && !view.gap && view.holdings.length > 0);
    assert.deepEqual(holdings(backer), [["5", "available", 0]]);
    const read = await settled(["reader", "supply", "--dir", RD, backing], out => out.status === "final");
    assert.deepEqual([read.issued, read.burned, read.supply], ["10", "3", "7"]);
    // With the operator back, the holder reads its service first; the replica follows the return.
    assert.equal((await ok(wallet("sync", HD, backing))).evidence, "served");
    await settled(["reader", "supply", "--dir", RF, backing], out => out.status === "final" && out.supply === "7");
    await replica.stop();
    // A relay refuses a file for another venue, published or handed to it; the served relay published from its own key alone.
    const other = JSON.parse(readFileSync(release, "utf8")); other.venue = "00".repeat(32);
    writeFileSync(join(scratch, "other-venue.json"), JSON.stringify(other));
    await refused(["relay", "publish", "--dir", RL, join(scratch, "other-venue.json")], "VENUE");
    await refused(["relay", "send", join(scratch, "other-venue.json"), "--to", relayFile], "VENUE");
    assert.equal((await ok(["relay", "send", release, "--to", relayFile])).status, "final");
    await relaying.stop();
  });

  await check("a handoff restores the shop's wallet; a seed restoration finds its holdings, moves its full window and requests again", async () => {
    const { seed } = await ok(wallet("seed", SH, "--show"));
    const before = holdings(await ok(wallet("sync", SH, backing)));
    // Its first invoice was redeemed to K; the second remains.
    assert.deepEqual(before, [["2", "available", 0]]);
    const key = join(scratch, "handoff.key"), out = join(scratch, "handoff.bin");
    const frozen = await ok(wallet("handoff", SH, "--key", key, "--out", out));
    await refused(wallet("sync", SH, backing), "FENCED");
    // Under the other construction the handoff does not open: refused by name before any directory is made.
    await refused(["wallet", "restore", "--dir", H3, "--venue", venueFile, ...nodeArgs, "--key", key, "--backup", out, "--digest", frozen.digest], "CONSTRUCTION");
    assert(!existsSync(H3), "a refused restore leaves no directory");
    await ok(["wallet", "restore", "--dir", H3, "--venue", venueFile, ...nodeArgs, ...LIT, "--key", key, "--backup", out, "--digest", frozen.digest]);
    await ok(wallet("terms add", H3, backing, "--terms", termsFile, "--signature", signatureFile, ...SYN));
    await ok(wallet("service add", H3, backing, join(OP, "holders.json")));
    assert.deepEqual(holdings(await ok(wallet("sync", H3, backing))), before);
    assert.deepEqual((await ok(wallet("fulfillment", H3, "invoice"))).value, "3", "the handoff carries the fulfillments");
    // A second copy of the seed, for the drill only (one active copy is the holder's precondition).
    const seeded = await ok(["wallet", "restore-seed", "--dir", H2, "--venue", venueFile, ...nodeArgs, ...LIT], { input: `${seed}\n` });
    // Its first sync exposes through h + 256 and later ones raise that until it names a key (lit-v1 §8, Next 4 (bc)).
    assert.match(seeded.notes?.[0] ?? "", /each later sync raises that until the wallet names a key/);
    await ok(wallet("terms add", H2, backing, "--terms", termsFile, "--signature", signatureFile, ...SYN));
    await ok(wallet("service add", H2, backing, join(OP, "holders.json")));
    assert.deepEqual(holdings(await ok(wallet("sync", H2, backing))), before);
    // Restored from its seed alone, every index through h + 256 reads as exposed (lit-v1 §8): the window is full.
    await refused(wallet("request", H2, "after", backing, "1"), "WINDOW");
    const moved = await ok(wallet("move-window", H2, "move-1", backing));
    assert.deepEqual([moved.kind, moved.status, moved.value], ["payment", "pending", "2"]);
    await finalOf(H2, "move-1");
    assert.deepEqual(holdings(await ok(wallet("sync", H2, backing))), before);
    // That move, prepared from a checkpoint its first sync had, may be the last instance's own and counts (Next 4 (bc)):
    // the window is full again until a second move, prepared after it.
    await refused(wallet("request", H2, "after", backing, "1"), "WINDOW");
    await ok(wallet("move-window", H2, "move-2", backing));
    await finalOf(H2, "move-2");
    await ok(wallet("sync", H2, backing));
    const after = await ok(wallet("request", H2, "after", backing, "1"));
    assert.equal(after.status, "saved");
    // The handoff's wallet, still running, reads that window move: an own key paid above every index it exposed, so
    // another instance of its seed acted (M13f). It acts on nothing until its owner records it as the only instance;
    // the seed restoration is retired here.
    const forked = await ok(wallet("sync", H3, backing));
    assert.match(forked.forked, /pays its owner key at index \d+, above every index this wallet exposed/);
    await refused(wallet("request", H3, "next", backing, "1"), "FORKED");
    assert.equal((await ok(["wallet", "restore", "--copy", "--dir", H3])).copied, false);
    assert.equal((await ok(wallet("sync", H3, backing))).forked, undefined);
    for (const name of ["move-h3", "move-h3-2"]) {
      await ok(wallet("move-window", H3, name, backing));
      await finalOf(H3, name);
      await ok(wallet("sync", H3, backing));
    }
    // A wallet whose window still takes new keys has none to move.
    assert.match((await refused(wallet("move-window", HD, "move-0", backing), "CONFLICT")).message, /window is not full/);
  });

  await check("a wallet, a reader and a relay restored from backups of their directories (M13e): the wallet acts on nothing until " +
    "its restoration is recorded, then never names a key its lost instance exposed and refuses a request that instance may have " +
    "credited; the reader reads and the relay publishes again; venue audit finds a view changed in place", async () => {
    const backups = join(scratch, "backups"); mkdirSync(backups);
    const backup = directory => { const to = join(backups, basename(directory)); cpSync(directory, to, { recursive: true }); return to; };
    // T0: the shop's invoice is out, and the owners back up the shop's wallet, the reader and the relay.
    const invoice = await request(H3, "invoice-3", 1);
    const saved = [[H3, backup(H3)], [RD, backup(RD)], [RL, backup(RL)]];
    // Past T0 the shop's lost instance gives another request a key, is paid the invoice and credits it.
    const lost = await request(H3, "order-A", 1);
    await ok(wallet("pay", BK, "pay-3", backing, ...invoice.args, "--value", "1"));
    await finalOf(BK, "pay-3");
    assert.equal((await settled(wallet("fulfill", H3, "invoice-3", backing), () => true)).value, "1");
    const current = await supply();
    // The originals are lost; each backup is restored in its place (the lost directories are kept aside, so the copies'
    // files are new ones).
    for (const [directory, from] of saved) {
      renameSync(directory, `${directory}-lost`); cpSync(from, directory, { recursive: true }); chmodSync(directory, 0o700);
    }
    await refused(wallet("request", H3, "order-B", backing, "1"), "COPIED");
    const restored = await ok(["wallet", "restore", "--copy", "--dir", H3]);
    assert.deepEqual([restored.status, restored.copied, restored.requests], ["restored", true, ["invoice-3"]]);
    assert.match(restored.notes.join(" "), /move-window before new requests/);
    await refused(wallet("fulfill", H3, "invoice-3", backing), "RESTORED");
    // Its next read exposes every key through h + 256 (lit-v1 §8): the key order-A took is never named again.
    await ok(wallet("sync", H3, backing));
    await refused(wallet("request", H3, "order-B", backing, "1"), "WINDOW");
    for (const name of ["move-2", "move-3"]) {
      await ok(wallet("move-window", H3, name, backing));
      await finalOf(H3, name);
      await ok(wallet("sync", H3, backing));
    }
    const next = await request(H3, "order-B", 1);
    assert.notEqual(next.made.frame.slice(-64), lost.made.frame.slice(-64));
    // The reader's copied view is audited as it opens and its copied replay file read again: the same supply.
    const read = await supply();
    assert.deepEqual([read.status, read.issued, read.burned, read.supply], [current.status, current.issued, current.burned, current.supply]);
    // A view changed in place keeps its file: reopening checks only what is cheap, and venue audit reads every row.
    const audited = await ok(["venue", "audit", "--dir", RD]);
    assert.deepEqual([audited.status, audited.role], ["audited", "reader"]);
    assert(BigInt(audited.objects) > 0n, JSON.stringify(audited));
    const view = new DatabaseSync(join(RD, "venue.db"));
    view.exec("UPDATE objects SET record=zeroblob(length(record)) WHERE idx=(SELECT min(idx) FROM objects)"); view.close();
    assert.match((await refused(["venue", "audit", "--dir", RD], "AUDIT")).message, /Ergo view audit: section \d+'s objects are not those it attributes/);
    // Its remedy: remove the view, which syncs again from the anchor.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(RD, `venue.db${suffix}`), { force: true });
    assert.equal((await supply()).supply, current.supply);
    assert.equal((await ok(["venue", "audit", "--dir", RD])).status, "audited");
    // The restored relay answers a publication it made before as final, from its own view.
    assert.equal((await ok(["relay", "publish", "--dir", RL, join(scratch, "answer.json")])).status, "final");
    await serving.stop();
  });

  await check("holders reached the operator only as an onion service, through the proxy", async () => {
    assert(tor.tunnels > 30, `${tor.tunnels} tunnels`);
    assert.deepEqual(tor.refused, []);
  });

  await check("no lit process loads a @noir-lang module", async () => {
    const ended = processes.filter(p => p.noir !== null);
    assert(ended.length > 40, `${ended.length} processes recorded`);
    for (const p of ended) assert.equal(p.noir, false, `${p.command} loaded @noir-lang`);
  });

  await check("every party ran from its own install of one release, which the shop's restorations opened on a new machine, and " +
    "resolved no module outside it (a dependency removed from one install is named)", async () => {
    const bins = Object.values(parties).map(party => realpathSync(party.bin));
    assert.equal(new Set(bins).size, Object.keys(MACHINES).length);
    for (const bin of bins) assert(!bin.startsWith(root + sep + "dist" + sep) && !bin.startsWith(root + sep + "node_modules" + sep), bin);
    for (const party of Object.keys(MACHINES)) assert(processes.some(p => p.party === party && p.status === 0), `${party} ran no command`);
    assert.deepEqual(strays, [], "a party's process resolved a module outside its own install");
    // Hostile: a dependency missing from the reader's install, which Node's resolution finds in the checkout's
    // node_modules above the machine, is named.
    rmSync(join(scratch, "machines", "reader", "install", "node_modules", "@noble", "hashes"), { recursive: true });
    await moe(["reader", "supply", "--dir", RD, backing]);
    const checkout = `${pathToFileURL(join(root, "node_modules")).href}/@noble/hashes/`;
    assert(strays.length > 0 && strays.every(stray => stray.startsWith("reader supply: ") && stray.includes(checkout)), JSON.stringify(strays));
  });

  console.log(JSON.stringify({ status: "passed", release: { tarball: release.tarball.integrity, installLock: release.installLock.sha256 },
    parties: Object.keys(MACHINES), checks, processes: processes.length }, null, 2));
  completed = true;
} finally {
  for (const child of servers) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(done => child.once("close", done)); child.kill("SIGTERM"); await exited;
  }
  await node.close();
  await new Promise(done => { torProxy.closeAllConnections(); torProxy.close(done); });
  if (completed) { assert(scratch.startsWith(realpathSync(join(root, "scratch")) + sep)); rmSync(scratch, { recursive: true, force: true }); }
  else process.stderr.write(`lit command drill scratch retained after failure: ${scratch}\n`);
}
