// The construction a `moe` directory declares (slice 14 M14g4): pool-v3's, or lit-v1's (a draft until adopted). It
// is chosen once, at `init` (`--construction`), and kept in config.json; a directory made before the choice existed
// is pool-v3's. Every file a directory holds serves one construction (a journal, a wallet and an evidence file each
// name their configuration domain), so a directory's terms, journal, wallet, service client and reads all go through
// the one it declares, and terms of the other are refused by name. A construction without proofs (lit) keeps no
// proving parameters and opens no verifier.
import { LIT } from "../lit/construction.js";
import { POOL_V3, type Construction } from "../pool/v3/construction.js";

export const CONSTRUCTION_NAMES = Object.freeze(["moe/pool/v3", "moe/lit/v1"] as const);
export type ConstructionName = (typeof CONSTRUCTION_NAMES)[number];
/** What a directory made before `--construction` existed declares. */
export const DEFAULT_CONSTRUCTION: ConstructionName = "moe/pool/v3";

const BY_NAME: Readonly<Record<ConstructionName, Construction>> = Object.freeze({
  "moe/pool/v3": POOL_V3 as Construction, "moe/lit/v1": LIT as Construction,
});

export const isConstructionName = (value: unknown): value is ConstructionName =>
  typeof value === "string" && (CONSTRUCTION_NAMES as readonly string[]).includes(value);
export const constructionNamed = (name: ConstructionName): Construction => BY_NAME[name];
/** The name of one of the two constructions. */
export function nameOf(construction: Construction): ConstructionName {
  return CONSTRUCTION_NAMES.find(name => BY_NAME[name] === construction)!;
}
/** The construction a directory's configuration declares. */
export const declared = (config: { readonly construction?: ConstructionName | undefined }): Construction =>
  BY_NAME[config.construction ?? DEFAULT_CONSTRUCTION];
/** Both constructions: what terms or a publication of the other are recognised by. */
export const constructions = (): readonly Construction[] => CONSTRUCTION_NAMES.map(name => BY_NAME[name]);
