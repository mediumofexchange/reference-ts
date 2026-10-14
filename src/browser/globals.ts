// Node's globals the library names, in the browser bundle (slice 39): esbuild injects this module wherever the
// library names one (scripts/browser/build.mjs), so its uses run unchanged.
// - `Buffer`, from the `buffer` package: the read path's base64 bytecode and concatenations. Its `equals` refuses a
//   Uint8Array that Node's takes (replay-store.ts compares a kept walk's context so): here it takes one too.
// - `setImmediate`: the walks give up their turn with it every few hundred records (replay-store.ts, evidence-store.ts
//   `turn`). A message on a channel of the bundle's own runs it after pending messages, as Node's runs it after
//   pending I/O, and is not slowed as nested timers are.
import { Buffer } from "buffer";

const equals = Buffer.prototype.equals;
Buffer.prototype.equals = function (this: Buffer, other: Uint8Array): boolean {
  return equals.call(this, other instanceof Uint8Array && !Buffer.isBuffer(other) ? Buffer.from(other.buffer, other.byteOffset, other.byteLength) : other);
};
export { Buffer };

const waiting: (() => void)[] = [];
const channel = new MessageChannel();
channel.port1.addEventListener("message", () => { waiting.shift()?.(); });
channel.port1.start();

export function setImmediate<A extends unknown[]>(callback: (...args: A) => void, ...args: A): void {
  waiting.push(() => callback(...args));
  channel.port2.postMessage(0);
}
