// The browser host in a browser engine (slice 39): build the in-browser checks over the browser bundle's substitutes,
// serve them on loopback, cross-origin isolated, to a headless Chromium (Chrome or Edge) driven over the DevTools
// protocol, and judge what the worker reports.
//   --suites  the library's primitive, record, trail, succinct-read, scope-reader, state-machine and capsule suites
//             (suites.mjs): every test passes, and no rejection goes unhandled. Then, on a page served without the
//             isolation headers, the library's Poseidon2 refuses to start (isolation.mjs, packaged-binary.ts). No
//             proof; part of `npm run check:browser`.
//   --proofs  the pinned backend, key derivation, a genuine proof of each kind, a tampered proof, a spend proved and
//             verified, and a restore's capsule scan (proofs.mjs), with times and memory. CI's real-proof group
//             `browser` runs it. On Linux the browser's processes' peak resident memory is sampled from outside too.
//   --rates   the holder's JavaScript workloads (rates.mjs, slice 46): proof-free replay of a journal's package, succinct
//             reading's digests and the Ergo header store's checks, each timed per statement or header.
// DevTools' CPU throttling reaches pages, not workers ("only supported for pages", Chrome 154), and every check runs
// in workers; throttle.mjs (slice 46) runs these checks with the browser in a CPU-quota and memory-capped group
// instead, a simulated slower core, not a phone.
//   --files   the library's suites that keep database files (files.mjs: kept replay files, retained evidence, the
//             wallet's files) with the worker's file pool mounted (files.ts); then a crash: a worker keeping a replay
//             file is ended mid-walk, and a new worker must reopen the file through §14's digest check at its last
//             keep point, while a third worker's mount is refused by name (crash.mjs). Part of `npm run check:browser`.
//   --wallet  the wallet's flows (wallet-drill.mjs, slice 41): a holder's `moe wallet` commands in the holder's page
//             (src/browser/wallet.html), each in a command worker over the origin's file pool, with real proofs, against
//             an operator, a backer and a shop running `moe` as processes over the synthetic node: init, request,
//             receive, pay, restore from the seed. The page's worker reaches their loopback ports through this server
//             (`/via/<port>/`, wallet-worker.mjs), standing in for a wrapped app's native transport. CI's real-proof
//             group `browser` runs it (after `npm run build`).
//   --browser <path>   the engine (default: MOE_BROWSER, else Chrome or Edge where installed, else Playwright's).
//   --connect <url> [--port <n>]  launch no browser: drive one already running whose DevTools endpoint answers at
//             <url> (such as a phone's Chrome through `adb forward tcp:9222 localabstract:chrome_devtools_remote`, with
//             `adb reverse tcp:<n> tcp:<n>` for this server), in a new tab closed at the end; every check, --wallet
//             among them, runs as it does in a browser launched here, without the browser's memory sampled from outside.
//   --serve [--port <n>]  launch no browser: serve the check on 127.0.0.1:<n> and judge the first result a browser
//             posts, such as a phone's Chrome reaching it through `adb reverse tcp:<n> tcp:<n>` (a secure context, as
//             cross-origin isolation needs). The address printed carries the run's token, which every post must.
//   --parameters <dir> the proving parameters (default scratch/private-payment-crs, as prepare-crs.mjs keeps them).
//   --report <file>    where the result is written as JSON (default scratch/browser-<check>.json).
//   --minutes <n>      how long the check may run before it fails (default 25; a throttled run needs more).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { bundle, root } from "./build.mjs";

/** The page: it starts the check's worker, relays memory measurements to it, and reports a worker that fails. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>moe browser check</title><script type="module">
const token = new URLSearchParams(location.search).get("t");
const worker = new Worker(new URL(location.hash.slice(1) + ".js?t=" + token, location.href), { type: "module" });
const post = body => fetch("/result", { method: "POST", headers: { "content-type": "application/json", "x-moe-token": token }, body: JSON.stringify(body) });
worker.onerror = event => post({ kind: location.hash.slice(1), error: "the worker failed: " + (event.message || "it did not start") + " " + (event.filename || "") + ":" + (event.lineno || "") });
worker.onmessage = async event => {
  const id = event.data && event.data.measure;
  if (id === undefined) return;
  let memory;
  try { if (crossOriginIsolated && performance.measureUserAgentSpecificMemory) memory = (await performance.measureUserAgentSpecificMemory()).bytes; } catch {}
  worker.postMessage({ id, memory });
};
</script>`;

function parse(argv) {
  const options = { check: "suites", serve: false, port: 0, browser: process.env.MOE_BROWSER, parameters: join(root, "scratch/private-payment-crs"), report: undefined, minutes: 25 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--suites", "--proofs", "--files", "--wallet", "--rates"].includes(arg)) options.check = arg.slice(2);
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--port" && i + 1 < argv.length) options.port = Number(argv[++i]);
    else if (arg === "--minutes" && i + 1 < argv.length) options.minutes = Number(argv[++i]);
    else if (arg === "--connect" && i + 1 < argv.length) options.connect = argv[++i].replace(/\/+$/, "");
    else if (["--browser", "--parameters", "--report"].includes(arg) && i + 1 < argv.length) options[arg.slice(2)] = resolve(argv[++i]);
    else throw new Error(`browser check: unknown or incomplete option ${arg}`);
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("browser check: --port takes a port number");
  if (options.connect !== undefined && (options.serve || options.port === 0)) throw new Error("browser check: --connect takes a --port the browser reaches, and no --serve");
  if (!Number.isSafeInteger(options.minutes) || options.minutes < 1) throw new Error("browser check: --minutes takes a whole number of minutes");
  options.report ??= join(root, `scratch/browser-${options.check}.json`);
  return options;
}

/** A Chromium-based engine: the one named, else Chrome, else Edge, else Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH). */
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
  if (env.PLAYWRIGHT_BROWSERS_PATH) candidates.push(join(env.PLAYWRIGHT_BROWSERS_PATH, "chromium"));
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

/** The crash page (--files): three workers in turn on one file pool, each reporting by POST itself; a worker that fails
 * to start is reported here. */
const CRASH_PAGE = `<!doctype html><meta charset="utf-8"><title>moe crash check</title><script type="module">
const token = new URLSearchParams(location.search).get("t");
const step = (query, until) => new Promise(resolve => {
  const worker = new Worker(new URL("crash.js?t=" + token + "&" + query, location.href), { type: "module" });
  worker.onmessage = event => { if (event.data && (until in event.data || event.data.failed)) resolve({ worker, data: event.data }); };
  worker.onerror = event => {
    fetch("/result", { method: "POST", headers: { "content-type": "application/json", "x-moe-token": token },
      body: JSON.stringify({ kind: "crash-" + new URLSearchParams(query).get("phase"), error: "the worker failed: " + (event.message || "it did not start") }) });
    resolve({ worker, data: { failed: true } });
  };
});
const write = await step("phase=write", "held");
write.worker.terminate();
const reopen = await step("phase=reopen&ns=" + write.data.held, "holding");
const second = await step("phase=second", "done");
reopen.worker.terminate(); second.worker.terminate();
const race = await Promise.all([step("phase=race&n=1", "done"), step("phase=race&n=2", "done")]);
for (const { worker } of race) worker.terminate();
</script>`;

/**
 * Serve `directory` and the proving parameters on loopback. Everything is served cross-origin isolated, except under
 * `/plain/`, which serves the same files without the isolation headers. A post counts only with the run's token: a
 * progress line is logged, and each result is handed to the next `result()`.
 */
function serve(directory, parameters, log, port, token, routes = new Set()) {
  const results = [], waiting = [];
  const deliver = body => { const next = waiting.shift(); if (next) next(body); else results.push(body); };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"), plain = url.pathname.startsWith("/plain/");
    const path = plain ? url.pathname.slice("/plain".length) : url.pathname;
    const send = (status, body, type = "text/plain") => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store", ...(plain ? {} : {
        "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cross-origin-resource-policy": "same-origin" }) });
      response.end(body);
    };
    const via = /^\/via\/([0-9]{1,5})(\/.*)$/.exec(url.pathname);
    if (via !== null) {
      if (!routes.has(Number(via[1]))) { request.resume(); return send(404, "no such route"); }
      return forward(request, response, Number(via[1]), `${via[2]}${url.search}`);
    }
    if (request.method === "POST") {
      if (request.headers["x-moe-token"] !== token) { request.resume(); return send(403, "refused"); }
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk)).on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = { error: "an unreadable report" }; }
        send(204, "");
        if (path === "/progress") log(body);
        else if (path === "/result") deliver(body);
      });
      return;
    }
    try {
      if (path === "/") return send(200, PAGE, "text/html");
      if (path === "/crash") return send(200, CRASH_PAGE, "text/html");
      if (path === "/parameters/g1") return send(200, leading(join(parameters, "bn254_g1.dat"), 64 * 32768), "application/octet-stream");
      if (path === "/parameters/g2") return send(200, leading(join(parameters, "bn254_g2.dat"), 128), "application/octet-stream");
      const name = path.slice(1);
      if (!/^[\w.-]+$/.test(name) || !existsSync(join(directory, name))) return send(404, "absent");
      return send(200, readFileSync(join(directory, name)), TYPES[extname(name)] ?? "application/octet-stream");
    } catch (error) { return send(500, String(error)); }
  });
  const result = () => results.length > 0 ? Promise.resolve(results.shift()) : new Promise(resolve => waiting.push(resolve));
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, result })));
}

/** A request forwarded unchanged to a loopback port the wallet check routes (`/via/<port>/`): its method, path, body
 * and the headers a client sends; the answer's status, type, encoding and body come back as they are. */
function forward(request, response, port, path) {
  const headers = Object.fromEntries(["authorization", "content-type", "content-length", "content-encoding", "accept-encoding"]
    .filter(name => request.headers[name] !== undefined).map(name => [name, request.headers[name]]));
  const onward = httpRequest({ host: "127.0.0.1", port, path, method: request.method, headers }, answer => {
    response.writeHead(answer.statusCode, { ...Object.fromEntries(["content-type", "content-encoding", "content-length"]
      .filter(name => answer.headers[name] !== undefined).map(name => [name, answer.headers[name]])),
      "cache-control": "no-store", "cross-origin-resource-policy": "same-origin" });
    answer.pipe(response);
  });
  onward.on("error", () => response.destroy());
  response.on("close", () => onward.destroy());
  request.pipe(onward);
}

/** On Linux, the summed resident memory of `pid` and its descendants, in bytes, from /proc; undefined elsewhere. */
function treeRss(pid) {
  if (process.platform !== "linux") return undefined;
  const children = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8"), parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(name)]);
    } catch { /* gone meanwhile */ }
  }
  let total = 0;
  for (const queue = [pid]; queue.length > 0;) {
    const next = queue.pop();
    try { total += 1024 * Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${next}/status`, "utf8"))?.[1] ?? 0); } catch { /* gone */ }
    queue.push(...(children.get(next) ?? []));
  }
  return total;
}

/** A DevTools protocol connection over the browser's own endpoint, with flattened sessions. */
async function devtools(endpoint, onEvent) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("browser check: no DevTools connection")); });
  let next = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) { onEvent(message); return; }
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiter?.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });
  return { send, close: () => socket.close() };
}

/** One command through the page's `moeCommand`, once the page defines it; bytes cross the protocol as base64. */
async function pageCommand(connection, sessionId, request) {
  const encode = bytes => Buffer.from(bytes).toString("base64");
  const sent = { ...request, ...(request.files === undefined ? {} : { files: Object.fromEntries(Object.entries(request.files).map(([path, bytes]) => [path, encode(bytes)])) }),
    ...(request.stdin === undefined ? {} : { stdin: encode(request.stdin) }) };
  const expression = `(async () => {
    while (typeof moeCommand !== "function") await new Promise(r => setTimeout(r, 50));
    const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
    const text = data => { let s = ""; for (let i = 0; i < data.length; i += 8192) s += String.fromCharCode(...data.subarray(i, i + 8192)); return btoa(s); };
    const request = ${JSON.stringify(sent)};
    if (request.files) request.files = Object.fromEntries(Object.entries(request.files).map(([path, data]) => [path, bytes(data)]));
    if (request.stdin) request.stdin = bytes(request.stdin);
    const result = await moeCommand(request);
    // Whether any of the seed stays in the page after the command: its buffer is transferred to the worker.
    // A transferred buffer is detached: its view reads as empty.
    const stdinLeft = request.stdin === undefined ? null : request.stdin.byteLength === 0 ? 0 : request.stdin.byteLength + request.stdin.reduce((sum, byte) => sum + byte, 0);
    return JSON.stringify({ ...result, stdinLeft, files: Object.fromEntries(Object.entries(result.files ?? {}).map(([path, data]) => [path, data === null ? null : text(data)])) });
  })()`;
  const evaluated = await connection.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (evaluated.exceptionDetails !== undefined) throw new Error(`browser check: the page's command failed: ${JSON.stringify(evaluated.exceptionDetails)}`);
  const result = JSON.parse(evaluated.result.value);
  return { ...result, files: Object.fromEntries(Object.entries(result.files).map(([path, data]) => [path, data === null ? null : Buffer.from(data, "base64")])) };
}

const within = (promise, minutes) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`browser check: no result within ${minutes} minutes`)), minutes * 60_000).unref())]);

async function main() {
  const options = parse(process.argv.slice(2)), started = Date.now(), token = randomBytes(16).toString("hex");
  const log = line => console.log(`browser check: ${typeof line === "string" ? line : JSON.stringify(line)}`);
  const out = join(root, "scratch/browser-check");
  const shim = { name: "vitest-shim", setup(build) {
    build.onResolve({ filter: /^vitest$/ }, () => ({ path: join(root, "scripts/browser/vitest-shim.mjs") }));
    // The suites' temporary directory and process starts (test-modules.mjs): test bundles only, never the library's.
    build.onResolve({ filter: /^node:(os|child_process)$/ }, () => ({ path: join(root, "scripts/browser/test-modules.mjs") }));
  } };
  const entry = options.check, extra = entry === "suites" && !options.serve ? ["isolation"] : entry === "files" && !options.serve ? ["crash"] : [];
  // The wallet check's command worker is the library's behind the loopback route (wallet-worker.mjs), beside the page.
  const entries = entry === "wallet" ? [{ in: join(root, "scripts/browser/wallet-worker.mjs"), out: "command" }]
    : [entry, ...extra].map(name => ({ in: join(root, `scripts/browser/${name}.mjs`), out: name }));
  const { code } = await bundle(entries, out, [shim]);
  log({ built: [entry, ...extra], code, seconds: (Date.now() - started) / 1000 });
  if ((entry === "proofs" || entry === "wallet") && !existsSync(join(options.parameters, "bn254_g1.dat"))) {
    throw new Error(`browser check: no proving parameters in ${options.parameters}; run scripts/pool/prepare-crs.mjs`);
  }

  const routes = new Set(), { server, port, result } = await serve(out, options.parameters, log, options.port, token, routes);
  const address = (path, name) => `http://127.0.0.1:${port}${path}?t=${token}#${name}`;
  if (options.serve && entry === "wallet") throw new Error("browser check: --wallet drives the page over DevTools; for another browser use --connect");
  if (options.serve) {
    log(`open ${address("/", entry)} in the browser to measure (a phone: adb reverse tcp:${port} tcp:${port})`);
    try {
      const outcome = await result();
      const report = { ...outcome, check: entry, browser: "served", platform: process.platform, code, seconds: (Date.now() - started) / 1000 };
      writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
      return judge(report, log);
    } finally { server.close(); }
  }

  const executable = options.connect === undefined ? findBrowser(options.browser) : undefined;
  const start = () => {
    const directory = mkdtempSync(join(tmpdir(), "moe-browser-"));
    return { profile: directory, browser: spawn(executable, [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${directory}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--enable-blink-features=ForceEagerMeasureMemory",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank",
    ], { stdio: "ignore" }) };
  };
  let { browser, profile } = executable === undefined ? {} : start();
  let connection, targetId;
  try {
    // The port file's lines once both are written; on Windows the browser holds it open while writing (EBUSY), which is
    // read as not written yet.
    const portLines = () => {
      const portFile = join(profile, "DevToolsActivePort");
      try { return existsSync(portFile) ? readFileSync(portFile, "utf8").split("\n") : []; } catch (error) {
        if (error?.code === "EBUSY" || error?.code === "EPERM") return [];
        throw error;
      }
    };
    // A browser that exits or writes no port within 60 s is started once more with a fresh profile: a hosted Windows
    // runner's first start of the browser has missed 30 s (main's CI at 7e91d6e and abf6da3). The second failure stands.
    let lines = [];
    for (let attempt = 1; browser !== undefined; attempt++) {
      let i = 0;
      while ((lines = portLines()).length < 2 && i <= 600 && browser.exitCode === null) { await new Promise(r => setTimeout(r, 100)); i++; }
      if (lines.length >= 2) break;
      const why = browser.exitCode !== null ? `exited with ${browser.exitCode}` : "wrote no DevTools port in 60 s";
      if (attempt === 2) throw new Error(`browser check: ${executable} did not open DevTools (${why}, twice)`);
      log(`${executable} ${why}; starting it once more`);
      const exited = browser.exitCode !== null ? Promise.resolve() : new Promise(r => browser.once("exit", r));
      browser.kill();
      await exited;
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (error) { log(`left ${profile}: ${error.code}`); }
      ({ browser, profile } = start());
    }
    const [devPort, path] = lines;
    const endpoint = browser !== undefined ? `ws://127.0.0.1:${devPort}${path}` : await fetch(`${options.connect}/json/version`)
      .then(answer => answer.json()).then(version => version.webSocketDebuggerUrl, () => { throw new Error(`browser check: no DevTools endpoint at ${options.connect}`); });
    // A crashed page posts nothing: its check fails at once rather than after the wait.
    let crash;
    const crashed = new Promise((_, reject) => { crash = method => reject(new Error(`browser check: the page crashed (${method})`)); });
    crashed.catch(() => {});
    connection = await devtools(endpoint, message => {
      if (message.method === "Inspector.targetCrashed" || message.method === "Target.targetCrashed") crash(message.method);
    });
    const version = await connection.send("Browser.getVersion");
    await connection.send("Target.setDiscoverTargets", { discover: true });
    ({ targetId } = await connection.send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    await connection.send("Inspector.enable", {}, sessionId);
    // Each page's own result: a late post from an earlier page is set aside, not taken for this one's.
    const resultOf = async kind => { for (;;) { const posted = await result(); if (posted.kind === kind || posted.kind === undefined) return posted; log({ setAside: posted }); } };
    const idle = browser === undefined ? undefined : treeRss(browser.pid);
    let peak = idle;
    const sampler = setInterval(() => { const rss = browser === undefined ? undefined : treeRss(browser.pid); if (rss !== undefined && rss > peak) peak = rss; }, 200);
    let outcome;
    if (entry === "wallet") {
      await connection.send("Page.navigate", { url: `http://127.0.0.1:${port}/wallet.html` }, sessionId);
      await connection.send("Runtime.enable", {}, sessionId);
      const command = request => pageCommand(connection, sessionId, request);
      const { drill } = await import("./wallet-drill.mjs");
      const drilled = drill({ command, route: routed => routes.add(routed), log, parameters: options.parameters, root });
      outcome = await within(Promise.race([drilled.catch(error => ({ error: error.stack ?? String(error) })), crashed]), options.minutes).finally(() => clearInterval(sampler));
    } else {
      await connection.send("Page.navigate", { url: address("/", entry) }, sessionId);
      outcome = await within(Promise.race([resultOf(entry), crashed]), options.minutes).finally(() => clearInterval(sampler));
    }
    let isolation, crashes;
    if (entry === "files") {
      await connection.send("Page.navigate", { url: `http://127.0.0.1:${port}/crash?t=${token}` }, sessionId);
      crashes = {};
      for (const phase of ["write", "reopen", "second"]) crashes[phase] = await within(Promise.race([resultOf(`crash-${phase}`), crashed]), 5);
      // The two racing workers report in either order.
      while (crashes["race-1"] === undefined || crashes["race-2"] === undefined) {
        const posted = await within(Promise.race([result(), crashed]), 5);
        if (/^crash-race-[12]$/.test(posted.kind ?? "")) crashes[posted.kind.slice("crash-".length)] = posted;
        else log({ setAside: posted });
      }
    } else if (extra.length > 0) {
      await connection.send("Page.navigate", { url: address("/plain/", "isolation") }, sessionId);
      isolation = await within(Promise.race([resultOf("isolation"), crashed]), 5);
    }
    // The page's fields first, so none it posts can stand in for the run's own.
    const report = { ...outcome, check: entry, browser: version.product, userAgent: version.userAgent, platform: process.platform,
      ...(idle === undefined ? {} : { browserRssBytes: { idle, peak } }), code, seconds: (Date.now() - started) / 1000,
      ...(isolation === undefined ? {} : { isolation }), ...(crashes === undefined ? {} : { crash: crashes }) };
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    return judge(report, log);
  } finally {
    if (browser === undefined && targetId !== undefined) {
      await Promise.race([connection.send("Target.closeTarget", { targetId }).catch(() => {}), new Promise(r => setTimeout(r, 5_000).unref())]);
    }
    connection?.close();
    server.close();
    if (browser !== undefined) {
      const exited = browser.exitCode !== null ? Promise.resolve() : new Promise(r => browser.once("exit", r));
      browser.kill();
      await Promise.race([exited, new Promise(r => setTimeout(r, 10_000).unref())]);
      // A profile the browser still holds (Windows) is left in the system's temporary directory, not a failure.
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (error) { log(`left ${profile}: ${error.code}`); }
    }
  }
}

/** Whether the worker's report shows every check passing; prints what failed. */
function judge(report, log) {
  const failures = [];
  if (report.error) failures.push(report.error);
  if ((report.check === "suites" || report.check === "files") && !report.error) {
    for (const r of report.results.filter(r => r.state === "fail")) failures.push(`${r.name}\n${r.error}`);
    for (const rejection of report.unhandled ?? []) failures.push(`an unhandled rejection: ${rejection}`);
    if (report.counts.pass === 0) failures.push("no test ran");
    log({ suites: report.counts, ms: report.ms, ...(report.pool === undefined ? {} : { pool: report.pool }) });
    if (report.pool !== undefined && (report.pool.files !== 0 || report.pool.unnamed !== 0)) failures.push(`files left in the pool: ${JSON.stringify(report.pool)}`);
    if (report.isolation !== undefined) {
      const i = report.isolation;
      if (i.error || i.isolated !== false || i.started !== false || i.refusedByName !== true) failures.push(`a page without isolation: ${JSON.stringify(i)}`);
      log({ isolation: i });
    }
  }
  if (report.check === "files" && report.crash !== undefined) {
    const { write, reopen, second, "race-1": race1, "race-2": race2 } = report.crash;
    if (write.error || write.vouchedAtKeep !== true || !(write.files?.wal > 0)) failures.push(`the crash's writer: ${JSON.stringify(write)}`);
    else if (reopen.error || reopen.kept !== true || JSON.stringify(reopen.tip) !== JSON.stringify(write.tip)) {
      failures.push(`the kept file after a crash is not the keep point's: ${JSON.stringify({ write, reopen })}`);
    }
    if (second.error || second.mounted !== false || second.code !== "EBUSY") failures.push(`a second worker's mount: ${JSON.stringify(second)}`);
    const races = [race1, race2];
    if (races.some(r => r.error) || races.filter(r => r.mounted === true).length !== 1 || !races.some(r => r.mounted === false && r.code === "EBUSY")) {
      failures.push(`two workers mounting an empty pool: ${JSON.stringify(races)}`);
    }
    log({ crash: { written: write.files, reopened: reopen.files, kept: reopen.kept, second: second.code, race: races.map(r => r.mounted ? "mounted" : r.code), ms: { write: write.ms, reopen: reopen.ms } } });
  }
  if (report.check === "wallet" && !report.error) {
    if ((report.checks?.length ?? 0) !== 6) failures.push(`the wallet drill ran ${report.checks?.length ?? 0} of 6 checks`);
    log({ checks: report.checks, commands: report.commands });
  }
  if (report.check === "proofs" && !report.error) {
    const c = report.checks;
    if (Object.keys(c.genuine ?? {}).length !== 5 || !Object.values(c.genuine).every(v => v === true)) failures.push(`a genuine proof did not verify: ${JSON.stringify(c.genuine)}`);
    if (c.tampered !== false) failures.push("a tampered spend proof verified");
    if (c.spendVerifies !== true || c.spendProofBytes !== 14656) failures.push(`the proved spend: ${c.spendProofBytes} bytes, verifies ${c.spendVerifies}`);
    if (c.capsulesFound !== 1000) failures.push(`the capsule scan found ${c.capsulesFound} of 1000`);
    log({ phases: report.phases, checks: { ...c, genuine: undefined } });
  }
  if (report.check === "rates" && !report.error) {
    const c = report.checks, s = report.sizes;
    if (c.replayPosition !== String(s.spends + 1) || c.verifierCallsPerRead !== s.spends + 1) failures.push(`the replay: ${JSON.stringify(c)}`);
    if (c.headersAdded !== s.headers) failures.push(`the header store added ${c.headersAdded} of ${s.headers}`);
    log({ phases: report.phases, checks: c });
  }
  for (const failure of failures) console.error(`browser check: FAILED ${failure}`);
  const memory = report.browserRssBytes === undefined ? "" : `peak browser RSS ${Math.round(report.browserRssBytes.peak / 2 ** 20)} MiB, `;
  log(`${failures.length === 0 ? "passed" : "failed"} in ${report.browser}, ${memory}${report.seconds.toFixed(1)} s; report ${report.check}`);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
