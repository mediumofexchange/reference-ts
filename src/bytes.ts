// Byte-level primitives, and the framing rule everything signed or hashed
// obeys.
//
// Invariant 1 requires "same fields, same bytes, on every machine, forever",
// and commitment roots require the converse: two different values must never
// produce one byte string. Both come from one rule (docs/PROTOCOL_RULES.md, Design rules):
// **every field is fixed-width and asserted, or length-prefixed. Nothing
// variable-length is ever written raw.** Adjacent unframed fields silently
// destroy injectivity — 31+33 bytes concatenate exactly like 32+32.
//
// Readers are strict for the same reason: a byte sequence either is THE
// canonical encoding of a value or it is rejected. There is never a second
// accepted spelling.

export class EncodingError extends Error {}

/** Quantities are whole, positive, and below this bound (invariant 15). */
export const MAX_QUANTITY_BYTES = 32;
export const MAX_QUANTITY_EXCLUSIVE = 1n << (8n * BigInt(MAX_QUANTITY_BYTES));

export function isValidQuantity(n: bigint): boolean {
  // A verifier's question, so it answers for a non-bigint too rather than
  // throwing on the comparison (found by the 2026-08-22 audit).
  return typeof n === "bigint" && n >= 1n && n < MAX_QUANTITY_EXCLUSIVE;
}

export function validateQuantity(n: bigint, what: string): void {
  if (!isValidQuantity(n)) throw new EncodingError(`${what} out of range`);
}

// Intrinsic getters: a subclass, own property or Proxy cannot misreport them.
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const intrinsic = (key: PropertyKey): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(typedArray, key)!.get!;
const brandOf = intrinsic(Symbol.toStringTag), lengthOf = intrinsic("length"), bufferOf = intrinsic("buffer");
const isBytes = (value: unknown): value is Uint8Array => brandOf.call(value) === "Uint8Array";

/**
 * The length of genuine bytes through the intrinsic getter, so a budget can be
 * applied before anything is copied. EncodingError for anything else.
 */
export function byteLength(bytes: Uint8Array): number {
  if (!isBytes(bytes)) throw new EncodingError("not a byte array");
  return lengthOf.call(bytes) as number;
}

// SharedArrayBuffer's own byteLength getter answers only for a shared buffer,
// from any realm; instanceof would miss another realm's.
const sharedLength = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")!.get!;
function isShared(buffer: unknown): boolean {
  try { sharedLength.call(buffer); return true; } catch { return false; }
}

/**
 * copyBytes for a codec whose policy is to take no bytes over shared memory,
 * read through the intrinsic getters rather than the caller's `buffer`.
 */
export function copyUnshared(bytes: Uint8Array): Uint8Array {
  if (isBytes(bytes) && isShared(bufferOf.call(bytes))) throw new EncodingError("shared byte array");
  return copyBytes(bytes);
}

/**
 * The one byte-copy in the codebase. Node's Buffer overrides `slice` to return
 * a view sharing memory, so the copying form must be forced explicitly or a
 * decoded value silently aliases (and mutates with) the caller's buffer.
 *
 * It refuses anything that is not bytes, because it is the boundary that finds
 * out. `readonly Uint8Array` is erased at runtime, so a field that arrives from
 * outside as a string, or missing, reaches here typed as bytes — and the raw
 * TypeError from `slice` names no boundary and is not what a caller guarding a
 * trust boundary catches. The signature on a published operation is exactly
 * that case: it is the one field the canonical message never reads, so encoding
 * an operation cannot vouch for it (venue.ts, publishOp).
 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  // The intrinsic brand, not instanceof: a Proxy or a DataView can claim the
  // prototype, and another typed array given it would be copied element by
  // element with each value reduced to a byte. Node's Buffer and any subclass
  // carry the Uint8Array brand, so they pass. The constructor copies from the
  // view's own buffer through its internal slots into a plain Uint8Array;
  // slice would honour a subclass's Symbol.species, which can hand back memory
  // the caller still holds, and `length` or an iterator can be overridden.
  if (!isBytes(bytes)) throw new EncodingError("not a byte array");
  try {
    return new Uint8Array(bytes);
  } catch {
    throw new EncodingError("not a byte array"); // a detached or out-of-bounds buffer
  }
}

/**
 * The length of a genuine array, read once, so a count budget can be applied
 * before any element is copied. EncodingError for a non-array.
 */
export function arrayLength(values: readonly unknown[]): number {
  if (!Array.isArray(values)) throw new EncodingError("not an array");
  const read: unknown = values.length;
  // Only a Proxy can answer a length that is not an array index count.
  if (typeof read !== "number" || !Number.isSafeInteger(read) || read < 0) throw new EncodingError("not an array");
  return read;
}

/**
 * A plain array of `copy` applied to each index of a genuine array, reading its
 * length once and each element once. Neither the argument's species (which
 * `map`, `slice` and `filter` honour) nor its iterator (which `Array.from` and
 * spreading walk) is consulted, so a caller can neither hand back an array it
 * still holds nor copy more than `limit` elements. EncodingError for a
 * non-array or a longer one; `copy`'s own failures propagate, so validating
 * inside `copy` stops at the first bad element of a long sparse array.
 */
export function copyArray<T, U>(values: readonly T[], copy: (value: T) => U, limit = Number.MAX_SAFE_INTEGER): U[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("array limit is not a count");
  const length = arrayLength(values);
  if (length > limit) throw new EncodingError("array longer than its limit");
  const own: U[] = [];
  for (let i = 0; i < length; i++) own.push(copy(values[i] as T));
  return own;
}

/** Unsigned big-endian, minimal length: no leading zero byte, 0n -> empty. */
export function bigintToMinimalBytes(n: bigint): Uint8Array {
  if (typeof n !== "bigint") throw new EncodingError("not a bigint");
  if (n < 0n) throw new EncodingError("negative quantity");
  if (n === 0n) return new Uint8Array(0);
  // Size first, then fill back-to-front. Prepending per byte would memmove the
  // whole buffer each time, which is quadratic on an attacker-sized value.
  let length = 0;
  for (let v = n; v > 0n; v >>= 8n) length++;
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function minimalBytesToBigint(bytes: Uint8Array): bigint {
  const own = copyBytes(bytes);
  if (own.length > 0 && own[0] === 0) {
    throw new EncodingError("non-minimal bigint encoding");
  }
  let n = 0n;
  for (const b of own) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * Lexicographic byte comparison, the sort order for reliance lists. A total
 * order on bytes only: lengths are read through the intrinsic getter, and
 * anything else is refused, since an order check written `>= 0` would read
 * the NaN a string or a lying length produces as "in order".
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (!isBytes(a) || !isBytes(b)) throw new EncodingError("not a byte array");
  const aLength = lengthOf.call(a) as number, bLength = lengthOf.call(b) as number;
  const len = Math.min(aLength, bLength);
  for (let i = 0; i < len; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return aLength - bLength;
}

/** Keys, backing names and hashes are all 32 bytes. */
export const FIXED32 = 32;

export class ByteWriter {
  private readonly out: number[] = [];

  u8(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) {
      throw new EncodingError("u8 out of range");
    }
    this.out.push(n);
  }

  /** Signed byte, two's complement. */
  i8(n: number): void {
    if (!Number.isInteger(n) || n < -128 || n > 127) {
      throw new EncodingError("i8 out of range");
    }
    this.out.push(n & 0xff);
  }

  u32(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
      throw new EncodingError("u32 out of range");
    }
    this.out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }

  u64(n: bigint): void {
    if (typeof n !== "bigint" || n < 0n || n > 0xffffffffffffffffn) {
      throw new EncodingError("u64 out of range");
    }
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      this.out.push(Number((n >> shift) & 0xffn));
    }
  }

  /**
   * A fixed-width field, asserted. This is the framing rule's enforcement
   * point: every raw byte field in every signed or hashed message goes through
   * here or through lengthPrefixed, so no two field values can ever share an
   * encoding. Every byte write takes its own copy first (copyBytes), so the
   * width asserted is the width written: a string, a plain array or a subclass
   * reporting another length is refused or framed by its real bytes. The
   * spent sets (`pool/spent-set.ts`, `pool/v3/spent-set.ts`) fill preallocated
   * frames instead, hashed hundreds of times per nullifier, and assert each
   * field's width and type themselves.
   */
  fixed(bytes: Uint8Array, length: number, what: string): void {
    const own = copyBytes(bytes);
    if (own.length !== length) {
      throw new EncodingError(`${what} must be ${length} bytes`);
    }
    this.write(own);
  }

  /** A 32-byte key, name, or hash. */
  key32(bytes: Uint8Array, what: string): void {
    this.fixed(bytes, FIXED32, what);
  }

  /**
   * A domain-separation tag, written first and unframed. This is the one
   * legitimate raw write: contexts are compile-time constants from
   * contexts.ts, and that module asserts they are prefix-free, so the first
   * field of two different message types always differs within the shorter
   * tag. Framing them would add bytes without adding a property. A whole
   * message this module encoded may open another the same way (a statement
   * opening its record, a receipt's signed bytes their encoding): it starts
   * with its own tag and frames every field, so its end is known without a
   * length. Nothing else is written raw.
   */
  context(tag: Uint8Array): void {
    this.write(copyBytes(tag));
  }

  /** u32 length followed by the bytes. */
  lengthPrefixed(bytes: Uint8Array): void {
    const own = copyBytes(bytes);
    this.u32(own.length);
    this.write(own);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }

  private write(own: Uint8Array): void {
    for (const b of own) this.out.push(b);
  }
}

export class ByteReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  /**
   * Bytes only, read from the reader's own copy. `readonly Uint8Array` is
   * erased at runtime, so a decoder handed a string, an object or nothing
   * would otherwise fail with a TypeError naming no boundary, where every
   * decoder's contract is EncodingError. The copy (copyBytes) fixes the input
   * as it was when decoding began: a subclass cannot report another length or
   * hand back other memory from `subarray`, and a caller or another thread
   * sharing the buffer cannot change bytes between two reads.
   */
  constructor(bytes: Uint8Array) {
    this.bytes = copyBytes(bytes);
  }

  u8(): number {
    if (this.offset + 1 > this.bytes.length) throw new EncodingError("truncated");
    return this.bytes[this.offset++] as number;
  }

  i8(): number {
    const n = this.u8();
    return n > 127 ? n - 256 : n;
  }

  u32(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) n = n * 256 + this.u8();
    return n;
  }

  u64(): bigint {
    let n = 0n;
    for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(this.u8());
    return n;
  }

  raw(length: number): Uint8Array {
    // A decoder's own length, not input: a negative or fractional one is a
    // programming failure and stays visible rather than rewinding the offset.
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("read length is not a byte count");
    if (length > this.bytes.length - this.offset) throw new EncodingError("truncated");
    const out = copyBytes(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return out;
  }

  lengthPrefixed(maxLength: number): Uint8Array {
    if (!Number.isSafeInteger(maxLength) || maxLength < 0) throw new RangeError("field bound is not a byte count");
    const length = this.u32();
    if (length > maxLength) throw new EncodingError("field too long");
    return this.raw(length);
  }

  /** Every decode must end here: trailing bytes are not canonical. */
  expectEnd(): void {
    if (this.offset !== this.bytes.length) {
      throw new EncodingError("trailing bytes");
    }
  }
}
