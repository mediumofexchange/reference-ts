// Our own Ergo nodes, mainnet and testnet, run from the official release bundle in ignored scratch/. A practical
// source for the experiments (own pool view, own submissions, headers whose proof of work this node checked), not a
// contained or qualified deployment: no runtime path reads it, and no answer selects a venue. The host is sometimes
// off; `start` resumes each node from its data directory.
//
// Usage, from the repository root on Node 24:
//   node experiments/ergo-range/nodes.mjs start [mainnet|testnet]    (both when omitted)
//   node experiments/ergo-range/nodes.mjs stop [mainnet|testnet]
//   node experiments/ergo-range/nodes.mjs status [mainnet|testnet]
//   node experiments/ergo-range/nodes.mjs watch [minutes]    appends both nodes' status to scratch/ergo-nodes/status.jsonl
// Bundle: the official ergo-node-v6.0.6-windows-x64.zip (108,925,914 bytes, SHA-256 311c0b1b…82c5) extracted to
// scratch/ergo-nodes/v6.0.6/; the JAR is checked against the release digest before every start.
//
// Mainnet: a UTXO-set snapshot bootstrap (6.0.6 fixes its restart and NiPoPoW paths) with the full header chain from
// genesis, not a NiPoPoW proof, so every header's proof of work is checked here; full blocks from the snapshot on, the
// last 50,000 kept. Testnet: a full archive with the extra index (the publication experiment's /blockchain reads).
// Both APIs and P2P listeners are bound to 127.0.0.1 (outbound peers only, no inbound firewall rule). v6.0.6 answers
// every request with Access-Control-Allow-Origin "*" whatever corsAllowedOrigin says (CorsHandler and ErgoHttpService
// hardcode it), so a page in a local browser can read the API and use its key-free routes (reads, submitting a
// transaction); key-protected routes need the key. Mining is off and no wallet is initialized; the API
// key is random and kept in scratch/.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { blake2b } from "@noble/hashes/blake2b";

const here = import.meta.dirname, root = resolve(here, "../..");
const base = join(root, "scratch/ergo-nodes"), bundle = join(base, "v6.0.6");
const JAR = "ergo-6.0.6.jar", JAR_SHA256 = "21b9023933b19b98b7eb4d50cb78bcb6c827a0fe65711a00ceaf1b83f8f3a323";
const NETWORKS = {
  mainnet: { flag: "--mainnet", api: 9053, p2p: 9030, heap: "4G", node: `
    stateType = "utxo"
    blocksToKeep = 50000
    utxo { utxoBootstrap = true }
    nipopow { nipopowBootstrap = false }
    extraIndex = false` },
  testnet: { flag: "--testnet", api: 9052, p2p: 9023, heap: "2G", node: `
    stateType = "utxo"
    blocksToKeep = -1
    extraIndex = true` },
};
const [command = "status", only] = process.argv.slice(2);
assert(["start", "stop", "status", "watch"].includes(command) && (only === undefined || only in NETWORKS || command === "watch"), "usage: nodes.mjs start|stop|status [mainnet|testnet] | watch [minutes]");
const selected = only === undefined || command === "watch" ? Object.keys(NETWORKS) : [only];
const hocon = path => JSON.stringify(path.replaceAll("\\", "/"));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function prepare(name) {
  const net = NETWORKS[name], dir = join(base, name);
  mkdirSync(join(dir, "data"), { recursive: true });
  const keyFile = join(dir, "api-key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(24).toString("hex"));
  const key = readFileSync(keyFile, "utf8").trim();
  const keyHash = Buffer.from(blake2b(Buffer.from(key, "utf8"), { dkLen: 32 })).toString("hex");
  writeFileSync(join(dir, "ergo.conf"), `ergo {
  directory = ${hocon(join(dir, "data"))}
  node {
    mining = false${net.node}
  }
}
scorex {
  logDir = ${hocon(join(dir, "log"))}
  logging {
    level = "WARN"
  }
  restApi {
    bindAddress = "127.0.0.1:${net.api}"
    apiKeyHash = "${keyHash}"
  }
  network {
    bindAddress = "127.0.0.1:${net.p2p}"
  }
}
`);
  return { dir, key };
}

async function api(name, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${NETWORKS[name].api}${path}`, { signal: AbortSignal.timeout(10000), ...options });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = name => { const file = join(base, name, "pid"); return existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined; };
// The node process's working set, private bytes and CPU seconds, read from Windows' process table.
const usage = pid => {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `$p = Get-Process -Id ${Number(pid)}; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $([math]::Round($p.CPU))"`], { encoding: "utf8", windowsHide: true });
    const [workingSet, privateBytes, cpuSeconds] = out.trim().split(" ").map(Number);
    return { workingSet, privateBytes, cpuSeconds };
  } catch { return null; }
};
// A database compacts while it is measured, so a file listed can be gone when read.
const sizeOf = file => { try { return statSync(file).size; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } };
const bytesUnder = dir => { let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  return entries.reduce((n, e) => n + (e.isDirectory() ? bytesUnder(join(dir, e.name)) : sizeOf(join(dir, e.name))), 0); };

// A large stdout log is kept once as stdout.old.log before a start, so the log stays bounded across restarts.
function rotate(dir) {
  const log = join(dir, "stdout.log");
  if (existsSync(log) && statSync(log).size >= 64 * 2 ** 20) renameSync(log, join(dir, "stdout.old.log"));
}

async function start(name) {
  const pid = pidOf(name);
  if (pid !== undefined && alive(pid)) return console.log(`${name}: already running (pid ${pid})`);
  const jarHash = createHash("sha256").update(readFileSync(join(bundle, JAR))).digest("hex");
  assert.equal(jarHash, JAR_SHA256, "the node JAR is the v6.0.6 release");
  const { dir } = prepare(name), net = NETWORKS[name];
  rotate(dir);
  const out = openSync(join(dir, "stdout.log"), "a");
  const child = spawn(join(bundle, "jre/bin/java.exe"), [`-Xmx${net.heap}`, "-jar", join(bundle, JAR), net.flag, "-c", join(dir, "ergo.conf")],
    { cwd: dir, detached: true, windowsHide: true, stdio: ["ignore", out, out] });
  writeFileSync(join(dir, "pid"), String(child.pid));
  child.unref();
  console.log(`${name}: started (pid ${child.pid}), API http://127.0.0.1:${net.api}`);
}

async function stop(name) {
  const pid = pidOf(name);
  if (pid === undefined || !alive(pid)) return console.log(`${name}: not running`);
  const { key } = prepare(name);
  // The node's own shutdown closes its databases cleanly; the process is killed only if it does not exit.
  try { await api(name, "/node/shutdown", { method: "POST", headers: { api_key: key } }); } catch (error) { console.log(`${name}: shutdown request failed (${error.message})`); }
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(1000);
  if (alive(pid)) { process.kill(pid); console.log(`${name}: killed after 60 s`); } else console.log(`${name}: stopped`);
}

async function status(name, print = true) {
  const pid = pidOf(name), dir = join(base, name);
  const row = { network: name, pid: pid ?? null, running: pid !== undefined && alive(pid), dataBytes: bytesUnder(join(dir, "data")) };
  if (row.running) row.process = usage(pid);
  try {
    const info = await api(name, "/info");
    Object.assign(row, { appVersion: info.appVersion, headersHeight: info.headersHeight, fullHeight: info.fullHeight,
      peers: info.peersCount, unconfirmed: info.unconfirmedCount, stateType: info.stateType, lastSeenMessageTime: info.lastSeenMessageTime });
  } catch (error) { row.api = String(error.message ?? error).slice(0, 120); }
  if (print) console.log(JSON.stringify(row));
  return row;
}

// Sync evidence: one line per sample with both nodes' heights, peers, data bytes and process usage; stops when both
// are gone.
async function watch() {
  const minutes = Number(only ?? "10"), log = join(base, "status.jsonl");
  assert(minutes > 0, "watch [minutes]");
  for (;;) {
    const rows = []; for (const name of selected) rows.push(await status(name, false));
    writeFileSync(log, JSON.stringify({ at: new Date().toISOString(), nodes: rows }) + "\n", { flag: "a" });
    if (rows.every(r => !r.running)) return;
    await sleep(minutes * 60000);
  }
}

if (command === "watch") await watch();
else for (const name of selected) await { start, stop, status }[command](name);
