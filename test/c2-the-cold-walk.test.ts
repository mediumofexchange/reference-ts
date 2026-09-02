import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { makeBacking, type Backing } from "../src/backing.js";
import {
  operatorAt,
  replacementHash,
  replacementMessage,
  ROLE_OPERATOR,
  successionAhead,
  successionOf,
  type Replacement,
  type WitnessedReplacement,
} from "../src/replacement.js";
import { LocalVenue } from "../src/venue.js";
import { KEYS, pub, SECRETS } from "./support.js";

// §C2, slice 37: **a published replacement is judged once — against the venue
// that answered it — and junk leaves nothing behind.** Anyone files a
// replacement record for any backing for free, and the walk verifies two
// strict Ed25519 signatures per record before it looks at a link. Re-walked
// on every block (the sequencer's cache is keyed on the witnessed index) and
// on every verifier call, a stranger's 4,000 records made one door call cost
// fourteen seconds, every block, forever (the panel: `scratch/panel37/`).
//
// The memo keeps only the records it ADMITTED, positionally, per venue object,
// keyed on the backing name and the rule key; the verify stays first, before
// the fields-hash dedup and everything after it. What the suite was green
// without, and must not be again: a junk twin published first taking the
// signed handover's slot; a hand-built backing poisoning the real one's walk;
// a malformed record collapsing the walk to the genesis chain.

// Every strict verify the walk makes, counted: the mechanism's claim is a
// number of verifies, not a time.
vi.mock("../src/keys.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/keys.js")>();
  return { ...mod, verifySignatureStrict: vi.fn(mod.verifySignatureStrict) };
});
import { verifySignatureStrict } from "../src/keys.js";
const verifies = () => vi.mocked(verifySignatureStrict).mock.calls.length;

const HEIR_SECRET = new Uint8Array(32).fill(0x0b);
const HEIR = pub(HEIR_SECRET);
const MALLORY_SECRET = new Uint8Array(32).fill(0x0c);
const MALLORY = pub(MALLORY_SECRET);

function backingFor(venue: LocalVenue, rule: Uint8Array = KEYS.backer): Backing {
  return makeBacking({
    obligor: KEYS.backer,
    payout: { thing: "EUR", quantumExponent: -2, perUnit: 100n },
    reliance: [],
    evidence: {
      setting: "transparent",
      operator: KEYS.operator,
      silence: { noCommitmentDuration: 1000n, challengeWindow: 5n },
      witnessing: { venue: venue.id, interval: 5n },
      replacementRule: rule,
    },
  });
}

function unsignedTo(backing: Backing, successor: Uint8Array, effective: bigint): Replacement {
  return {
    role: ROLE_OPERATOR,
    successor,
    predecessor: backing.name,
    effective,
    signature: new Uint8Array(64),
    successorSignature: new Uint8Array(64),
  };
}

/** A replacement the rule-holder and the successor both signed. */
function signed(backing: Backing, ruleSecret: Uint8Array, successorSecret: Uint8Array, effective: bigint): Replacement {
  const unsigned = unsignedTo(backing, pub(successorSecret), effective);
  const message = replacementMessage(backing.name, unsigned);
  return {
    ...unsigned,
    signature: ed25519.sign(message, ruleSecret),
    successorSignature: ed25519.sign(message, successorSecret),
  };
}

/** A stranger's record: well-formed, nobody's signature. */
function junk(backing: Backing, seed: number): Replacement {
  const r = unsignedTo(backing, pub(new Uint8Array(32).fill(0x20 + (seed % 200))), 10n);
  r.signature.fill(seed & 0xff);
  r.successorSignature.fill((seed >> 8) & 0xff);
  return r;
}

/** The same fields as a signed record, a stranger's signatures. */
function twinOf(real: Replacement): Replacement {
  return { ...real, signature: new Uint8Array(64).fill(1), successorSignature: new Uint8Array(64).fill(2) };
}

function at(venue: LocalVenue, index: bigint): void {
  const now = venue.witnessedIndex();
  if (index > now) venue.advance(index - now);
}

const chainOf = (backing: Backing, venue: LocalVenue): string[] =>
  successionOf(backing, venue).map((link) =>
    Buffer.from(link.operator).equals(Buffer.from(KEYS.operator))
      ? "operator"
      : Buffer.from(link.operator).equals(Buffer.from(HEIR))
        ? "heir"
        : Buffer.from(link.operator).equals(Buffer.from(MALLORY))
          ? "mallory"
          : "?",
  );

describe("§C2: a published replacement is judged once, against the venue that answered it", () => {
  it("a stranger's records cost one verify each on the first walk and none on the next; a new record costs one more", () => {
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    for (let i = 0; i < 50; i++) venue.publishReplacement(eur.name, junk(eur, i));
    vi.mocked(verifySignatureStrict).mockClear();
    expect(chainOf(eur, venue)).toEqual(["operator"]);
    // Junk fails the rule-holder's signature, the first of two: one verify each.
    expect(verifies()).toBe(50);
    at(venue, 1n);
    expect(chainOf(eur, venue)).toEqual(["operator"]);
    expect(verifies()).toBe(50); // judged once
    at(venue, 2n);
    venue.publishReplacement(eur.name, junk(eur, 99));
    expect(chainOf(eur, venue)).toEqual(["operator"]);
    expect(verifies()).toBe(51); // only the new record
    // And a signed record, admitted, costs its two verifies once as well.
    at(venue, 3n);
    venue.publishReplacement(eur.name, signed(eur, SECRETS.backer, HEIR_SECRET, 10n));
    expect(verifies()).toBe(51);
    expect(chainOf(eur, venue)).toEqual(["operator"]);
    expect(verifies()).toBe(53);
    at(venue, 10n);
    expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
    expect(verifies()).toBe(53);
  });

  it("the memo is the venue's: a second venue holding different records for the same backing gets its own", () => {
    const a = new LocalVenue();
    const b = new LocalVenue();
    const eur = backingFor(a);
    a.publishReplacement(eur.name, signed(eur, SECRETS.backer, HEIR_SECRET, 10n));
    b.publishReplacement(eur.name, junk(eur, 7));
    at(a, 10n);
    at(b, 10n);
    expect(chainOf(eur, a)).toEqual(["operator", "heir"]);
    expect(chainOf(eur, b)).toEqual(["operator"]);
    expect(chainOf(eur, a)).toEqual(["operator", "heir"]);
  });

  it("a junk twin of the honest record, published FIRST, does not displace the signed handover", () => {
    // The dedup keeps one record per set of signed FIELDS at its first
    // witnessing, and the same-index tie resolves by the fields hash — both
    // deliberately blind to the signatures. Verified after either, a twin
    // (the honest record's fields, a stranger's signatures) takes the slot
    // and then fails, and the handover vanishes; verified first, the twin is
    // never among the records those rules compare. Both venues, both orders.
    const early = new LocalVenue();
    const eur = backingFor(early);
    const real = signed(eur, SECRETS.backer, HEIR_SECRET, 10n);
    early.publishReplacement(eur.name, twinOf(real));
    at(early, 3n);
    early.publishReplacement(eur.name, real);
    at(early, 10n);
    expect(chainOf(eur, early)).toEqual(["operator", "heir"]);

    const late = new LocalVenue();
    const eur2 = backingFor(late);
    const real2 = signed(eur2, SECRETS.backer, HEIR_SECRET, 10n);
    late.publishReplacement(eur2.name, real2);
    at(late, 3n);
    late.publishReplacement(eur2.name, twinOf(real2));
    at(late, 10n);
    expect(chainOf(eur2, late)).toEqual(["operator", "heir"]);
  });

  it("a hand-built backing with the real name and another rule key does not poison the real backing's walk, in either order", () => {
    // The Backing brand is a phantom type: an object carrying the real name
    // and a substituted rule key is a Backing at runtime, and its admitted
    // records are its own — never the real backing's, and never served to it.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const forged = { ...eur, evidence: { ...eur.evidence, replacementRule: MALLORY } } as Backing;
    venue.publishReplacement(eur.name, signed(eur, MALLORY_SECRET, MALLORY_SECRET, 5n));
    venue.publishReplacement(eur.name, signed(eur, SECRETS.backer, HEIR_SECRET, 10n));
    at(venue, 10n);
    expect(chainOf(forged, venue)).toEqual(["operator", "mallory"]); // its own rule, its own answer
    expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
    expect(chainOf(forged, venue)).toEqual(["operator", "mallory"]);
    expect(operatorAt(eur, venue, 10n)).toEqual(HEIR);
  });

  it("a hand-built object carrying another backing's nameHex cannot write its count into that backing's memo", () => {
    // The admission reads `backing.name`; a key that read `nameHex` — a
    // separate field — let an object with its own name but the victim's
    // nameHex (and the same rule) judge its own records and record the count
    // under the victim's slot, so the victim's first positions were never
    // judged and a handover among them was invisible (the review's ADV-6).
    const venue = new LocalVenue();
    const victim = backingFor(venue);
    const decoy = makeBacking({
      obligor: KEYS.backer,
      payout: { thing: "USD", quantumExponent: -2, perUnit: 100n },
      reliance: [],
      evidence: victim.evidence,
    });
    for (let i = 0; i < 3; i++) venue.publishReplacement(victim.name, junk(victim, i));
    at(venue, 3n);
    venue.publishReplacement(victim.name, signed(victim, SECRETS.backer, HEIR_SECRET, 10n));
    for (let i = 3; i < 5; i++) venue.publishReplacement(victim.name, junk(victim, i));
    for (let i = 0; i < 6; i++) venue.publishReplacement(decoy.name, junk(decoy, i));
    const forged = { ...decoy, nameHex: victim.nameHex } as Backing;
    at(venue, 10n);
    expect(chainOf(forged, venue)).toEqual(["operator"]); // its own six junk records, judged
    expect(chainOf(victim, venue)).toEqual(["operator", "heir"]); // the victim's own six, judged
  });

  it("the memo holds its own copies: a record overwritten after admission neither seats nor unseats anyone", () => {
    // Retained uncopied, a venue's shared object written after the first
    // walk would have seated a successor no signature covers — where the
    // uncached walk merely stopped verifying the record (the review's
    // ADV-3). The local venue hands out copies; this adapter does not.
    const backing = new LocalVenue();
    const eur = backingFor(backing);
    const stored: WitnessedReplacement = { replacement: signed(eur, SECRETS.backer, HEIR_SECRET, 10n), at: 3n };
    class Shares extends LocalVenue {
      override replacementsFor(): WitnessedReplacement[] {
        return [stored];
      }
    }
    const venue = new Shares();
    at(venue, 10n);
    expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
    stored.replacement.successor.set(MALLORY);
    (stored.replacement as { effective: bigint }).effective = 1n;
    expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
    expect(operatorAt(eur, venue, 10n)).toEqual(HEIR);
  });

  it("a hundred and twenty-six thousand admitted records do not collapse the walk: the memo grows without a stack bound", () => {
    // `push(...fresh)` spread a batch as arguments; past V8's argument limit
    // (~125,000) the RangeError landed inside `answering`, whose fallback is
    // the genesis chain — the retired operator back in force for that
    // reader, permanently, since the count never advanced (the review's B2).
    // Admission stubbed to true: the claim is about the COUNT, not the
    // signatures, and 126,000 real verifies would take ten minutes.
    const real = vi.mocked(verifySignatureStrict).getMockImplementation()!;
    vi.mocked(verifySignatureStrict).mockImplementation(() => true);
    try {
      const venue = new LocalVenue();
      const eur = backingFor(venue);
      for (let i = 0; i < 126_000; i++) {
        venue.publishReplacement(eur.name, unsignedTo(eur, HEIR, 10n + BigInt(i)));
      }
      at(venue, 200_000n);
      expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
      expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
    } finally {
      vi.mocked(verifySignatureStrict).mockImplementation(real);
    }
  }, 60_000);

  it("the chain at any index is a prefix cut of the clock-free walk, and the next link is the pending one", () => {
    // The property every chain cache in the system is sound because of,
    // asserted at the walk rather than implied at a door: nothing in the
    // choice of links reads the clock, and every pushed link's `from` is
    // strictly later than the incumbent's, so the answer at index i is the
    // longest prefix whose links have arrived, plus the first that has not.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    const first = signed(eur, SECRETS.backer, HEIR_SECRET, 10n);
    venue.publishReplacement(eur.name, first);
    const second: Replacement = (() => {
      const unsigned = { ...unsignedTo(eur, MALLORY, 20n), predecessor: replacementHash(eur.name, first) };
      const message = replacementMessage(eur.name, unsigned);
      return { ...unsigned, signature: ed25519.sign(message, SECRETS.backer), successorSignature: ed25519.sign(message, MALLORY_SECRET) };
    })();
    venue.publishReplacement(eur.name, second);
    const seen: string[][] = [];
    for (let i = 0n; i <= 25n; i++) {
      at(venue, i);
      seen.push(successionAhead(eur, venue).map((link) => `${link.from}`));
    }
    const full = successionAhead(eur, venue).map((link) => link.from); // [0, 10, 20], all arrived
    expect(full).toEqual([0n, 10n, 20n]);
    for (let i = 0; i <= 25; i++) {
      const arrived = full.filter((from) => from <= BigInt(i));
      const pending = full.find((from) => from > BigInt(i));
      const cut = [...arrived, ...(pending === undefined ? [] : [pending])].map((from) => `${from}`);
      expect(seen[i]).toEqual(cut);
    }
  });

  it("a junk record at the honest record's own index cannot take its slot, whatever its hash", () => {
    // One candidate is considered per witnessed index — the lesser record
    // hash — and that rule is priced on both records being the rule-holder's.
    // A stranger's record at the same index, verified first, is never in the
    // sort at all (the panel inventory's promise 2).
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    at(venue, 3n);
    for (let i = 0; i < 12; i++) venue.publishReplacement(eur.name, junk(eur, 300 + i));
    venue.publishReplacement(eur.name, signed(eur, SECRETS.backer, HEIR_SECRET, 10n));
    for (let i = 12; i < 24; i++) venue.publishReplacement(eur.name, junk(eur, 300 + i));
    at(venue, 10n);
    expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
  });

  it("an unsigned record naming the incumbent does not revoke a co-signed pending handover", () => {
    // The self-naming exemption is a revocation only when the rule-holder
    // and the incumbent both signed it; a stranger's naming is nothing (the
    // panel inventory's promise 3).
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    at(venue, 3n);
    venue.publishReplacement(eur.name, signed(eur, SECRETS.backer, HEIR_SECRET, 10n));
    at(venue, 5n);
    venue.publishReplacement(eur.name, unsignedTo(eur, KEYS.operator, 6n));
    expect(successionAhead(eur, venue).map((link) => `${link.from}`)).toEqual(["0", "10"]);
    at(venue, 10n);
    expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
  });

  it("a malformed record a venue hands out drops itself, not the walk", () => {
    // The local venue refuses a record that does not encode, so only a venue
    // adapter can produce one. Hashed before it is verified, it throws inside
    // the walk's `answering` and the whole walk falls back to the genesis
    // chain — the retired operator back in force for that reader. Verified
    // first, its own try/catch drops it alone.
    const venue = new LocalVenue();
    const eur = backingFor(venue);
    venue.publishReplacement(eur.name, signed(eur, SECRETS.backer, HEIR_SECRET, 10n));
    at(venue, 10n);
    const malformed: WitnessedReplacement = {
      replacement: { ...unsignedTo(eur, new Uint8Array(31), 12n) },
      at: 11n,
    };
    class Adapter extends LocalVenue {
      override replacementsFor(name: Uint8Array): WitnessedReplacement[] {
        return [...venue.replacementsFor(name), malformed];
      }
    }
    const adapter = new Adapter();
    at(adapter, 12n);
    expect(chainOf(eur, adapter)).toEqual(["operator", "heir"]);
  });

  it("a view that shrank is judged again from scratch", () => {
    // Out of the Venue contract, and the one direction the memo detects: the
    // count went down, so nothing it judged is trusted. (A view that changed a
    // record in place at the same length is NOT detected — the documented
    // lean, priced in the panel entry.)
    let records: WitnessedReplacement[] = [];
    class Reorg extends LocalVenue {
      override replacementsFor(): WitnessedReplacement[] {
        return records.map((w) => ({ ...w }));
      }
    }
    const venue = new Reorg();
    const eur = backingFor(venue);
    const heir = signed(eur, SECRETS.backer, HEIR_SECRET, 10n);
    const mallory = signed(eur, SECRETS.backer, MALLORY_SECRET, 10n);
    records = [{ replacement: heir, at: 5n }, { replacement: mallory, at: 6n }];
    at(venue, 12n);
    // Witnessed before the heir's effective index, the later record supersedes.
    expect(chainOf(eur, venue)).toEqual(["operator", "mallory"]);
    records = [{ replacement: heir, at: 5n }]; // the chain reorganised mallory's record away
    expect(chainOf(eur, venue)).toEqual(["operator", "heir"]);
  });
});
