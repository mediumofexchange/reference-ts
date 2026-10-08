// Probe tooling, disposable: summarize a profile run's admissions file (slice 15 (ay)).
import { readFileSync } from "node:fs";
for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => r.ms !== undefined);
  const ms = rows.map(r => r.ms).sort((a, b) => a - b), at = q => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  const slow = rows.filter(r => r.ms > 500).map(r => r.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ file: file.split("/").slice(-2).join("/"), n: ms.length, median: at(0.5), p95: at(0.95), p99: at(0.99), max: ms.at(-1),
    over500: slow.length, over1000: rows.filter(r => r.ms > 1000).length, slowMedian: slow[Math.floor(slow.length / 2)] ?? null,
    slow90: slow.length ? [slow[Math.floor(slow.length * 0.05)], slow[Math.floor(slow.length * 0.95)]] : null }));
}
