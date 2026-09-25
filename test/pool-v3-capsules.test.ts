import { createCipheriv, createHash, hkdfSync, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as api from "../src/pool/v3/capsules.js";
import {
  CAPSULE_BYTES, CapsuleAssociationError, CapsuleFormatError, PROFILE, createCapsuleScanner, deriveMasterKeys,
  deriveNonzeroField, deriveSettlementOwnerSecret, prepareExactOutput, recoverCapsule,
} from "../src/pool/v3/capsules.js";
import { deliveryHash } from "../src/pool/v3/records.js";
import { EncodingError } from "../src/bytes.js";
import { fieldToBytes, fieldToHex, FIELD_MODULUS } from "../src/pool/field.js";
import { commitmentOf, nullifierOf, ownerOf } from "../src/pool/notes.js";

// pool-delivery C4.2–C4.4, C4.6's scan and C4.7 at 02d911c.
const sequence = (start: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (start + i) & 0xff);
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");
const ascii = (text: string): Buffer => Buffer.from(text, "ascii");
const u64be = (value: bigint): Buffer => { const out = Buffer.alloc(8); out.writeBigUInt64BE(value); return out; };

const seed = sequence(0x01), otherSeed = sequence(0x91), domain = sequence(0x21), otherDomain = sequence(0xb1);
const backing = sequence(0x41), otherBacking = sequence(0xc1), requestId = sequence(0x61), otherRequestId = sequence(0xe1);
const base = prepareExactOutput(seed, domain, requestId, backing, 73n);

/** Test-only bypass: an AEAD under a caller-chosen cm, which the library never exports. */
function forgeAssociatedCapsule(recoveryKey: Uint8Array, cm: bigint, value: bigint): Uint8Array {
  const key = new Uint8Array(hkdfSync("sha256", recoveryKey, fieldToBytes(cm),
    Buffer.concat([ascii("moe/wallet/recovery/v1/capsule"), domain]), 32));
  const aad = Buffer.concat([ascii("moe/wallet/recovery/v1/aad"), Buffer.from([PROFILE]), domain, fieldToBytes(cm)]);
  const cipher = createCipheriv("aes-256-gcm", key, new Uint8Array(12), { authTagLength: 16 });
  cipher.setAAD(aad, { plaintextLength: 72 });
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([requestId, backing, u64be(value)])), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([PROFILE]), ciphertext, cipher.getAuthTag()]));
}

/** An independent derivation of the same envelope through WebCrypto. */
async function webCryptoEnvelope(cm: bigint, value: bigint): Promise<Uint8Array> {
  const subtle = webcrypto.subtle;
  const root = await subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  const recoveryKey = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: domain,
    info: ascii("moe/wallet/recovery/v1/recovery") }, root, 256));
  const recoveryBase = await subtle.importKey("raw", recoveryKey, "HKDF", false, ["deriveBits"]);
  const capsuleKey = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: fieldToBytes(cm),
    info: Buffer.concat([ascii("moe/wallet/recovery/v1/capsule"), domain]) }, recoveryBase, 256));
  const aes = await subtle.importKey("raw", capsuleKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const aad = Buffer.concat([ascii("moe/wallet/recovery/v1/aad"), Buffer.from([PROFILE]), domain, fieldToBytes(cm)]);
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: aad, tagLength: 128 },
    aes, Buffer.concat([requestId, backing, u64be(value)])));
  return new Uint8Array(Buffer.concat([Buffer.from([PROFILE]), sealed]));
}

describe("v3 capsules", () => {
  it("reproduces the recorded profile-1 vector byte for byte", () => {
    // docs/pool-delivery-verification.json (2026-09-09), from the retired probe.
    expect(base.attempts).toEqual({ spend: 2, rho: 1 });
    expect(fieldToHex(base.opening.owner)).toBe("0x22a467d1fa14a91a2802f16486f39f509c699fa00f3e5350a114792bec136a06");
    expect(fieldToHex(base.opening.rho)).toBe("0x0d2f2ac91326a35ce92a08860002daf808aedf293799fc09233c9d846d932375");
    expect(fieldToHex(base.cm)).toBe("0x08a712671bde055c383a017a485c4efe4a94b3580ec6c1e6b8eecdd9ececc50c");
    expect(fieldToHex(base.nf)).toBe("0x1a5cc255590f51fb0a91277a17cfc452871c60ae002ba2da759e2ca83d54e65d");
    expect(hex(base.capsule)).toBe("01662bfbcbf8b7272e476e9527a82defc4b56cf3b06e06f3303fe85e2c4a7ac63d1d7a496437c3bdeea60aefc4213ae6642ef017d5903e943cb62fce5474747e18d8a7de361965decb55ca32a9b8307a0f5ba829d8a18d4367");
    expect(base.capsule.length).toBe(CAPSULE_BYTES);
  });

  it("retries exactly, byte for byte", () => {
    const again = prepareExactOutput(seed, domain, requestId, backing, 73n);
    expect([again.secret, again.opening.rho, again.cm, again.nf, hex(again.capsule)])
      .toEqual([base.secret, base.opening.rho, base.cm, base.nf, hex(base.capsule)]);
    expect(again.attempts).toEqual(base.attempts);
  });

  it("separates identifier, domain, seed, backing and amount", () => {
    const variants = {
      id: prepareExactOutput(seed, domain, otherRequestId, backing, 73n),
      domain: prepareExactOutput(seed, otherDomain, requestId, backing, 73n),
      seed: prepareExactOutput(otherSeed, domain, requestId, backing, 73n),
      backing: prepareExactOutput(seed, domain, requestId, otherBacking, 73n),
      amount: prepareExactOutput(seed, domain, requestId, backing, 74n),
    };
    for (const v of Object.values(variants)) {
      expect(v.cm).not.toBe(base.cm);
      expect(hex(v.capsule)).not.toBe(hex(base.capsule));
    }
    for (const v of [variants.id, variants.domain, variants.seed]) expect(v.secret).not.toBe(base.secret);
    for (const v of [variants.backing, variants.amount]) {
      expect(v.secret).toBe(base.secret);
      expect(v.opening.rho).not.toBe(base.opening.rho);
    }
  });

  it("derives four distinct master keys", () => {
    const keys = deriveMasterKeys(seed, domain);
    expect(new Set([keys.spendKey, keys.rhoKey, keys.recoveryKey, keys.settlementKey].map(hex)).size).toBe(4);
  });

  it("accepts u64 zero and maximum and refuses values outside", () => {
    expect(prepareExactOutput(seed, domain, sequence(0x71), backing, 0n).opening.value).toBe(0n);
    expect(prepareExactOutput(seed, domain, sequence(0x72), backing, (1n << 64n) - 1n).opening.value).toBe((1n << 64n) - 1n);
    expect(() => prepareExactOutput(seed, domain, requestId, backing, -1n)).toThrow(new CapsuleFormatError("value must be a u64"));
    expect(() => prepareExactOutput(seed, domain, requestId, backing, 1n << 64n)).toThrow(new CapsuleFormatError("value must be a u64"));
  });

  it("reads fixed widths through the intrinsic length and no iterator", () => {
    class ForgedLength32 extends Uint8Array { override get length(): number { return 32; } }
    class ForgedLength89 extends Uint8Array { override get length(): number { return 89; } }
    class PoisonIterator extends Uint8Array {
      override *[Symbol.iterator](): ArrayIterator<number> { throw new Error("attacker iterator ran"); }
    }
    const poison = (source: Uint8Array): Uint8Array => {
      const value = new PoisonIterator(source.length);
      Uint8Array.prototype.set.call(value, source);
      return value;
    };
    const short32 = new ForgedLength32(31);
    expect(() => prepareExactOutput(short32, domain, requestId, backing, 1n)).toThrow("wallet root seed must be 32 bytes");
    expect(() => prepareExactOutput(seed, short32, requestId, backing, 1n)).toThrow("domain must be 32 bytes");
    expect(() => prepareExactOutput(seed, domain, short32, backing, 1n)).toThrow("request identifier must be 32 bytes");
    expect(() => prepareExactOutput(seed, domain, requestId, short32, 1n)).toThrow("backing must be 32 bytes");
    expect(() => recoverCapsule(seed, domain, base.cm, new ForgedLength89(88))).toThrow("profile-1 capsule must be 89 bytes");
    const poisoned = prepareExactOutput(poison(seed), poison(domain), poison(requestId), poison(backing), 73n);
    expect([poisoned.cm, hex(poisoned.capsule)]).toEqual([base.cm, hex(base.capsule)]);
    expect(recoverCapsule(poison(seed), poison(domain), base.cm, poison(base.capsule))?.cm).toBe(base.cm);
  });

  it("recovers the complete opening and nullifier from seed, domain, cm and capsule", () => {
    const recovered = recoverCapsule(seed, domain, base.cm, base.capsule)!;
    expect([hex(recovered.requestId), hex(recovered.backing), recovered.value]).toEqual([hex(requestId), hex(backing), 73n]);
    expect([recovered.secret, recovered.opening.rho, recovered.cm, recovered.nf])
      .toEqual([base.secret, base.opening.rho, base.cm, base.nf]);
  });

  it("answers no match for a wrong seed, commitment, domain or tampered capsule", () => {
    const other = prepareExactOutput(seed, domain, otherRequestId, backing, 73n);
    expect(recoverCapsule(otherSeed, domain, base.cm, base.capsule)).toBeNull();
    expect(recoverCapsule(seed, domain, other.cm, base.capsule)).toBeNull();
    expect(recoverCapsule(seed, otherDomain, base.cm, base.capsule)).toBeNull();
    const tampered = base.capsule.slice();
    tampered[tampered.length - 1]! ^= 1;
    expect(recoverCapsule(seed, domain, base.cm, tampered)).toBeNull();
  });

  it("refuses a truncated capsule or another profile as malformed", () => {
    expect(() => recoverCapsule(seed, domain, base.cm, base.capsule.slice(0, -1))).toThrow(new CapsuleFormatError("profile-1 capsule must be 89 bytes"));
    const wrongProfile = base.capsule.slice();
    wrongProfile[0] = 2;
    expect(() => recoverCapsule(seed, domain, base.cm, wrongProfile)).toThrow(/unsupported recovery capsule profile/);
  });

  it("exports no encryption under a caller-chosen commitment", () => {
    for (const name of ["encryptComputedCapsule", "capsuleKey", "encryptCapsule"]) expect(Object.hasOwn(api, name)).toBe(false);
  });

  it("refuses an authentic capsule whose plaintext does not recompute the declared cm", () => {
    const forged = forgeAssociatedCapsule(deriveMasterKeys(seed, domain).recoveryKey, base.cm, 74n);
    expect(() => recoverCapsule(seed, domain, base.cm, forged)).toThrow(new CapsuleAssociationError("authenticated capsule plaintext does not recompute the declared commitment"));
  });

  it("is reproduced by WebCrypto independently", async () => {
    expect(hex(await webCryptoEnvelope(base.cm, 73n))).toBe(hex(base.capsule));
  });

  it("separates the capsule subkey from the spend master", () => {
    const keys = deriveMasterKeys(seed, domain);
    const subkey = new Uint8Array(hkdfSync("sha256", keys.recoveryKey, fieldToBytes(base.cm),
      Buffer.concat([ascii("moe/wallet/recovery/v1/capsule"), domain]), 32));
    expect(hex(subkey)).not.toBe(hex(keys.spendKey));
    expect(deriveNonzeroField(subkey, requestId)).not.toBe(base.secret);
  });

  it("scans with cached master keys and counts trials and matches", () => {
    const foreign = prepareExactOutput(otherSeed, domain, sequence(0x15), backing, 29n);
    const scanner = createCapsuleScanner(seed, domain);
    expect(scanner.tryRecover(base.cm, base.capsule)?.nf).toBe(base.nf);
    expect(scanner.tryRecover(foreign.cm, foreign.capsule)).toBeNull();
    expect(scanner.stats()).toEqual({ trials: 2, matches: 1 });
  });

  it("derives the settlement owner secret from the demand and deadline (C4.7)", () => {
    const demand = sequence(0x31), deadline = 9000n;
    const derived = deriveSettlementOwnerSecret(seed, domain, demand, deadline);
    const key = new Uint8Array(hkdfSync("sha256", seed, domain, ascii("moe/wallet/recovery/v1/settlement"), 32));
    let expected = 0n;
    for (let attempt = 0; ; attempt++) {
      const counter = Buffer.alloc(4); counter.writeUInt32BE(attempt);
      const digest = createHash("sha256"); // HMAC by hand, independent of the library's createHmac call
      const block = Buffer.alloc(64); Buffer.from(key).copy(block);
      const inner = createHash("sha256").update(block.map(b => b ^ 0x36)).update(demand).update(u64be(deadline)).update(counter).digest();
      const value = BigInt("0x" + digest.update(block.map(b => b ^ 0x5c)).update(inner).digest("hex"));
      if (value !== 0n && value < FIELD_MODULUS) { expected = value; expect(derived.attempt).toBe(attempt); break; }
    }
    expect(derived.value).toBe(expected);
    const opening = { backing, value: 11n, owner: ownerOf(derived.value), rho: 5n };
    const cm = commitmentOf(domain, opening);
    expect(nullifierOf(domain, cm, derived.value)).not.toBe(0n);
    expect(deriveSettlementOwnerSecret(seed, domain, demand, deadline + 1n).value).not.toBe(derived.value);
    expect(() => deriveSettlementOwnerSecret(seed, domain, demand, 1n << 64n)).toThrow(new CapsuleFormatError("value must be a u64"));
  });
});

describe("the C4.4 delivery digest over prepared capsules", () => {
  const outputs = [0x11, 0x12, 0x13, 0x14].map((id, i) => prepareExactOutput(seed, domain, sequence(id), backing, BigInt(i)));
  const cms = outputs.map(o => o.cm), capsules = outputs.map(o => o.capsule);

  it("binds the prefix, domain, count, order, commitments and exact capsules", () => {
    const manual = createHash("sha256").update(ascii("moe/pool/v3/delivery")).update(domain).update(Uint8Array.of(0, 0, 0, 4));
    for (const o of outputs) manual.update(fieldToBytes(o.cm)).update(o.capsule);
    const digest = deliveryHash(domain, cms, capsules);
    expect(hex(digest)).toBe(manual.digest("hex"));
    const swapped = [capsules[1]!, capsules[0]!, capsules[2]!, capsules[3]!];
    expect(hex(deliveryHash(domain, [cms[1]!, cms[0]!, cms[2]!, cms[3]!], swapped))).not.toBe(hex(digest));
    expect(hex(deliveryHash(domain, cms, swapped))).not.toBe(hex(digest));
    const corrupted = capsules.map(c => c.slice());
    corrupted[0]![20]! ^= 1;
    expect(hex(deliveryHash(domain, cms, corrupted))).not.toBe(hex(digest));
    expect(hex(deliveryHash(otherDomain, cms, capsules))).not.toBe(hex(digest));
  });

  it("admits only the one- and four-output vectors a v3 record carries", () => {
    expect(() => deliveryHash(domain, cms.slice(0, 3), capsules.slice(0, 3))).toThrow(EncodingError);
    expect(() => deliveryHash(domain, cms, capsules.slice(0, 3))).toThrow(EncodingError);
    expect(deliveryHash(domain, cms.slice(0, 1), capsules.slice(0, 1)).length).toBe(32);
  });
});
