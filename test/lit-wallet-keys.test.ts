import { describe, expect, it, vi } from "vitest";

// Every owned copy field32 makes, with what it copied, so the test sees what a derivation left in memory.
const copies: Array<{ what: string; own: Uint8Array }> = [];
vi.mock("../src/lit/notes.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/lit/notes.js")>();
  return { ...original, field32: (value: unknown, what: string) => {
    const own = original.field32(value, what);
    copies.push({ what, own });
    return own;
  } };
});
// Every HMAC digest a derivation takes, whose buffer is a second copy of the secret it derives.
const digests: Buffer[] = [];
vi.mock("node:crypto", async importOriginal => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, createHmac: (...parameters: Parameters<typeof original.createHmac>) => {
    const hmac = original.createHmac(...parameters), digest = hmac.digest.bind(hmac);
    return Object.assign(hmac, { digest: () => { const out = digest(); digests.push(out); return out; } });
  } };
});
const wallet = await import("../src/lit/wallet-keys.js");

describe("lit-v1 §8 key derivation's copies of a secret", () => {
  it("zeroes its own copy of the seed, a root or a secret, and the HMAC's digest, once a derivation is done (Next 4 (be))", () => {
    const seed = new Uint8Array(32).fill(1), domain = new Uint8Array(32).fill(2), backing = new Uint8Array(32).fill(3);
    const ownerRoot = wallet.ownerRoot(seed, domain), settlementRoot = wallet.settlementRoot(seed, domain);
    const owner = wallet.ownerSecretAt(ownerRoot, backing, 7n);
    for (const [derive, what] of [
      [() => wallet.ownerRoot(seed, domain), "seed"],
      [() => wallet.settlementRoot(seed, domain), "seed"],
      [() => wallet.ownerSecret(seed, domain, backing, 7n), "seed"],
      [() => wallet.ownerSecretAt(ownerRoot, backing, 7n), "owner root"],
      [() => wallet.acceptSecretAt(settlementRoot, backing, 9n), "settlement root"],
      [() => wallet.publicKeyOf(owner), "secret"],
    ] as const) {
      copies.length = 0; digests.length = 0;
      expect(derive().some(byte => byte !== 0)).toBe(true);
      for (const digest of digests) expect(digest.every(byte => byte === 0)).toBe(true);
      const secret = copies.filter(copy => ["seed", "owner root", "settlement root", "secret"].includes(copy.what));
      expect(secret.map(copy => copy.what)).toContain(what);
      for (const copy of secret) expect([copy.what, copy.own.every(byte => byte === 0)]).toEqual([copy.what, true]);
    }
    // The caller's own secrets are left as given.
    expect([seed, ownerRoot, settlementRoot, owner].every(s => s.some(byte => byte !== 0))).toBe(true);
  });
});
