// Disposable (slice 15 (az)): a heap snapshot once the wallet's holdingsOf returns, while the read's notes, holdings and view are live.
import { writeHeapSnapshot } from "node:v8";
const { V3Wallet } = await import(`${process.env.DPR_WT}/dist/pool/v3/wallet-store.js`);
const original = V3Wallet.prototype.holdingsOf;
let done = false;
V3Wallet.prototype.holdingsOf = function (...args) {
  const out = original.apply(this, args);
  if (!done) { done = true; globalThis.gc?.(); process.stderr.write(`SNAPSHOT ${writeHeapSnapshot(`${process.env.DPR_SNAP}`)}\n`); globalThis.keep = [args, out]; }
  return out;
};
