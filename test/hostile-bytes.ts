// In-process objects that misreport bytes, for the intake contract: every
// codec reads a caller's bytes and fields once into owned values, so what it
// checks is what it writes, hashes or answers about (docs/PROTOCOL_RULES.md,
// "Copy on the way in"). Wire bytes never take these shapes; a caller's own
// objects can.

/** Genuine bytes whose own `length` property reports another count. */
export function lyingLength(bytes: Uint8Array, reported: number): Uint8Array {
  const own = Uint8Array.from(bytes);
  Object.defineProperty(own, "length", { value: reported });
  return own;
}

/** Genuine bytes whose own iterator yields other bytes. */
export function iterating(bytes: Uint8Array, yielded: Uint8Array): Uint8Array {
  const own = Uint8Array.from(bytes);
  Object.defineProperty(own, Symbol.iterator, { value: () => yielded[Symbol.iterator]() });
  return own;
}

/** An array whose own iterator yields nothing, though its indices hold values. */
export function silentArray<T>(values: readonly T[]): T[] {
  const own = [...values];
  Object.defineProperty(own, Symbol.iterator, { value: function* () { /* nothing */ } });
  return own;
}

/** A copy of `object` whose `key` answers `first` on the first read and `later` after. */
export function flipping<T extends object>(object: T, key: keyof T & string, first: unknown, later: unknown): T {
  let reads = 0;
  const copy = { ...object };
  Object.defineProperty(copy, key, { enumerable: true, get: () => (reads++ === 0 ? first : later) });
  return copy;
}

/** Bytes over shared memory whose own `buffer` getter reports an ordinary buffer. */
export function hiddenShared(bytes: Uint8Array): Uint8Array {
  class Hiding extends Uint8Array {
    override get buffer(): ArrayBuffer { return new ArrayBuffer(this.byteLength); }
  }
  const own = new Hiding(new SharedArrayBuffer(bytes.length) as unknown as ArrayBuffer);
  own.set(bytes);
  return own;
}

/** An array of the largest u32 length with no elements: cheap to make, fatal to walk. */
export const hugeSparse = <T>(): T[] => new Array<T>(0xffff_ffff);

/** Objects that pass `instanceof Uint8Array` without being one. */
export function lookAlikes(length: number): Uint8Array[] {
  const view = new DataView(new ArrayBuffer(length));
  Object.setPrototypeOf(view, Uint8Array.prototype);
  const float = new Float64Array(length);
  Object.setPrototypeOf(float, Uint8Array.prototype);
  return [view as unknown as Uint8Array, float as unknown as Uint8Array, new Proxy(new Uint8Array(length), {})];
}
