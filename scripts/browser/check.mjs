// The browser host in a browser engine (slice 39): build the in-browser checks over the browser bundle's substitutes,
// serve them on loopback, cross-origin isolated, to a headless Chromium (Chrome or Edge) driven over the DevTools
// protocol, and judge what the worker reports.
//   --suites  the library's succinct-read, scope-reader, state-machine and capsule suites (suites.mjs): every test
//             passes. No proof; part of `npm run check:browser`.
//   --proofs  the pinned backend, key derivation, a genuine proof of each kind, a tampered proof, a spend proved and
//             verified, and a restore's capsule scan (proofs.mjs), with times and memory. CI's real-proof group
//             `browser` runs it.
//   --throttle <rate>  slow the page and every worker's CPU by <rate> (DevTools' CPU throttling), as a slower device.
//   --browser <path>   the engine (default: MOE_BROWSER, else Chrome or Edge where installed).
//   --parameters <dir> the proving parameters (default scratch/private-payment-crs, as prepare-crs.mjs keeps them).
//   --report <file>    where the result is written as JSON (default scratch/browser-<check>.json).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { bundle, root } from "./build.mjs";

const PAGE = `<!doctype html><meta charset="utf-8"><title>moe browser check</title><script type="module">
const worker = new Worker(new URL(location.hash.slice(1) + ".js", location.href), { type: "module" });
const post = body => fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
worker.onerror = event => post({ error: "the worker failed: " + (event.message || "it did not start") + " " + (event.filename || "") + ":" + (event.lineno || "") });
worker.onmessage = async event => {
  const id = event.data && event.data.measure;
  if (id === undefined) return;
  let memory;
  try { if (crossOriginIsolated && performance.measureUserAgentSpecificMemory) memory = (await performance.measureUserAgentSpecificMemory()).bytes; } catch {}
  worker.postMessage({ id, memory });
};
</script>`;

function parse(argv) {
  const options = { check: "suites", throttle: 1, browser: process.env.MOE_BROWSER, parameters: join(root, "scratch/private-payment-crs"), report: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--suites" || arg === "--proofs") options.check = arg.slice(2);
    else if (arg === "--throttle" && i + 1 < argv.length) options.throttle = Number(argv[++i]);
    else if (["--browser", "--parameters", "--report"].includes(arg) && i + 1 < argv.length) options[arg.slice(2)] = resolve(argv[++i]);
    else throw new Error(`browser check: unknown or incomplete option ${arg}`);
  }
  if (!(options.throttle >= 1)) throw new Error("browser check: --throttle takes a rate of 1 or more");
  options.report ??= join(root, `scratch/browser-${options.check}${options.throttle > 1 ? `-x${options.throttle}` : ""}.json`);
  return options;
}

/** A Chromium-based engine: the one named, else Chrome, else Edge. */
function findBrowser(named) {
  if (named !== undefined) return named;
  const env = process.env, candidates = process.platform === "win32" ? [
    `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, `${env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ] : process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ] : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].map(name =>
    spawnSync("which", [name], { encoding: "utf8" }).stdout?.trim()).filter(Boolean);
  const found = candidates.find(path => path && existsSync(path));
  if (found === undefined) throw new Error("browser check: no Chrome or Edge found; name one with --browser or MOE_BROWSER");
  return found;
}

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".html": "text/html" };

/** The leading `length` bytes of a file. */
function leading(path, length) {
  const fd = openSync(path, "r"), buffer = Buffer.alloc(length);
  try { if (readSync(fd, buffer, 0, length, 0) !== length) throw new Error(`${path} is shorter than ${length} bytes`); } finally { closeSync(fd); }
  return buffer;
}

function serve(directory, parameters, log) {
  let settle;
  const result = new Promise(resolve => { settle = resolve; });
  const server = createServer((request, response) => {
    const send = (status, body, type = "text/plain") => {
      response.writeHead(status, { "content-type": type, "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin", "cache-control": "no-store" });
      response.end(body);
    };
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk)).on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = { error: "an unreadable report" }; }
        send(204, "");
        if (url.pathname === "/progress") log(body);
        else if (url.pathname === "/result") settle(body);
      });
      return;
    }
    try {
      if (url.pathname === "/") return send(200, PAGE, "text/html");
      if (url.pathname === "/parameters/g1") return send(200, leading(join(parameters, "bn254_g1.dat"), 64 * 32768), "application/octet-stream");
      if (url.pathname === "/parameters/g2") return send(200, leading(join(parameters, "bn254_g2.dat"), 128), "application/octet-stream");
      const name = url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(name) || !existsSync(join(directory, name))) return send(404, "absent");
      return send(200, readFileSync(join(directory, name)), TYPES[extname(name)] ?? "application/octet-stream");
    } catch (error) { return send(500, String(error)); }
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, result })));
}

/** A DevTools protocol connection over the browser's own endpoint, with flattened sessions. */
async function devtools(endpoint, onEvent) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("browser check: no DevTools connection")); });
  let next = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else waiter?.resolve(message.result);
    } else onEvent(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });
  return { send, close: () => socket.close() };
}

async function main() {
  const options = parse(process.argv.slice(2)), started = Date.now();
  const log = line => console.log(`browser check: ${typeof line === "string" ? line : JSON.stringify(line)}`);
  const out = join(root, "scratch/browser-check");
  const shim = { name: "vitest-shim", setup(build) { build.onResolve({ filter: /^vitest$/ }, () => ({ path: join(root, "scripts/browser/vitest-shim.mjs") })); } };
  const entry = options.check;
  const { code } = await bundle([{ in: join(root, `scripts/browser/${entry}.mjs`), out: entry }], out, [shim]);
  log({ built: entry, code, seconds: (Date.now() - started) / 1000 });
  if (entry === "proofs" && !existsSync(join(options.parameters, "bn254_g1.dat"))) {
    throw new Error(`browser check: no proving parameters in ${options.parameters}; run scripts/pool/prepare-crs.mjs`);
  }

  const { server, port, result } = await serve(out, options.parameters, log);
  const executable = findBrowser(options.browser), profile = mkdtempSync(join(tmpdir(), "moe-browser-"));
  const browser = spawn(executable, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--enable-blink-features=ForceEagerMeasureMemory",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank",
  ], { stdio: "ignore" });
  let connection;
  try {
    const portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; !existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2; i++) {
      if (i > 300 || browser.exitCode !== null) throw new Error(`browser check: ${executable} did not open DevTools`);
      await new Promise(r => setTimeout(r, 100));
    }
    const [devPort, path] = readFileSync(portFile, "utf8").split("\n");
    const throttled = [];
    connection = await devtools(`ws://127.0.0.1:${devPort}${path}`, async message => {
      // Every worker, bb.js's own included, waits at its start until throttled and itself watched for workers.
      if (message.method !== "Target.attachedToTarget") return;
      const session = message.params.sessionId, type = message.params.targetInfo.type;
      try { await connection.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session); } catch {}
      if (options.throttle > 1) {
        try { await connection.send("Emulation.setCPUThrottlingRate", { rate: options.throttle }, session); throttled.push(type); }
        catch (error) { throttled.push(`${type} (refused: ${error.message})`); }
      }
      try { await connection.send("Runtime.runIfWaitingForDebugger", {}, session); } catch {}
    });
    const version = await connection.send("Browser.getVersion");
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    await connection.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    if (options.throttle > 1) { await connection.send("Emulation.setCPUThrottlingRate", { rate: options.throttle }, sessionId); throttled.push("page"); }
    await connection.send("Page.navigate", { url: `http://127.0.0.1:${port}/#${entry}` }, sessionId);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("browser check: no result within 25 minutes")), 25 * 60_000).unref());
    const outcome = await Promise.race([result, timeout]);
    const report = { check: entry, browser: version.product, userAgent: version.userAgent, platform: process.platform, throttle: options.throttle,
      throttled, code, seconds: (Date.now() - started) / 1000, ...outcome };
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    return judge(report, log);
  } finally {
    connection?.close();
    browser.kill();
    server.close();
    await new Promise(r => setTimeout(r, 500));
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Whether the worker's report shows every check passing; prints what failed. */
function judge(report, log) {
  const failures = [];
  if (report.error) failures.push(report.error);
  if (report.check === "suites" && !report.error) {
    for (const r of report.results.filter(r => r.state === "fail")) failures.push(`${r.name}\n${r.error}`);
    if (report.counts.pass === 0) failures.push("no test ran");
    log({ suites: report.counts, ms: report.ms });
  }
  if (report.check === "proofs" && !report.error) {
    const c = report.checks;
    if (Object.keys(c.genuine ?? {}).length !== 5 || !Object.values(c.genuine).every(v => v === true)) failures.push(`a genuine proof did not verify: ${JSON.stringify(c.genuine)}`);
    if (c.tampered !== false) failures.push("a tampered spend proof verified");
    if (c.spendVerifies !== true || c.spendProofBytes !== 14656) failures.push(`the proved spend: ${c.spendProofBytes} bytes, verifies ${c.spendVerifies}`);
    if (c.capsulesFound !== 1000) failures.push(`the capsule scan found ${c.capsulesFound} of 1000`);
    log({ phases: report.phases, checks: { ...c, genuine: undefined } });
  }
  for (const failure of failures) console.error(`browser check: FAILED ${failure}`);
  log(`${failures.length === 0 ? "passed" : "failed"} in ${report.browser}, throttle ${report.throttle} (${report.throttled.join(", ") || "none"}), ${report.seconds.toFixed(1)} s; report ${report.check}`);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
