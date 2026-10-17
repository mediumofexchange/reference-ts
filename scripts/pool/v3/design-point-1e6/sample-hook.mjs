// 10⁶ design-point probe tooling, disposable: loaded with `node --import` into each process of the run (serve, the
// synthetic node, each `moe` read). Windows has no /proc, so the process samples itself: every MOE_DEPTH_SAMPLE_MS
// (default 1000) it appends {at, rssMb, peakMb, cpuMs, heapMb} to MOE_DEPTH_SAMPLES, garbage-collected first every
// tenth sample when --expose-gc is on and MOE_DEPTH_GC is set. peakMb is the peak working set (libuv's maxRSS).
import { appendFileSync } from "node:fs";

const file = process.env.MOE_DEPTH_SAMPLES, every = Number(process.env.MOE_DEPTH_SAMPLE_MS ?? 1000);
if (file !== undefined) {
  let n = 0;
  const sample = () => {
    const collected = process.env.MOE_DEPTH_GC !== undefined && n++ % 10 === 0 && typeof globalThis.gc === "function";
    if (collected) globalThis.gc();
    const { maxRSS, userCPUTime, systemCPUTime } = process.resourceUsage(), m = process.memoryUsage();
    appendFileSync(file, `${JSON.stringify({ at: Date.now(), rssMb: Math.round(m.rss / 1048576), peakMb: Math.round(maxRSS / 1024),
      cpuMs: Math.round((userCPUTime + systemCPUTime) / 1000), heapMb: Math.round(m.heapUsed / 1048576), collected,
      heapTotalMb: Math.round(m.heapTotal / 1048576), externalMb: Math.round(m.external / 1048576), arrayBuffersMb: Math.round(m.arrayBuffers / 1048576) })}\n`);
  };
  sample();
  setInterval(sample, every).unref();
}
