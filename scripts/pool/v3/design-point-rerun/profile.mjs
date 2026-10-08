// Slice 13 (e) probe tooling, disposable: after driver.mjs, serve over the 10⁵ journal under --cpu-prof, N more
// stand-ins at the driver's cadence; each admission's time and whether a block preceded it, and each serve event
// with the time it was logged, go to run/profile-*.jsonl. Usage: node profile.mjs [--statements 3000]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "@noble/hashes/sha2.js";

const WT = "/home/user/reference-ts/scratch/wt/depth", HERE = "/home/user/reference-ts/scratch/depth", RUN = join(HERE, "run");
const dist = path => import(join(WT, "dist", path));
const { limbsOf } = await dist("pool/field.js");
const { EMPTY_NOTE_ROOT } = await dist("pool/note-tree.js");
const { openDirectory } = await dist("cli/common.js");
const { openView } = await dist("cli/venue.js");
const { prepareExactOutput } = await dist("pool/v3/capsules.js");
const { adoptedDomain } = await dist("pool/v3/configuration.js");
const { deliveryHash, encodeRecord } = await dist("pool/v3/records.js");
const { V3ServiceClient } = await dist("pool/v3/service-client.js");
const { values: options } = parseArgs({ options: { statements: { type: "string", default: "3000" } } });
const N = Number(options.statements), REAL = 8, PER_BLOCK = 14, OP = join(RUN, "operator"), BK = join(RUN, "backer");
const pause = ms => new Promise(done => setTimeout(done, ms));
const state = JSON.parse(readFileSync(join(RUN, "state.json"), "utf8"));
const env = { ...process.env, MOE_DEPTH_BACKEND: join(WT, "dist/cli/backend.js"), MOE_DEPTH_PROOFS: join(RUN, "proofs.bin") };
const out = join(RUN, `profile-${Date.now()}`);
mkdirSync(`${out}-cpu`, { recursive: true });

const node = spawn(process.execPath, [join(HERE, "node.mjs"), WT, join(RUN, "node.log"), "39053"], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise(done => node.stdout.once("data", done));
const mine = async () => { const r = await fetch("http://127.0.0.1:39053/synthetic/mine", { method: "POST", headers: { "content-type": "application/json" }, body: '{"count":1}' }); await r.json(); };
const db = new DatabaseSync(join(OP, "journal.db"), { readOnly: true });
let made = Number(db.prepare("SELECT COUNT(*) AS n FROM journal_receipt").get().n); db.close();
const serve = spawn(process.execPath, ["--cpu-prof", "--cpu-prof-dir", `${out}-cpu`, "--import", join(HERE, "standin-hook.mjs"), join(WT, "dist/cli/moe.js"), "operator", "serve",
  "--dir", OP, "--interval", "2", "--poll-ms", "100", "--port", "39055"], { cwd: RUN, stdio: ["ignore", "pipe", "pipe"], env });
const began = performance.now();
serve.stderr.on("data", chunk => { for (const line of String(chunk).split("\n").filter(Boolean)) appendFileSync(`${out}-events.jsonl`, `${JSON.stringify({ t: Math.round(performance.now() - began), line })}\n`); });
const exited = new Promise(done => serve.on("close", done));
await new Promise(done => { let s = ""; serve.stdout.on("data", c => { s += c; if (s.includes("\n")) done(); }); });
const service = JSON.parse(readFileSync(join(OP, "service.json"), "utf8"));
const bk = openDirectory(BK, "wallet"), v = openView(bk), reference = v.file.reference; v.close();
const client = new V3ServiceClient(service.url, service.walletToken, { operator: Buffer.from(state.operator, "hex"), reference });
const backing = Buffer.from(state.backing, "hex"), seed = Buffer.from(state.seed, "hex"), domain = adoptedDomain(), prefix = state.prefix.map(BigInt);
const MODULUS = 21888242871839275222246405745257275088548364400416903490308238158651n;
const fieldOf = () => { for (;;) { const x = BigInt(`0x${randomBytes(32).toString("hex")}`) % MODULUS; if (x !== 0n) return x; } };
const capsuleOf = () => { const c = randomBytes(89); c[0] = 1; return c; };
// Fresh outputs only (no seed spends): the admission path is the same.
const standIn = i => {
  const outs = [], caps = [];
  for (let k = 0; k < 4; k++) {
    if (k === 0 && i % 2 === 0) { const o = prepareExactOutput(seed, domain, sha256(Buffer.from(`profile-${i}`)), backing, 1n); outs.push(o.cm); caps.push(o.capsule); }
    else { outs.push(fieldOf()); caps.push(capsuleOf()); }
  }
  return encodeRecord({ domain, kind: 2, publicInputs: [...prefix, EMPTY_NOTE_ROOT, EMPTY_NOTE_ROOT, fieldOf(), fieldOf(), ...outs, ...limbsOf(deliveryHash(domain, outs, caps))],
    proof: randomBytes(state.proofBytes), authorization: new Uint8Array(), capsules: caps });
};
let newBlock = false;
for (let i = 0; i < N; i++) {
  const bytes = standIn(made), first = newBlock; newBlock = false;
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    try { await client.submit(bytes); appendFileSync(`${out}-admissions.jsonl`, `${JSON.stringify({ t: Math.round(t0 - began), ms: +(performance.now() - t0).toFixed(1), first })}\n`); break; }
    catch (error) { if (attempt >= 20 || !["SCHEDULE", "STALE"].includes(error?.code)) throw error; await mine(); newBlock = true; await pause(300); }
  }
  made++;
  if (made % PER_BLOCK === 0) { await mine(); newBlock = true; appendFileSync(`${out}-admissions.jsonl`, `${JSON.stringify({ t: Math.round(performance.now() - began), mined: true })}\n`); }
}
serve.kill("SIGTERM"); await exited; node.kill("SIGTERM");
console.log(out);
