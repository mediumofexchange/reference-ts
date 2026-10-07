// Signed root terms in a `moe` directory (slice 10 M10b, items 4 and 13): kept
// as their canonical bytes and signature in `terms/<backing>` and
// `terms/<backing>.sig`, so no new framing is added. `terms add`
// authenticates the backing against the name the holder supplies, as a
// request's digest is, and shows what the terms bind a holder to. Terms are
// read under the directory's construction (M14g4): their tag 5 names it, so
// terms of the other construction are refused by name.
import { mkdirSync } from "node:fs";
import { compareBytes } from "../bytes.js";
import { ERGO_SYNTHETIC_REFERENCE } from "../ergo-profile.js";
import type { Construction } from "../pool/v3/construction.js";
import type { SignedTerms } from "../pool/v3/reader.js";
import type { RootTerms } from "../pool/v3/terms.js";
import { CommandError, hex, readOptional, readRequired, writeExclusive, type Directory } from "./common.js";
import { constructions, nameOf } from "./construction.js";
import type { VenueFile } from "./venue.js";

/** Signed terms the directory keeps, with their decoded fields and name. */
export interface KeptTerms {
  readonly signed: SignedTerms;
  readonly terms: RootTerms;
  readonly backing: Uint8Array;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** Authenticate `bytes` and `signature` as the terms named `backing`, under `construction`, for this directory's venue. */
export function authenticate(bytes: Uint8Array, signature: Uint8Array, backing: Uint8Array, venue: VenueFile, synthetic: boolean,
  construction: Construction): KeptTerms {
  const codec = construction.reader.terms;
  let terms: RootTerms;
  try { terms = codec.decodeRootTerms(bytes); } catch {
    const other = constructions().find(c => c !== construction && decodes(c, bytes));
    if (other !== undefined) {
      throw new CommandError("CONSTRUCTION", `the terms declare ${nameOf(other)}; this directory serves ${nameOf(construction)}`);
    }
    throw new CommandError("INVALID", `the terms file is not canonical ${nameOf(construction)} root terms`);
  }
  if (!same(codec.rootTermsName(bytes), backing)) throw new CommandError("NAME", "the terms are not the backing named: their name differs");
  if (!codec.verifyRootTermsSignature(bytes, signature)) throw new CommandError("SIGNATURE", "the obligor did not sign these terms");
  if (!same(terms.configuration, construction.reader.domain())) {
    throw new CommandError("CONFIGURATION", `the terms name another configuration than ${nameOf(construction)}'s`);
  }
  if (!same(terms.venue, venue.id)) throw new CommandError("VENUE", "the terms name another venue than this directory's venue.json");
  if ((venue.profile.reference === ERGO_SYNTHETIC_REFERENCE) !== synthetic) {
    throw new CommandError("SYNTHETIC", synthetic ? "--synthetic is only for terms on the synthetic venue"
      : "the terms' venue is the synthetic reference chain, whose headers carry no real work: pass --synthetic to accept it");
  }
  return { signed: { terms: bytes, signature }, terms, backing };
}
const decodes = (construction: Construction, bytes: Uint8Array): boolean => {
  try { construction.reader.terms.decodeRootTerms(bytes); return true; } catch { return false; }
};

/** Keep authenticated terms; a rerun with the same bytes passes, other bytes under the name conflict. */
export function keepTerms(directory: Directory, kept: KeptTerms): void {
  mkdirSync(directory.file("terms"), { recursive: true, mode: 0o700 });
  const path = directory.file(`terms/${hex(kept.backing)}`), held = readOptional(path), sig = readOptional(`${path}.sig`);
  // Each file already there, from an earlier run or an interrupted one, must be these bytes.
  if ((held !== undefined && !same(held, kept.signed.terms)) || (sig !== undefined && !same(sig, kept.signed.signature))) {
    throw new CommandError("CONFLICT", "other terms are kept under this name");
  }
  if (sig === undefined) writeExclusive(`${path}.sig`, kept.signed.signature);
  if (held === undefined) writeExclusive(path, kept.signed.terms);
}

/** The terms kept under `backing`, authenticated again. */
export function keptTerms(directory: Directory, backing: Uint8Array, venue: VenueFile): KeptTerms {
  const path = directory.file(`terms/${hex(backing)}`);
  if (readOptional(path) === undefined) throw new CommandError("ABSENT", "no terms are kept under this backing: terms add first");
  return authenticate(readRequired(path, "terms"), readRequired(`${path}.sig`, "terms signature"), backing, venue,
    venue.profile.reference === ERGO_SYNTHETIC_REFERENCE, directory.construction);
}

/** What the terms bind a holder to, in the words of the wallet guide (M10b item 13), under the directory's construction. */
export function explain(kept: KeptTerms, venue: VenueFile, construction: Construction): object {
  const { terms } = kept, silence = terms.silence, nonService = terms.nonService, lit = !construction.reader.proofs;
  const notes = [
    "The obligor's key K signs issuance and acceptance. If K is lost, nothing more is issued or accepted, and every later demand reads as the backer's dishonour.",
    lit ? "These are lit notes (moe/lit/v1): everyone sees every statement's backings, values, owner keys and the spend graph linking each note to the notes made from it. A fresh key per note gives pseudonymity, not privacy."
      : "The operator sees each statement it admits and when; the venue shows everyone each checkpoint's supply of this backing, and a demand or settlement discloses what it names (docs/POOL_V3_VISIBILITY.md).",
    silence === undefined
      ? "These terms declare no silence clause: if the operator stops serving, no gap opens and redemption waits on the operator."
      : `If the operator publishes no commitment for ${silence.noCommitmentDuration} witnessed indices, a gap opens: holders may demand and settle by publication at the venue.`,
  ];
  if (venue.profile.reference === ERGO_SYNTHETIC_REFERENCE) notes.unshift("The venue is the synthetic reference chain: its headers carry no real work. It is for drills only.");
  return {
    backing: kept.backing, construction: nameOf(construction), obligor: terms.obligor, operator: terms.operator, configuration: terms.configuration, venue: terms.venue,
    venueContext: venue.profile.reference, payout: terms.payout, interval: terms.interval,
    silence: silence ?? null, nonService: nonService ?? null, replacementRule: terms.replacementRule ?? null, notes,
  };
}
