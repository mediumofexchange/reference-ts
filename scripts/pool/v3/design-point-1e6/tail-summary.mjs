// Slice 18, disposable: summarizes a tail report (tail.mjs): admissions by kind, the waits over 300 ms, and the
// slowest admission of each checkpoint (a new commitment marks the journal's own read of its new checkpoint).
// Usage: node tail-summary.mjs run/tail-report-14.json
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const rows = report.admissions.filter(r => r[4] === 0);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? null : s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const st = xs => ({ n: xs.length, median: q(xs, 0.5), p95: q(xs, 0.95), p99: q(xs, 0.99), max: q(xs, 1) });
const slow = rows.filter(r => r[1] > 300).map(r => r[1]);
// Per checkpoint: group by the commitment count serve reports at each admission.
const byCheckpoint = new Map();
for (const r of rows) { const k = r[3]; byCheckpoint.set(k, Math.max(byCheckpoint.get(k) ?? 0, r[1])); }
const firstAdmissions = report.admissions.slice(0, 5).map(r => r[1]);
console.log(JSON.stringify({
  from: report.from, through: report.through, done: report.done, excluded: report.admissions.length - rows.length,
  firstAdmissionsMs: firstAdmissions,
  others: st(rows.filter(r => r[2] === 0).map(r => r[1])), firstAfterBlock: st(rows.filter(r => r[2] === 1).map(r => r[1])),
  over300: st(slow), checkpoints: byCheckpoint.size, slowestPerCheckpoint: st([...byCheckpoint.values()]),
  bands: report.bands?.map(b => ({ through: b.through, cpuMsPerStatement: b.serveCpuMsPerStatement, hostBusy: b.hostBusy, rssMb: b.serve?.rssMb, peakMb: b.serve?.peakMb })),
  waits: report.waits, errors: report.errors,
}, null, 1));
