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

// - `process`'s members a command reaches (slice 41): the bundle names `process.env`, `.stdout`, `.stderr`, `.stdin` and
//   `.umask` as this object's (build.mjs `define`), while `process` itself stays undefined, as a library testing for
//   Node finds it. Its environment is empty (no proxy, so an onion URL is refused by name, service-client.ts), umask
//   changes nothing (an origin's files are its own), and a command's output goes where the command worker
//   (command.ts) collects it; outside a command it goes to the console.
interface Writable { write(text: string | Uint8Array, done?: () => void): boolean }
interface Readable extends AsyncIterable<Buffer> { readonly isTTY?: boolean }
const toConsole = (log: (text: string) => void): Writable => ({
  write(text, done) { log(typeof text === "string" ? text : new TextDecoder().decode(text)); done?.(); return true; },
});
export const moeProcess: { env: Record<string, string | undefined>; stdout: Writable; stderr: Writable; stdin: Readable; umask(mask?: number): number } = {
  env: {},
  stdout: toConsole(text => console.log(text)),
  stderr: toConsole(text => console.error(text)),
  stdin: { isTTY: true, async *[Symbol.asyncIterator]() { /* no input outside a command */ } },
  umask: () => 0o077,
};

// - `setTimeout` and `clearTimeout` with Node's `Timeout` (slice 41): a service client restarts its bound with
//   `refresh()` as a stream's chunks arrive (service-client.ts), which a browser's numeric timer id lacks. The object
//   reads as its id where a number is wanted, and `clearTimeout` takes either.
const browserSetTimeout = globalThis.setTimeout, browserClearTimeout = globalThis.clearTimeout;
export class Timeout {
  private id: ReturnType<typeof browserSetTimeout>;
  private cleared = false;
  constructor(private readonly callback: () => void, private readonly ms: number | undefined) { this.id = browserSetTimeout(callback, ms); }
  /** Restarts the bound, also after it fired, as Node's does; a cleared timer stays cleared. */
  refresh(): this {
    if (this.cleared) return this;
    browserClearTimeout(this.id); this.id = browserSetTimeout(this.callback, this.ms); return this;
  }
  ref(): this { return this; }
  unref(): this { return this; }
  hasRef(): boolean { return true; }
  close(): this { browserClearTimeout(this.id); this.cleared = true; return this; }
  [Symbol.toPrimitive](): number { return Number(this.id); }
}
function setTimeoutNode<A extends unknown[]>(callback: (...args: A) => void, ms?: number, ...args: A): Timeout {
  return new Timeout(() => callback(...args), ms);
}
function clearTimeoutNode(timer: Timeout | number | undefined): void {
  if (timer instanceof Timeout) timer.close(); else browserClearTimeout(timer);
}
export { setTimeoutNode as setTimeout, clearTimeoutNode as clearTimeout };
