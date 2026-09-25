import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  bigintToMinimalBytes, ByteReader, ByteWriter, compareBytes, copyArray, copyBytes, EncodingError, minimalBytesToBigint,
} from "../src/bytes.js";
import * as contexts from "../src/contexts.js";
import { contextsArePrefixFree } from "../src/contexts.js";

// The byte primitives, pinned against literal expected output.
//
// These cannot be checked by round-trip tests: signing and verifying use the
// same encoder, so a byte-order bug in u64 would round-trip perfectly and pass
// every signature test while producing a wire format no other implementation
// agrees with. Only literal expectations catch that.

function hex(write: (w: ByteWriter) => void): string {
  const w = new ByteWriter();
  write(w);
  return bytesToHex(w.finish());
}

describe("ByteWriter primitives are big-endian and exact", () => {
  it("u64 is 8 bytes, big-endian", () => {
    expect(hex((w) => w.u64(0n))).toBe("0000000000000000");
    expect(hex((w) => w.u64(1n))).toBe("0000000000000001");
    expect(hex((w) => w.u64(258n))).toBe("0000000000000102");
    expect(hex((w) => w.u64(0x0100000000000000n))).toBe("0100000000000000");
    expect(hex((w) => w.u64(0xffffffffffffffffn))).toBe("ffffffffffffffff");
  });

  it("u32 is 4 bytes, big-endian; i8 is two's complement", () => {
    expect(hex((w) => w.u32(258))).toBe("00000102");
    expect(hex((w) => w.i8(-2))).toBe("fe");
    expect(hex((w) => w.i8(127))).toBe("7f");
  });

  it("lengthPrefixed writes a u32 count then the bytes", () => {
    expect(hex((w) => w.lengthPrefixed(Uint8Array.of(1, 2, 3)))).toBe("00000003010203");
  });

  it("out-of-range values are rejected rather than truncated", () => {
    expect(() => hex((w) => w.u64(-1n))).toThrow(EncodingError);
    expect(() => hex((w) => w.u64(1n << 64n))).toThrow(EncodingError);
    expect(() => hex((w) => w.u32(-1))).toThrow(EncodingError);
    expect(() => hex((w) => w.i8(128))).toThrow(EncodingError);
  });
});

describe("the framing rule is enforced at the writer", () => {
  it("key32 accepts exactly 32 bytes and rejects anything else", () => {
    expect(hex((w) => w.key32(new Uint8Array(32).fill(0xab), "k")).length).toBe(64);
    expect(() => hex((w) => w.key32(new Uint8Array(31), "k"))).toThrow(EncodingError);
    expect(() => hex((w) => w.key32(new Uint8Array(33), "k"))).toThrow(EncodingError);
  });

  it("two fixed fields cannot borrow bytes from each other", () => {
    // The collision the rule exists to prevent: 31+33 concatenates exactly
    // like 32+32, so an unframed writer gives two field pairs one encoding.
    const all = new Uint8Array(64);
    for (let i = 0; i < 64; i++) all[i] = i + 1;
    const framed = hex((w) => {
      w.key32(all.slice(0, 32), "a");
      w.key32(all.slice(32), "b");
    });
    expect(framed).toBe(bytesToHex(all));
    expect(() =>
      hex((w) => {
        w.key32(all.slice(0, 31), "a");
        w.key32(all.slice(31), "b");
      }),
    ).toThrow(EncodingError);
  });
});

describe("every byte write and read works on its own copy", () => {
  // A subclass whose length and subarray lie: the intrinsic bytes are 1..31.
  class Lying extends Uint8Array {
    override get length(): number { return 32; }
    override subarray(): Uint8Array<ArrayBuffer> { return new Uint8Array(32).fill(7); }
  }
  const lying = (): Uint8Array => new Lying(Array.from({ length: 31 }, (_, i) => i + 1));

  it("fixed and key32 assert the width of the bytes they write", () => {
    expect(() => hex((w) => w.key32(lying(), "k"))).toThrow("k must be 32 bytes");
    for (const fake of ["a".repeat(32), Array(32).fill(1), new Proxy(new Uint8Array(32), {})]) {
      expect(() => hex((w) => w.key32(fake as unknown as Uint8Array, "k")), typeof fake).toThrow("not a byte array");
    }
    expect(() => hex((w) => w.fixed(new Uint8ClampedArray(4) as unknown as Uint8Array, 4, "f"))).toThrow("not a byte array");
  });

  it("lengthPrefixed frames the bytes it writes, never a reported length", () => {
    expect(hex((w) => w.lengthPrefixed(lying()))).toBe("0000001f" + bytesToHex(Uint8Array.from(lying())));
    expect(() => hex((w) => w.lengthPrefixed("abc" as unknown as Uint8Array))).toThrow("not a byte array");
    expect(() => hex((w) => w.context([1, 2] as unknown as Uint8Array))).toThrow("not a byte array");
  });

  it("u64 and bigintToMinimalBytes refuse a number as an encoding error", () => {
    expect(() => hex((w) => w.u64(5 as unknown as bigint))).toThrow("u64 out of range");
    expect(() => bigintToMinimalBytes(5 as unknown as bigint)).toThrow("not a bigint");
  });

  it("ByteReader reads the input as it was, through neither its length nor its subarray", () => {
    const r = new ByteReader(lying());
    expect(bytesToHex(r.raw(31))).toBe(bytesToHex(Uint8Array.from(lying())));
    r.expectEnd();
    const input = Uint8Array.of(0, 0, 0, 2, 9, 9);
    const later = new ByteReader(input);
    input.fill(0xff);
    expect(bytesToHex(later.lengthPrefixed(2))).toBe("0909");
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    shared[0] = 5;
    const fromShared = new ByteReader(shared);
    shared[0] = 6;
    expect(fromShared.u8()).toBe(5);
    for (const fake of [new Proxy(new Uint8Array(2), {}), [1, 2], "ab"]) {
      expect(() => new ByteReader(fake as unknown as Uint8Array)).toThrow("not a byte array");
    }
  });

  it("a read length or bound that is not a byte count is a visible programming failure", () => {
    for (const length of [-1, 1.5, NaN, Infinity, "2" as unknown as number]) {
      const r = new ByteReader(Uint8Array.of(0, 0, 0, 0));
      expect(() => r.raw(length), String(length)).toThrow("read length is not a byte count");
      expect(() => r.lengthPrefixed(length), String(length)).toThrow("field bound is not a byte count");
      expect(() => copyArray([1], v => v, length), String(length)).toThrow("array limit is not a count");
    }
    const r = new ByteReader(Uint8Array.of(1, 2));
    expect(() => r.raw(3)).toThrow("truncated");
    expect(bytesToHex(r.raw(2))).toBe("0102");
    r.expectEnd();
  });

  it("the other primitives refuse look-alikes by their brand, never reading a reported length", () => {
    const float = new Float64Array([1.5, 300]);
    Object.setPrototypeOf(float, Uint8Array.prototype);
    expect(() => copyBytes(float as unknown as Uint8Array)).toThrow("not a byte array");
    expect(() => minimalBytesToBigint([1, 300] as unknown as Uint8Array)).toThrow("not a byte array");
    expect(minimalBytesToBigint(Uint8Array.of(1, 44))).toBe(300n);
    expect(() => compareBytes("a" as unknown as Uint8Array, "b" as unknown as Uint8Array)).toThrow("not a byte array");
    const short = Uint8Array.of(1, 2, 3);
    Object.defineProperty(short, "length", { value: 2 });
    expect(compareBytes(short, Uint8Array.of(1, 2))).toBe(1);
    expect(compareBytes(lying(), lying())).toBe(0);
    expect(compareBytes(Buffer.from([2]), Uint8Array.of(1, 9))).toBe(1);
  });
});

describe("bigintToMinimalBytes is unsigned big-endian with no leading zero", () => {
  it("matches literal expectations across the range", () => {
    expect(bytesToHex(bigintToMinimalBytes(0n))).toBe("");
    expect(bytesToHex(bigintToMinimalBytes(1n))).toBe("01");
    expect(bytesToHex(bigintToMinimalBytes(255n))).toBe("ff");
    expect(bytesToHex(bigintToMinimalBytes(256n))).toBe("0100");
    expect(bytesToHex(bigintToMinimalBytes(0x1ffn))).toBe("01ff");
    expect(bytesToHex(bigintToMinimalBytes(1n << 255n))).toBe(
      "8000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("rejects a negative quantity", () => {
    expect(() => bigintToMinimalBytes(-1n)).toThrow(EncodingError);
  });
});

describe("domain-separation tags are prefix-free", () => {
  it("no live tag is a prefix of another, including any exported but left out of the load-time list", () => {
    expect(contextsArePrefixFree()).toBe(true);
    const exported = Object.values(contexts).filter((v): v is Uint8Array => v instanceof Uint8Array);
    expect(exported.length).toBe(47);
    expect(contextsArePrefixFree(exported)).toBe(true);
  });

  it("the check actually detects a prefix collision", () => {
    const enc = new TextEncoder();
    expect(contextsArePrefixFree([enc.encode("moe/burn/v1"), enc.encode("moe/burn/v11")])).toBe(false);
    expect(contextsArePrefixFree([enc.encode("moe/a/v1"), enc.encode("moe/b/v1")])).toBe(true);
  });
});

describe("copyBytes owns what it returns", () => {
  it("copies a subclass without its species, and refuses look-alikes", () => {
    const shared = new Uint8Array(4);
    class Aliasing extends Uint8Array {
      static get [Symbol.species]() { return function () { return shared; } as unknown as Uint8ArrayConstructor; }
    }
    const copy = copyBytes(new Aliasing([1, 2, 3, 4]));
    expect(copy).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(Object.getPrototypeOf(copy)).toBe(Uint8Array.prototype);
    copy.fill(9);
    expect(shared).toEqual(new Uint8Array(4));
    expect(copyBytes(Buffer.from([5, 6]))).toEqual(new Uint8Array([5, 6]));
    const view = new DataView(new ArrayBuffer(4));
    Object.setPrototypeOf(view, Uint8Array.prototype);
    for (const fake of [new Proxy(new Uint8Array(4), {}), view, [1, 2], "ab"]) {
      expect(() => copyBytes(fake as Uint8Array)).toThrow(EncodingError);
    }
  });
});

describe("copyArray owns what it returns", () => {
  it("reads by index once, consulting neither the argument's species nor its iterator, up to its limit", () => {
    const held: number[] = [];
    const values = [1, 2, 3];
    Object.defineProperty(values, "constructor", { value: { [Symbol.species]: function () { return held; } } });
    Object.defineProperty(values, Symbol.iterator, { value: function* () { for (;;) yield 0; } });
    const copy = copyArray(values, v => v * 10);
    expect(copy).toEqual([10, 20, 30]);
    expect(Object.getPrototypeOf(copy)).toBe(Array.prototype);
    expect(held).toEqual([]);
    let reads = 0;
    const counted = new Proxy([7, 8], { get: (target, key, receiver) => { if (key === "length") reads++; return Reflect.get(target, key, receiver); } });
    expect(copyArray(counted, v => v)).toEqual([7, 8]);
    expect(reads).toBe(1);
    expect(copyArray([1, 2], v => v, 2)).toEqual([1, 2]);
    expect(() => copyArray([1, 2, 3], v => v, 2)).toThrow(EncodingError);
    for (const length of [1.5, -1, NaN]) {
      const lying = new Proxy([1, 2], { get: (target, key, receiver) => (key === "length" ? length : Reflect.get(target, key, receiver)) });
      expect(() => copyArray(lying, v => v), String(length)).toThrow("not an array");
    }
    for (const fake of [{ length: 1, 0: 1 }, "ab", new Uint8Array(2)]) {
      expect(() => copyArray(fake as unknown as number[], v => v)).toThrow(EncodingError);
    }
  });
});
