// Disposable (slice 15 (az)): sample every allocation of this process, collected ones included, and write the profile at exit.
import { Session } from "node:inspector";
import { writeFileSync } from "node:fs";
const session = new Session(); session.connect();
session.post("HeapProfiler.enable");
session.post("HeapProfiler.startSampling", { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
process.on("exit", () => {
  session.post("HeapProfiler.stopSampling", (error, result) => { if (!error) writeFileSync(process.env.DPR_ALLOC, JSON.stringify(result.profile)); });
});
