// How an in-browser check's worker reports (slice 39, scripts/browser/check.mjs): progress lines and the final result
// go to the serving script by POST, with the run's token from the worker's own address; memory is measured by the
// page, which alone may ask the engine for every worker's memory (`performance.measureUserAgentSpecificMemory`,
// cross-origin isolated).
const token = new URL(self.location.href).searchParams.get("t") ?? "";
let asked = 0;
const waiting = new Map();
self.addEventListener("message", event => {
  const { id, memory } = event.data ?? {};
  waiting.get(id)?.(memory);
  waiting.delete(id);
});

const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-moe-token": token }, body: JSON.stringify(body) });

/** A progress line for the serving script's log. */
export const report = line => post("/progress", line);

/** The page's measurement of the page and its workers, in bytes, or undefined where the engine gives none. */
export function memory() {
  const id = ++asked;
  return new Promise(resolve => { waiting.set(id, resolve); self.postMessage({ measure: id }); });
}

/** The result with the engine and device the worker ran on, after which the serving script closes the browser. */
export const finish = result => post("/result", { ...result, worker: { userAgent: navigator.userAgent,
  hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory } });
