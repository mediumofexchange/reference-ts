// Slice 24 probe (Next 7): what makes the kept-file tests slow on some hosted Windows runners. Disposable: deleted
// before the slice merges, its results recorded in the slice's decision.
//
//   node scripts/probe/win-io.mjs ops <dir> <label> <out.json>       file and SQLite operation latencies in <dir>
//   node scripts/probe/win-io.mjs summary <out.md> <file.json>...      ops and vitest JSON results as one table
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const now = () => performance.now();
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s.at(-1), total: s.reduce((a, b) => a + b, 0) };
};

function ops(base, label, out) {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "win-io-")), page = Buffer.alloc(4096, 7), t = {};
  const time = (name, f) => { const a = now(); const r = f(); (t[name] ??= []).push(now() - a); return r; };
  const N = 100;
  for (let i = 0; i < N; i++) {
    const p = join(dir, `f${i}`);
    time("create+write 4 KiB+close", () => { const fd = openSync(p, "w"); writeSync(fd, page); closeSync(fd); });
    time("fsync 4 KiB (rewrite)", () => { const fd = openSync(p, "r+"); writeSync(fd, page, 0, 4096, 0); fsyncSync(fd); closeSync(fd); });
    time("open+close existing", () => closeSync(openSync(p, "r")));
    time("replace (write, fsync, rename)", () => {
      const q = `${p}.partial`, fd = openSync(q, "w"); writeSync(fd, "digest\n"); fsyncSync(fd); closeSync(fd); renameSync(q, `${p}.sha`);
    });
  }
  for (let i = 0; i < N; i++) time("unlink", () => { rmSync(join(dir, `f${i}`), { force: true }); rmSync(join(dir, `f${i}.sha`), { force: true }); });
  // A kept file's cycle as the replay store runs it: WAL, synchronous=FULL, commits, a TRUNCATE checkpoint, close,
  // and its removal.
  for (let i = 0; i < 20; i++) {
    const p = join(dir, `db${i}.sqlite`);
    const db = time("sqlite open+WAL+schema", () => {
      const d = new DatabaseSync(p); d.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=0; CREATE TABLE x (k INTEGER PRIMARY KEY, v BLOB)"); return d;
    });
    const ins = db.prepare("INSERT INTO x (v) VALUES (?)");
    for (let j = 0; j < 20; j++) time("sqlite commit (8 rows)", () => { db.exec("BEGIN"); for (let k = 0; k < 8; k++) ins.run(page); db.exec("COMMIT"); });
    time("sqlite savepoint rollback", () => { db.exec("BEGIN; SAVEPOINT s"); for (let k = 0; k < 64; k++) ins.run(page); db.exec("ROLLBACK TO s; RELEASE s; COMMIT"); });
    time("sqlite checkpoint TRUNCATE", () => db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get());
    time("sqlite close", () => db.close());
    time("sqlite reopen+close", () => new DatabaseSync(p).close());
    time("sqlite remove files", () => { for (const f of [`${p}-wal`, `${p}-shm`, p]) rmSync(f, { force: true }); });
  }
  rmSync(dir, { recursive: true, force: true });
  const result = { label, dir: base, ops: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, stats(v)])) };
  writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

const f1 = (x) => (x === undefined ? "" : x < 10 ? x.toFixed(2) : x.toFixed(0));
function summary(out, files) {
  const lines = [];
  for (const file of files) {
    let j; try { j = JSON.parse(readFileSync(file, "utf8")); } catch { lines.push(`(${file}: unreadable)`); continue; }
    if (j.ops) {
      lines.push(`### ops ${j.label} (${j.dir})`, "| op | n | p50 | p90 | p99 | max | total ms |", "|---|---|---|---|---|---|---|");
      for (const [k, s] of Object.entries(j.ops)) lines.push(`| ${k} | ${s.n} | ${f1(s.p50)} | ${f1(s.p90)} | ${f1(s.p99)} | ${f1(s.max)} | ${f1(s.total)} |`);
    } else if (j.testResults) {
      const rows = [];
      let sum = 0;
      for (const r of j.testResults) for (const a of r.assertionResults ?? []) { sum += a.duration ?? 0; rows.push([a.duration ?? 0, a.status, a.fullName ?? a.title]); }
      rows.sort((a, b) => b[0] - a[0]);
      lines.push(`### vitest ${file}: ${rows.length} tests, sum ${f1(sum)} ms, failed ${rows.filter(r => r[1] !== "passed").length}`);
      for (const [d, s, n] of rows.slice(0, 12)) lines.push(`- ${f1(d)} ms ${s} ${String(n).slice(0, 110)}`);
    }
    lines.push("");
  }
  writeFileSync(out, lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  console.log(lines.join("\n"));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "ops") ops(rest[0], rest[1], rest[2]);
else if (mode === "summary") summary(rest[0], rest.slice(1));
else { console.error("usage: win-io.mjs ops <dir> <label> <out> | summary <out> <json>..."); process.exit(2); }
