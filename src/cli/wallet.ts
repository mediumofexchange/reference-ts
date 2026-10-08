// `moe wallet` (slice 10 M10b, items 2, 3, 6, 8, 9, 12 and 13): a holder's
// wallet, and with `--backer` at `init` the obligor's too. The directory binds
// one venue; the wallet database (`wallet.db`, holding the seed) is created by
// `init` with `--venue`, by a backer's `venue create`, or by a restore, and no
// other command creates one, so a lost database never comes back as a fresh
// seed. K (`backer.key`, Ed25519) is read only by `terms create`, `issue` and
// `accept` and handed to the wallet as its signer: it never enters the wallet
// database or a handoff. The directory holds no funding key; a gap act leaves
// as a publication file a relay publishes (`moe relay publish`, or a third
// party's `relay serve` the file is handed to with `moe relay send`, M12c).
//
// Every mutating command names the alias the library keys on, so a rerun after
// a crash or a lost reply is the library's exact retry and prints the saved
// result; `fulfill` is never replayed (a rerun exits 4 printing the saved
// fulfillment). Evidence comes from the operator's service, synced into the
// wallet's own evidence file, or from `--package <file>`; where the service
// does not answer, a read uses the package its last sync kept, and the output
// says which (`evidence`). Deadlines are witnessed indices, absolute or
// relative to the read (`+n`).
//
// The wallet holds the construction the directory declares at init (M14g4).
// A lit wallet (lit-v1 §8) proves nothing, keeps no parameters and opens no
// verifier; its requests name an owner key (`moe/wallet/lit/v1/request`), its
// acceptance owner is a key, it has no `freshen` (presented notes spend as any
// other), `move-window` moves its owner-key window, and `presentation` reads an
// acceptance only where K and its owner key both signed it (lit-v1 §7).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { compareBytes, EncodingError } from "../bytes.js";
import { ERGO_SYNTHETIC_REFERENCE } from "../ergo-profile.js";
import type { Commitment } from "../venue-records.js";
import { adoptedDomain } from "../pool/v3/configuration.js";
import type { Construction, KeyedAcceptance, KeyedRequest } from "../pool/v3/construction.js";
import { decodePublication, encodePublication, type SignedAcceptance } from "../pool/v3/records.js";
import { encodeRootTerms } from "../pool/v3/terms.js";
import { openWalletBackup, walletBackupDigest } from "../pool/v3/wallet-backup.js";
import { authenticatePaymentRequest, encodePaymentRequest, paymentRequestDigest, type PaymentRequest } from "../pool/v3/wallet-request.js";
import { V3Wallet, type Act, type BackerSigner, type LocalProver, type Payment, type WalletReceipt, type WalletView } from "../pool/v3/wallet-store.js";
import { litConfigHash } from "../lit/configuration.js";
import { decodePublication as decodeLitPublication } from "../lit/records.js";
import { encodeLitTerms } from "../lit/terms.js";
import { authenticateLitPaymentRequest, encodeLitPaymentRequest, litPaymentRequestDigest } from "../lit/wallet.js";
import { startBackend, type ProofVerifier } from "../pool/proof-verifier.js";
import { readParameters } from "../pool/parameter-files.js";
import { CommandError, flag, has, hex, hex32, integer, openDirectory, parseArguments, print, readJson, readOptional, readRequired, readSecret, required,
  Replayed, UsageError, writeExclusive, writeReplace, writeSame, type Arguments, type Directory, type FlagSpec } from "./common.js";
import { directoryVerifier, verifierCount } from "./backend.js";
import { constructionNamed, constructions, nameOf } from "./construction.js";
import { initConstruction, initRole, presentationOf, readRepaired, repairRecord, replicaCommand, serviceClient, serviceCommand, syncSources, termsCommand, unanswered,
  type Skipped } from "./reader.js";
import { authenticate, keepTerms, keptTerms, type KeptTerms } from "./terms.js";
import { createVenue, openView, ownVenue, parseVenue, requireVenue, venueText, type View } from "./venue.js";

/** Who funds a gap act, said with the first notes and with each publication file (slice 12 M12c). */
const RELAY_NOTE = "A relay publishes a gap act from its own funding key, which the chain ties to every act it funds and to its coins' history: a relay of your own links your acts to each other and to where its coins came from; a third party's relay reached as an onion service (moe relay send) ties them to its other users' acts, not to your coins, but sees each act a little before the public and may delay or withhold it. Take its relay.json only where it is published to everyone alike, and send to a second relay only when the first has not had the act witnessed in time.";
/** Shown once, with a wallet's first request or payment (M10b item 13; docs/POOL_V3_VISIBILITY.md). */
const FIRST_NOTES = Object.freeze([
  "A request's frame links its output to whoever holds it: hand the frame on a private channel, and its digest over one that authenticates you; a payer checks the frame against the digest.",
  "The operator sees each statement it admits and when. While few statements are admitted between checkpoints, a payment and its payee's next spend can pair by timing and amount, and the venue shows each checkpoint's supply.",
  "A payee learns the amount and when it was paid; an operator taking a fee learns that too. Publishing at the venue from an identified funding key identifies the publisher.",
  RELAY_NOTE,
]);
/** A lit wallet's first notes (lit-v1 §§8, 11): everything a lit statement carries is public. */
const LIT_FIRST_NOTES = Object.freeze([
  "A lit request names a fresh owner key of this wallet: hand the frame on a private channel, and its digest over one that authenticates you; a payer checks the frame against the digest.",
  "Lit notes are public: everyone sees each statement's backings, values, owner keys and the spend graph, so a payment shows its amount, its payer's notes and the key it pays. Only the civil identity behind a key stays unknown unless disclosed.",
  "Publishing at the venue from an identified funding key identifies the publisher.",
  RELAY_NOTE,
]);
const EXPLAINED = "explained";
/** Whether the directory holds lit-v1's keyed notes (no proofs) rather than pool-v3's. */
const keyed = (directory: Directory): boolean => !directory.construction.reader.proofs;

const commitmentOut = (c: Commitment) => ({ operator: c.operator, sequence: c.sequence, root: c.root });
const receiptOut = (r: WalletReceipt | undefined) => r === undefined ? null : { operator: r.operator, segment: r.segment, position: r.position };
const finalOut = (f: { readonly checkpoint: Commitment; readonly judgingIndex: bigint } | undefined) =>
  f === undefined ? null : { checkpoint: commitmentOut(f.checkpoint), judgingIndex: f.judgingIndex };
const statusOf = (status: "prepared" | "final" | "failed") => status === "prepared" ? "pending" : status;
const KINDS = { 1: "issue", 3: "burn", 4: "demand", 5: "withdrawal", 6: "settlement" } as const;

function actOut(act: Act, construction: Construction) {
  // A demand's deadline, absolute, so a rerun after a lost reply can name it exactly.
  const deadline = act.kind === 4 ? { deadline: construction.view(construction.decode(act.record), () => undefined).demand!.value.deadline } : {};
  return { status: statusOf(act.status), kind: KINDS[act.kind], statement: act.statement, demand: act.demand ?? null, ...deadline, repeats: act.repeats,
    inputs: act.inputs.length, receipt: receiptOut(act.receipt), final: finalOut(act.final), record: sha256(act.record) };
}
function paymentOut(payment: Payment) {
  return { status: statusOf(payment.status), kind: payment.freshens === undefined ? "payment" : "freshen", statement: payment.statement,
    payee: payment.payee, value: payment.value, fee: payment.fee ?? null, freshens: payment.freshens ?? null, inputs: payment.inputs.length,
    receipt: receiptOut(payment.receipt), final: finalOut(payment.final), superseded: payment.superseded.length, record: sha256(payment.record) };
}
function viewOut(view: WalletView, lit: boolean) {
  // `available` is what `pay` and `burn` can spend: in the pool notes a demand presented move only by `freshen`; lit has
  // none, and spends a presented note as any other (M14g2), so its `available` counts them and `presented` is a part of it.
  const total = (presented: boolean) => view.holdings.filter(h => h.status === "available" && (lit ? !presented || h.presented.length > 0 :
    (h.presented.length > 0) === presented)).reduce((n, h) => n + h.value, 0n);
  return { status: view.checkpoint === undefined ? "unavailable" : "final", backing: view.backing, judgingIndex: view.judgingIndex,
    checkpoint: view.checkpoint === undefined ? null : commitmentOut(view.checkpoint), gap: view.gap, available: total(false), presented: total(true),
    holdings: view.holdings.map(h => ({ cm: h.cm, value: h.value, status: h.status, presented: h.presented })),
    demands: view.demands.map(d => ({ id: d.id, quantity: d.quantity, instant: d.instant, deadline: d.deadline, holdings: d.holdings })),
    // M13f: the evidence that another instance of the seed acted; every acting command refuses FORKED until `restore --copy`.
    ...(view.forked === undefined ? {} : { forked: view.forked }) };
}

/** An opened wallet over the directory's view, with a prover where the command proves. */
interface Opened {
  readonly directory: Directory;
  readonly view: View;
  readonly wallet: V3Wallet;
  /** The read's witnessed index, where the command synced its view. */
  readonly at: bigint | undefined;
  readonly prove: LocalProver | undefined;
  close(): Promise<void>;
}

const WALLET_DB = "wallet.db", PENDING = "wallet.pending";

/** The wallet's options over a view: the directory's construction, and a verifier where it carries proofs. */
const walletOptions = (directory: Directory, view: View, verifier: ProofVerifier | undefined) =>
  ({ construction: directory.construction, venue: view.venue, reference: view.file.reference, ...(verifier === undefined ? {} : { verifier }) });
/** The wallet database over a view: a new one only where `create` says so. */
function walletOver(directory: Directory, view: View, verifier: ProofVerifier | undefined, create = false): V3Wallet {
  const path = directory.file(WALLET_DB);
  if (!create && !existsSync(path)) {
    throw new CommandError("ABSENT", "the directory has no wallet database: init with --venue, or a backer's venue create");
  }
  const options = walletOptions(directory, view, verifier);
  return create ? new V3Wallet(path, options) : V3Wallet.open(path, options);
}

/** The prover over the directory's cached parameters, loaded by dynamic import so a non-proving process loads no
 * `@noir-lang` module; its verifier is the wallet's. */
async function openProver(directory: Directory, instances: number) {
  const api = await startBackend(await readParameters(directory.path));
  try {
    const { openV3Prover } = await import("../pool/v3/prover.js");
    const prover = await openV3Prover(api, { instances });
    return { prover, async close() { await prover.close(); await api.destroy(); } };
  } catch (error) { await api.destroy(); throw error; }
}

async function openWallet(directory: Directory, args: Arguments, options: { readonly prove?: boolean; readonly sync?: boolean }): Promise<Opened> {
  const view = openView(directory);
  let closeProof: (() => Promise<void>) | undefined, verifier: ProofVerifier | undefined, wallet: V3Wallet | undefined;
  try {
    let at: bigint | undefined;
    if (options.sync) {
      at = (await view.syncWitnessed()).witnessedIndex;
    }
    let prove: LocalProver | undefined;
    // A construction without proofs proves and verifies nothing (lit: owner signatures).
    if (options.prove && !keyed(directory)) {
      const opened = await openProver(directory, verifierCount(args));
      closeProof = opened.close; verifier = opened.prover.verifier;
      prove = task => opened.prover.prove(task);
    } else verifier = await directoryVerifier(directory, args);
    wallet = walletOver(directory, view, verifier);
    const own = wallet, ownVerifier = verifier, ownClose = closeProof;
    return { directory, view, wallet: own, at, prove, async close() {
      own.close();
      if (ownClose !== undefined) await ownClose(); else await ownVerifier?.close();
      view.close();
    } };
  } catch (error) {
    wallet?.close();
    if (closeProof !== undefined) await closeProof(); else await verifier?.close();
    view.close();
    throw error;
  }
}

/** Run `act` over an opened wallet, closing it after. */
async function withWallet<T>(directory: Directory, args: Arguments, options: { readonly prove?: boolean; readonly sync?: boolean },
  act: (opened: Opened) => Promise<T>): Promise<T> {
  const opened = await openWallet(directory, args, options);
  try { return await act(opened); } finally { await opened.close(); }
}

/** The evidence a read takes. */
interface Evidence { readonly bytes: Uint8Array; readonly source: "saved" | "file" | "served" | "replica" | "kept"; readonly from?: object }

/** Run the read `use` over its evidence: `--package <file>`, or its sources synced into the wallet's evidence file (the
 * operator's service, then, where it does not answer, each replica added: M12b), repaired where a source withheld
 * (`readRepaired`: a read unresolved over a source's answer syncs it again from nothing, then passes to the next);
 * where none answers, the package its last sync kept. A `saved` payment or act needs none: its rerun is the library's
 * exact retry, as is a read run again after a repair. Outputs name the source as `evidence` (`served`, `replica` with
 * its URL, `kept`, `file` or `saved`) and the sources passed over. */
async function withEvidence<T>(opened: Opened, args: Arguments, kept: KeptTerms, saved: boolean, use: (source: Evidence) => Promise<T>): Promise<T> {
  if (saved) return use({ bytes: new Uint8Array(), source: "saved" });
  const file = flag(args, "package");
  if (file !== undefined) return use({ bytes: readRequired(file, "package file"), source: "file" });
  const last = opened.directory.file(`packages/${hex(kept.backing)}`);
  const passed = (skipped: readonly Skipped[]) => skipped.length > 0 ? { skipped } : {};
  return readRepaired(options => syncSources(opened.directory, kept, opened.view,
    client => opened.wallet.supply(store => client.sync(kept.backing, store, { full: options.full(client.baseUrl) })), options.except), async synced => {
    if ("served" in synced) {
      const bytes = synced.served.package;
      mkdirSync(opened.directory.file("packages"), { recursive: true, mode: 0o700 });
      writeReplace(last, bytes);
      return use({ bytes, source: synced.origin, from: { ...(synced.origin === "replica" ? { replica: synced.url } : {}), ...passed(synced.skipped) } });
    }
    const bytes = readOptional(last);
    if (bytes === undefined) throw new CommandError("UNAVAILABLE", "no source answered and no earlier sync kept a package");
    return use({ bytes, source: "kept", from: passed(synced.skipped) });
  }, repairRecord(opened.directory, kept.backing));
}

/** A service that submits through the operator's service named in the terms. */
function submitter(opened: Opened, kept: KeptTerms) {
  const client = serviceClient(opened.directory, kept, opened.view);
  return { async submit(record: Uint8Array) {
    try { return await client.submit(record); } catch (error) {
      if (unanswered(error)) throw new CommandError("UNAVAILABLE", "the operator's service did not answer; the record is saved: rerun to submit it");
      throw error;
    }
  } };
}

/** `--deadline n` or `--deadline +n` (relative to the read's witnessed index). On an alias already saved, `+n` reads as
 * its saved deadline, so a rerun of the same command line after a lost reply is the exact retry (Next 4 (ab)); an
 * absolute deadline is compared as given. */
function deadlineOf(args: Arguments, at: bigint, saved?: bigint): bigint {
  const text = required(args, "deadline"), relative = /^\+/.test(text);
  const value = integer(relative ? text.slice(1) : text, "--deadline", 0n, (1n << 63n) - 1n);
  return relative ? saved ?? at + value : value;
}
/** The deadline of the demand saved under `alias`, as `actOut` prints it. */
function savedDemandDeadline(directory: Directory, wallet: V3Wallet, alias: string): bigint | undefined {
  const act = wallet.act(alias);
  return act?.kind !== 4 ? undefined : directory.construction.view(directory.construction.decode(act.record), () => undefined).demand!.value.deadline;
}

/** A backer's directory holds K; the role check reads no key bytes. */
function requireBacker(directory: Directory): void {
  if (!existsSync(directory.file("backer.key"))) throw new CommandError("ROLE", "this wallet holds no backer key: a backer's wallet is created with init --backer");
}
/** K, as the wallet's signer: read only by the commands that sign, and wiped when they close. */
function backerKey(directory: Directory): Uint8Array {
  requireBacker(directory);
  return readSecret(directory.file("backer.key"), "backer.key");
}
async function withSigner<T>(directory: Directory, act: (sign: BackerSigner) => Promise<T>): Promise<T> {
  const secret = backerKey(directory);
  try { return await act(message => ed25519.sign(message, secret)); } finally { secret.fill(0); }
}

/** The first request or payment of a wallet shows the explanations once; later ones do not. */
function firstNotes(directory: Directory): { readonly notes?: readonly string[] } {
  if (existsSync(directory.file(EXPLAINED))) return {};
  writeExclusive(directory.file(EXPLAINED), "shown\n");
  return { notes: keyed(directory) ? LIT_FIRST_NOTES : FIRST_NOTES };
}

/** A payment request read from its frame file and authenticated by the digest obtained from the receiver: the
 * directory's construction's frame (lit-v1 §8's names an owner key). */
function requestOf(directory: Directory, args: Arguments, prefix = ""): PaymentRequest | KeyedRequest {
  const frame = readRequired(required(args, `${prefix}request`), "request frame"), digest = required(args, `${prefix}digest`);
  try { return keyed(directory) ? authenticateLitPaymentRequest(frame, digest) : authenticatePaymentRequest(frame, digest); } catch (error) {
    if (error instanceof EncodingError) {
      throw new CommandError("REQUEST", `the request frame does not match the digest, or is not a ${nameOf(directory.construction)} payment request`);
    }
    throw error;
  }
}

/** Paths a command writes outside the directory (a handoff's key and envelope): absolute, outside it, and distinct. */
export function outside(directory: Pick<Directory, "path">, ...paths: string[]): string[] {
  // Compared as the file system resolves them: links followed through the nearest existing ancestor, and without
  // case where the platform's file names ignore it.
  const real = (path: string): string => {
    let head = resolve(path), tail = "";
    for (;;) {
      try { return join(realpathSync(head), tail); } catch {
        const up = dirname(head);
        if (up === head) return resolve(path);
        tail = join(basename(head), tail); head = up;
      }
    }
  };
  const fold = (path: string): string => process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
  const root = fold(real(directory.path)), resolved = paths.map(path => resolve(path)), compared = resolved.map(path => fold(real(path)));
  for (const [i, path] of compared.entries()) {
    const inner = relative(root, path);
    if (inner === "" || (inner !== ".." && !inner.startsWith(`..${sep}`) && !isAbsolute(inner))) throw new CommandError("PATH", `${resolved[i]} lies inside the data directory`);
  }
  if (new Set(compared).size !== compared.length) throw new CommandError("PATH", "the paths must differ");
  return resolved;
}

const READ = { dir: "value", package: "value", verifiers: "value" } as const satisfies FlagSpec;

function open(args: Arguments): { readonly directory: Directory; readonly kept: KeptTerms } {
  const directory = openDirectory(required(args, "dir"), "wallet"), venue = requireVenue(directory);
  return { directory, kept: keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue) };
}
/** The alias and the kept terms of `<alias> <backing> ...`. */
function aliased(argv: readonly string[], spec: FlagSpec, positionals: number) {
  const args = parseArguments(argv, { ...READ, ...spec }, positionals);
  const directory = openDirectory(required(args, "dir"), "wallet"), venue = requireVenue(directory);
  return { args, directory, alias: args.positional[0]!, kept: keptTerms(directory, hex32(args.positional[1]!, "the backing"), venue) };
}

async function init(argv: readonly string[]): Promise<void> {
  return initRole(argv, "wallet", { venue: args => has(args, "backer") ? "optional" : "required", construction: true, flags: { backer: "switch", verifiers: "value" },
    fill: async (directory, args) => {
      let shown: object = {};
      if (has(args, "backer")) {
        const secret = new Uint8Array(randomBytes(32));
        writeExclusive(directory.file("backer.key"), secret);
        shown = { backer: ed25519.getPublicKey(secret) };
        secret.fill(0);
      }
      if (ownVenue(directory) !== undefined) await createDatabase(directory, args);
      return shown;
    } });
}

/** Create the wallet database (a fresh seed) over the directory's venue. */
async function createDatabase(directory: Directory, args: Arguments): Promise<void> {
  await withView(directory, args, (view, verifier) => { walletOver(directory, view, verifier, true).close(); });
}
/** `use` over the directory's view and its verifier (none for a construction without proofs), both closed after. */
async function withView<T>(directory: Directory, args: Arguments, use: (view: View, verifier: ProofVerifier | undefined) => T): Promise<T> {
  const view = openView(directory);
  try {
    const verifier = await directoryVerifier(directory, args);
    try { return use(view, verifier); } finally { await verifier?.close(); }
  } finally { view.close(); }
}

/** `venue create` (backer): the venue, then the wallet database over it. */
async function venueCommand(argv: readonly string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb !== "create") throw new UsageError("moe wallet venue create");
  const args = parseArguments(rest, { dir: "value", synthetic: "switch", depth: "value", verifiers: "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "wallet"), depth = flag(args, "depth");
  requireBacker(directory);
  // The run that creates the venue marks that it owes the wallet database, so an interrupted run creates it on rerun;
  // a venue without the mark and without a database lost its database, which only a restore brings back.
  const pending = directory.file(PENDING);
  if (ownVenue(directory) === undefined && !existsSync(pending)) writeExclusive(pending, "the wallet database is created with the venue\n");
  const { venue, created } = await createVenue(directory, { synthetic: has(args, "synthetic"),
    ...(depth === undefined ? {} : { depth: integer(depth, "--depth", 1n, 1000n) }) });
  if (existsSync(pending)) {
    // Created while the mark stands, existing or not: a run killed inside the creating transaction leaves a database
    // with no identity, which only the creating open fills (one with an identity it leaves as it is).
    await createDatabase(directory, args);
    rmSync(pending);
  } else if (!existsSync(directory.file(WALLET_DB))) {
    throw new CommandError("ABSENT", "the venue exists but the wallet database is lost: restore it (restore, restore-seed) into a new directory");
  }
  print({ status: created ? "created" : "existing", venue: venue.id, file: JSON.parse(venueText(venue.profile, venue.anchorHeight)) });
}

/** `terms create` (backer): root terms naming the operator on the directory's venue, signed by K and kept. */
function termsCreate(argv: readonly string[]): void {
  const args = parseArguments(argv, { dir: "value", operator: "value", thing: "value", "quantum-exponent": "value", "per-unit": "value",
    interval: "value", silence: "value", challenge: "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "wallet"), venue = requireVenue(directory);
  const silence = flag(args, "silence"), challenge = flag(args, "challenge"), lit = keyed(directory);
  // Pool-v3's silence clause names a challenge window; lit-v1's the duration alone (lit-v1 §9).
  if (lit && challenge !== undefined) throw new UsageError("lit terms' silence clause names no challenge window: --challenge is not taken");
  if (!lit && (silence === undefined) !== (challenge === undefined)) throw new UsageError("--silence and --challenge are given together");
  const codec = directory.construction.reader.terms, secret = backerKey(directory);
  let bytes: Uint8Array, signature: Uint8Array;
  try {
    try {
      const fields = { obligor: ed25519.getPublicKey(secret), operator: hex32(required(args, "operator"), "--operator"),
        venue: venue.id, interval: integer(required(args, "interval"), "--interval", 1n),
        payout: { thing: required(args, "thing"), quantumExponent: Number(integer(flag(args, "quantum-exponent") ?? "0", "--quantum-exponent", 0n, 18n)),
          perUnit: integer(required(args, "per-unit"), "--per-unit", 1n) } };
      const duration = silence === undefined ? undefined : integer(silence, "--silence", 1n);
      bytes = lit ? encodeLitTerms({ ...fields, configuration: litConfigHash(), ...(duration === undefined ? {} : { silence: { noCommitmentDuration: duration } }) })
        : encodeRootTerms({ ...fields, configuration: adoptedDomain(),
          ...(duration === undefined ? {} : { silence: { noCommitmentDuration: duration, challengeWindow: integer(challenge!, "--challenge", 1n) } }) });
    } catch (error) {
      if (error instanceof EncodingError) throw new CommandError("INVALID", `the terms are not valid root terms: ${error.message}`);
      throw error;
    }
    signature = ed25519.sign(codec.rootTermsSignatureMessage(bytes), secret);
  } finally { secret.fill(0); }
  // The backer's own venue: synthetic terms are accepted where the directory's venue is the synthetic chain.
  const kept = authenticate(bytes, signature, codec.rootTermsName(bytes), venue, venue.profile.reference === ERGO_SYNTHETIC_REFERENCE,
    directory.construction);
  keepTerms(directory, kept);
  print({ status: "kept", backing: kept.backing, terms: directory.file(`terms/${hex(kept.backing)}`), signature: directory.file(`terms/${hex(kept.backing)}.sig`) });
}

async function seed(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", show: "switch", verifiers: "value" }, 0);
  if (!has(args, "show")) throw new UsageError("moe wallet seed --show: prints the recovery seed, which spends everything this wallet holds");
  const directory = openDirectory(required(args, "dir"), "wallet");
  await withWallet(directory, args, {}, async ({ wallet }) => {
    const secret = wallet.recoverySeed();
    try { print({ status: "secret", seed: secret }); } finally { secret.fill(0); }
  });
}

/** stdin, at most 66 bytes: the seed's 64 hex digits and an optional newline. Never a terminal, which would echo it. */
async function seedFromStdin(): Promise<Uint8Array> {
  if (process.stdin.isTTY) throw new CommandError("INVALID", "restore-seed reads the seed from a pipe or file on stdin, not a terminal");
  const read = Buffer.alloc(67);
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = chunk as Buffer;
      if (length + bytes.length > 66) { bytes.fill(0); throw new CommandError("INVALID", "stdin is longer than a seed"); }
      bytes.copy(read, length); length += bytes.length; bytes.fill(0);
    }
    let end = length;
    if (end > 0 && read[end - 1] === 0x0a) end--;
    if (end > 0 && read[end - 1] === 0x0d) end--;
    const digits = read.subarray(0, end);
    if (end !== 64 || !digits.every(c => (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) {
      throw new CommandError("INVALID", "stdin is not a seed's 64 lowercase hex digits");
    }
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = parseInt(String.fromCharCode(digits[2 * i]!, digits[2 * i + 1]!), 16);
    return seed;
  } finally { read.fill(0); }
}

/** `--backer-key <file>` at a restore: K, copied into the new directory. */
function restoreBacker(directory: Directory, args: Arguments): object {
  const file = flag(args, "backer-key");
  if (file === undefined) return {};
  const secret = readSecret(file, "the backer key file");
  try { writeExclusive(directory.file("backer.key"), secret); return { backer: ed25519.getPublicKey(secret) }; } finally { secret.fill(0); }
}

/** `restore-seed`: a new directory whose wallet holds only the seed read from stdin (C4.6). */
async function restoreSeed(argv: readonly string[]): Promise<void> {
  // The arguments are checked before stdin is read, so a usage error does not wait on input.
  const checked = parseArguments(argv, { dir: "value", node: "values", parameters: "value", venue: "value", verifiers: "value", "backer-key": "value",
    construction: "value" }, 0);
  required(checked, "dir"); required(checked, "venue"); initConstruction(checked);
  if (existsSync(resolve(required(checked, "dir")))) throw new CommandError("EXISTS", "restore-seed creates a new directory");
  const secret = await seedFromStdin();
  try {
    await initRole(argv, "wallet", { venue: "required", construction: true, flags: { verifiers: "value", "backer-key": "value" }, fill: async (directory, args) => {
      await withView(directory, args, (view, verifier) =>
        V3Wallet.restoreSeed(directory.file(WALLET_DB), walletOptions(directory, view, verifier), secret).close());
      return { restored: "seed", ...restoreBacker(directory, args) };
    } });
  } finally { secret.fill(0); }
}

/** `handoff --key <file> --out <file>`: freeze this wallet into an encrypted handoff (the library's exportBackup). */
async function handoff(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", key: "value", out: "value", verifiers: "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "wallet");
  const [keyPath, outPath] = outside(directory, required(args, "key"), required(args, "out"));
  await withWallet(directory, args, {}, async ({ wallet }) => {
    // The key is on durable storage before the source freezes; a rerun reuses it. A frozen wallet takes only the
    // key it was exported under, so no new key file is made for it.
    let key = readOptional(keyPath!);
    if (key === undefined) {
      if (wallet.custody().frozen) throw new CommandError("FROZEN", "this wallet was already handed off: name the key file it was exported under");
      key = new Uint8Array(randomBytes(32)); writeExclusive(keyPath!, key);
    } else if (process.platform !== "win32" && (statSync(keyPath!).mode & 0o077) !== 0) {
      key.fill(0);
      throw new CommandError("MODE", `${keyPath} is readable or writable by group or others; a handoff key is owner-only`);
    }
    try {
      if (key.length !== 32) throw new CommandError("INVALID", "the key file is not 32 bytes");
      // The freeze cannot be undone: an output path that cannot take the handoff is refused before it.
      if (!wallet.custody().frozen) {
        if (readOptional(outPath!) !== undefined) throw new CommandError("EXISTS", `${outPath} already exists; the handoff is written to a new file`);
        if (!existsSync(dirname(outPath!))) throw new CommandError("ABSENT", `the parent of ${outPath} does not exist`);
      }
      const bytes = wallet.exportBackup(key);
      writeSame(outPath!, bytes);
      print({ status: "frozen", digest: walletBackupDigest(bytes), key: keyPath, out: outPath });
    } finally { key.fill(0); }
  });
}

/**
 * `restore --copy --dir <d>` (slice 13 M13e): this directory was restored from a copy or a backup, and the instance it
 * was copied from is gone. Records the restoration (`V3Wallet.recordRestoration`); the view's file, a copy too, was
 * audited as it opened. Run it before anything else, also after an in-place overwrite or a snapshot rollback, which
 * the wallet cannot see.
 */
async function restoreCopy(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", copy: "switch", verifiers: "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "wallet");
  await withWallet(directory, args, {}, async ({ wallet }) => {
    const copied = wallet.isCopy(), { requests } = wallet.recordRestoration();
    print({ status: "restored", restored: "copy", copied, requests, notes: [
      "never run the instance this copy was made from again: two copies of one wallet act unaware of each other; a later read " +
        "that shows another instance of the seed acting stops every acting command (FORKED) until restore --copy is run again",
      "its lost instance may have credited a request it made: fulfill refuses those listed (RESTORED) unless your records outside the wallet show it did not (--uncredited)",
      ...(keyed(directory) ? ["its next sync of each backing, from a view at least as fresh as its lost instance's, exposes every owner key " +
        "through h + 256 (lit-v1 §8): move-window before new requests, and before a payment or burn with change",
        "pay refuses a request a statement of this seed already paid; one its lost instance still had in flight is not known: " +
        "if it lands later, the next read stops the wallet (FORKED), so before paying an unpaid request again, ask the payee"] : []),
    ] });
  });
}

/** `restore --key <file> --backup <file> --digest <hex>`: a new directory holding the handoff's wallet; a rerun over a
 * complete restore is confirmed by its provenance. With `--copy`, `restoreCopy`. */
async function restore(argv: readonly string[]): Promise<void> {
  if (argv.includes("--copy")) return restoreCopy(argv);
  const flags = { verifiers: "value", key: "value", backup: "value", digest: "value", "backer-key": "value" } as const;
  const probe = parseArguments(argv, { dir: "value", node: "values", parameters: "value", venue: "value", construction: "value", ...flags }, 0);
  const digest = required(probe, "digest");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new UsageError("--digest is not 64 lowercase hex digits");
  if (existsSync(resolve(required(probe, "dir")))) {
    const directory = openDirectory(required(probe, "dir"), "wallet");
    await withWallet(directory, probe, {}, async ({ wallet }) => {
      if (wallet.custody().restoredFrom !== digest) throw new CommandError("EXISTS", "the directory exists and was not restored from this handoff");
      print({ status: "restored", replay: true, digest });
    });
    return;
  }
  const bytes = readRequired(required(probe, "backup"), "the handoff"), key = readSecret(required(probe, "key"), "the handoff key");
  try {
    // The handoff is opened before the directory exists: one of the other construction, or under wrong credentials,
    // leaves nothing behind (the library would refuse either as INVALID only after init).
    const named = constructionNamed(initConstruction(probe)), venue = parseVenue(readJson(required(probe, "venue"), "the venue file")).id;
    const opens = (construction: Construction): boolean => {
      try { openWalletBackup(bytes, key, construction.reader.domain(), venue, digest).fill(0); return true; } catch { return false; }
    };
    if (!opens(named)) {
      const other = constructions().find(c => c !== named && opens(c));
      if (other !== undefined) throw new CommandError("CONSTRUCTION", `the handoff holds a ${nameOf(other)} wallet: restore it with --construction ${nameOf(other)}`);
      throw new CommandError("INVALID", "invalid wallet backup or recovery credentials");
    }
    await initRole(argv, "wallet", { venue: "required", construction: true, flags, fill: async (directory, args) => {
      await withView(directory, args, (view, verifier) =>
        V3Wallet.restoreBackup(directory.file(WALLET_DB), walletOptions(directory, view, verifier), bytes, key, digest).close());
      return { restored: "handoff", digest, ...restoreBacker(directory, args) };
    } });
  } finally { key.fill(0); }
}

/** `request <alias> <backing> <value> [--out <file>]`: the exact request, its frame and digest to hand on. */
async function request(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { out: "value" }, 3);
  const value = integer(args.positional[2]!, "the value", 1n, (1n << 64n) - 1n);
  await withWallet(directory, args, {}, async ({ wallet }) => {
    const lit = keyed(directory), out = flag(args, "out");
    const frame = lit ? encodeLitPaymentRequest(wallet.keyedRequest(alias, kept.backing, value)) : encodePaymentRequest(wallet.request(alias, kept.backing, value));
    if (out !== undefined) writeSame(out, frame);
    print({ status: "saved", backing: kept.backing, value, frame, digest: lit ? litPaymentRequestDigest(frame) : paymentRequestDigest(frame),
      ...firstNotes(directory) });
  });
}

/** `--fee-request <file> --fee-digest <hex> --fee-value <n>`: a direct fee to the operator's request, or none. */
function feeOf(directory: Directory, args: Arguments) {
  return flag(args, "fee-request") === undefined ? undefined
    : { request: requestOf(directory, args, "fee-"), value: integer(required(args, "fee-value"), "--fee-value", 1n, (1n << 64n) - 1n) };
}

/** `pay <alias> <backing> --request <file> --digest <hex> --value <n> [--fee-request ... --fee-digest ... --fee-value ...]`:
 * prepare the exact payment, then submit it. */
async function pay(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { request: "value", digest: "value", value: "value", "fee-request": "value",
    "fee-digest": "value", "fee-value": "value" }, 2);
  const value = integer(required(args, "value"), "--value", 1n, (1n << 64n) - 1n), payee = requestOf(directory, args), fee = feeOf(directory, args);
  await withWallet(directory, args, { prove: true, sync: true }, async opened => {
    await withEvidence(opened, args, kept, opened.wallet.payment(alias) !== undefined, async source => {
      // The order is the directory's construction's: requestOf read each request in its frame.
      const order = { request: payee, value, ...(fee === undefined ? {} : { fee }) } as Parameters<V3Wallet["prepare"]>[1];
      const prepared = await opened.wallet.prepare(alias, order, source.bytes, kept.signed, opened.prove);
      if (prepared.status === "prepared") await opened.wallet.submit(alias, submitter(opened, kept));
      print({ ...paymentOut(opened.wallet.payment(alias)!), evidence: source.source, ...source.from, ...firstNotes(directory) });
    });
  });
}

/** `freshen <alias> <backing> <demand>`: one demand's presented notes into one fresh note, then submitted. */
async function freshen(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, {}, 3);
  const demand = hex32(args.positional[2]!, "the demand");
  if (keyed(directory)) {
    throw new CommandError("CONSTRUCTION", "a lit wallet has no freshen: a presented lit note spends as any other (lit-v1 §8), so pay or burn it");
  }
  await withWallet(directory, args, { prove: true, sync: true }, async opened => {
    await withEvidence(opened, args, kept, opened.wallet.payment(alias) !== undefined, async source => {
      const payment = await opened.wallet.freshen(alias, demand, source.bytes, kept.signed, opened.prove!);
      if (payment.status === "prepared") await opened.wallet.submit(alias, submitter(opened, kept));
      print({ ...paymentOut(opened.wallet.payment(alias)!), evidence: source.source, ...source.from,
        notes: [`This payment spends the notes demand ${hex(demand)} presented into one fresh note: it shows it came from that demand's notes and links no two demands.`] });
    });
  });
}

/** `move-window <alias> <backing> [--fee-request ... --fee-digest ... --fee-value ...]` (lit): once the backing's
 * owner-key window is full, pay this wallet's smallest covering note or pair to its highest exposed key (lit-v1 §8);
 * once final, requests resume. A wallet restored from its seed alone needs it before its first request. */
async function moveWindow(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { "fee-request": "value", "fee-digest": "value", "fee-value": "value" }, 2);
  if (!keyed(directory)) throw new CommandError("CONSTRUCTION", `a ${nameOf(directory.construction)} wallet has no owner-key window to move`);
  const fee = feeOf(directory, args) as { readonly request: KeyedRequest; readonly value: bigint } | undefined;
  await withWallet(directory, args, { sync: true }, async opened => {
    await withEvidence(opened, args, kept, opened.wallet.payment(alias) !== undefined, async source => {
      const payment = await opened.wallet.moveWindow(alias, source.bytes, kept.signed, fee);
      if (payment.status === "prepared") await opened.wallet.submit(alias, submitter(opened, kept));
      print({ ...paymentOut(opened.wallet.payment(alias)!), evidence: source.source, ...source.from,
        notes: ["This payment moves the window: it pays this wallet's own highest exposed key, so the request that named that key is closed and requests resume once it is final."] });
    });
  });
}

/** `reprove <alias> <backing>`: prove a prepared payment again in the canonical segment. */
async function reprove(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, {}, 2);
  await withWallet(directory, args, { prove: true, sync: true }, async opened => {
    await withEvidence(opened, args, kept, false, async source => {
      print({ ...paymentOut(await opened.wallet.reprove(alias, source.bytes, kept.signed, opened.prove)), evidence: source.source, ...source.from });
    });
  });
}

/** `submit <alias> <backing>`: submit a saved payment's or act's exact record; a rerun prints the kept receipt. */
async function submit(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, {}, 2);
  await withWallet(directory, args, {}, async opened => {
    const receipt = await opened.wallet.submit(alias, submitter(opened, kept));
    const saved = opened.wallet.payment(alias) ?? opened.wallet.act(alias);
    print({ status: saved === undefined ? "pending" : statusOf(saved.status), alias, receipt: receiptOut(receipt), statement: receipt.statementHash });
  });
}

/** `status <alias>`: the saved payment or act under the alias, as the last sync resolved it. */
async function status(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", verifiers: "value" }, 1);
  const directory = openDirectory(required(args, "dir"), "wallet"), alias = args.positional[0]!;
  await withWallet(directory, args, {}, async ({ wallet }) => {
    const payment = wallet.payment(alias), act = payment === undefined ? wallet.act(alias) : undefined;
    if (payment === undefined && act === undefined) throw new CommandError("ABSENT", "no payment or act is saved under this alias");
    print({ alias, ...(payment !== undefined ? paymentOut(payment) : actOut(act!, directory.construction)) });
  });
}

/** `sync <backing>`: holdings and standing demands at the view's witnessed index; resolves saved records. */
async function sync(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, READ, 1), { directory, kept } = open(args);
  await withWallet(directory, args, { sync: true }, async opened => {
    await withEvidence(opened, args, kept, false, async source => {
      print({ ...viewOut(await opened.wallet.sync(source.bytes, kept.signed), keyed(directory)), evidence: source.source, ...source.from });
    });
  });
}

const fulfillmentOut = (f: NonNullable<ReturnType<V3Wallet["fulfillment"]>>) => ({ backing: f.request.opening.backing, value: f.request.opening.value,
  cm: f.request.cm, checkpoint: commitmentOut(f.checkpoint), judgingIndex: f.judgingIndex });
/** A lit fulfillment: the request's owner key, and the output credited to it alone (lit-v1 §8). */
const keyedFulfillmentOut = (f: NonNullable<ReturnType<V3Wallet["keyedFulfillment"]>>) => ({ backing: f.request.backing, value: f.request.value,
  owner: f.request.owner, cm: f.cm, checkpoint: commitmentOut(f.checkpoint), judgingIndex: f.judgingIndex });
/** The saved fulfillment under `alias`, as the directory's construction prints it. */
function savedFulfillment(directory: Directory, wallet: V3Wallet, alias: string): object | undefined {
  if (keyed(directory)) { const saved = wallet.keyedFulfillment(alias); return saved === undefined ? undefined : keyedFulfillmentOut(saved); }
  const saved = wallet.fulfillment(alias);
  return saved === undefined ? undefined : fulfillmentOut(saved);
}

/** `fulfill <alias> <backing>`: the request found paid in the canonical frontier. Credit only on exit 0. */
async function fulfill(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { uncredited: "switch" }, 2);
  const options = { uncredited: has(args, "uncredited") };
  await withWallet(directory, args, { sync: true }, async opened => {
    const earlier = savedFulfillment(directory, opened.wallet, alias);
    if (earlier !== undefined) throw new Replayed({ status: "replay", alias, ...earlier });
    await withEvidence(opened, args, kept, false, async source => {
      const credited = keyed(directory) ? keyedFulfillmentOut(await opened.wallet.keyedFulfill(alias, source.bytes, kept.signed, options))
        : fulfillmentOut(await opened.wallet.fulfill(alias, source.bytes, kept.signed, options));
      print({ status: "final", alias, ...credited, evidence: source.source, ...source.from });
    });
  });
}

/** `fulfillment <alias>`: the saved fulfillment, read after a lost reply. */
async function fulfillment(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", verifiers: "value" }, 1);
  const directory = openDirectory(required(args, "dir"), "wallet");
  await withWallet(directory, args, {}, async ({ wallet }) => {
    const saved = savedFulfillment(directory, wallet, args.positional[0]!);
    if (saved === undefined) throw new CommandError("ABSENT", "no fulfillment is saved under this alias");
    print({ status: "final", alias: args.positional[0]!, ...saved });
  });
}

/** What a demand's tags now link (M10b item 13). */
function demandNotes(directory: Directory, act: Act): string[] {
  // Lit-v1 §11: a lit demand names notes whose openings are already public; a withdrawn demand's notes spend as any other.
  if (keyed(directory)) {
    return ["Everything this demand names (its notes, their owner keys and its quantity) is public, as every lit statement is. Once withdrawn or lapsed, its notes pay or burn as any other."];
  }
  return ["Its tags become public once the operator admits it or it is published: whoever later sees these notes spent links them to this demand (C3.1). Before spending them elsewhere, freshen them.",
    ...(act.repeats.length === 0 ? [] : [`It presents again the notes of ${act.repeats.map(hex).join(", ")}, so it links to that demand.`])];
}

/** `demand <alias> <backing> <quantity> --deadline <n|+n>`: present whole notes of that quantity. */
async function demand(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { deadline: "value" }, 3);
  const quantity = integer(args.positional[2]!, "the quantity", 1n, (1n << 64n) - 1n);
  await withWallet(directory, args, { prove: true, sync: true }, async opened => {
    const deadline = deadlineOf(args, opened.at!, savedDemandDeadline(directory, opened.wallet, alias));
    await withEvidence(opened, args, kept, opened.wallet.act(alias) !== undefined, async source => {
      const act = await opened.wallet.demand(alias, quantity, deadline, source.bytes, kept.signed, opened.prove);
      print({ ...actOut(act, directory.construction), evidence: source.source, ...source.from, notes: demandNotes(directory, act) });
    });
  });
}

/** `withdraw <alias> <backing> <demand>`. */
async function withdraw(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, {}, 3);
  const id = hex32(args.positional[2]!, "the demand");
  await withWallet(directory, args, { sync: true }, async opened => {
    await withEvidence(opened, args, kept, opened.wallet.act(alias) !== undefined, async source => {
      print({ ...actOut(await opened.wallet.withdraw(alias, id, source.bytes, kept.signed), directory.construction), evidence: source.source, ...source.from });
    });
  });
}

/** An acceptance file: the canonical kind-2 publication the backer's `accept` writes, for the backing named, in the
 * directory's construction's frame. */
function acceptanceOf(directory: Directory, path: string, kept: KeptTerms): SignedAcceptance | KeyedAcceptance {
  const bytes = readRequired(path, "acceptance file");
  let publication;
  try { publication = keyed(directory) ? decodeLitPublication(bytes) : decodePublication(bytes); } catch (error) {
    if (error instanceof EncodingError) throw new CommandError("INVALID", `the acceptance file is not a ${nameOf(directory.construction)} acceptance publication`);
    throw error;
  }
  if (publication.kind !== 2 || compareBytes(publication.backing, kept.backing) !== 0) {
    throw new CommandError("INVALID", "the acceptance file is not an acceptance of this backing");
  }
  return publication.acceptance;
}

/** `settle <alias> <backing> --acceptance <file>`: settle this wallet's demand the backer's acceptance answers. */
async function settle(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { acceptance: "value" }, 2);
  const acceptance = acceptanceOf(directory, required(args, "acceptance"), kept);
  await withWallet(directory, args, { prove: true, sync: true }, async opened => {
    await withEvidence(opened, args, kept, opened.wallet.act(alias) !== undefined, async source => {
      print({ ...actOut(await opened.wallet.settle(alias, acceptance, source.bytes, kept.signed, opened.prove), directory.construction),
        evidence: source.source, ...source.from });
    });
  });
}

/** `presentation <backing> <demand>`: a demand's outcome under C3.8, from public evidence alone. */
async function presentation(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, READ, 2), { directory, kept } = open(args);
  const id = hex32(args.positional[1]!, "the demand");
  await withWallet(directory, args, { sync: true }, async opened => {
    await withEvidence(opened, args, kept, false, async source => {
      print({ ...presentationOf(await opened.wallet.presentation(id, source.bytes, kept.signed), opened.at!), evidence: source.source, ...source.from });
    });
  });
}

/** A publication file for a relay (M10b item 8): the venue, the backing and the exact publication the library would publish. */
function publicationFile(directory: Directory, kept: KeptTerms, out: string, publication: { readonly kind: number; readonly subject: Uint8Array; readonly record: Uint8Array }) {
  const venue = requireVenue(directory);
  writeSame(out, `${JSON.stringify({ schema: "moe-publication-1", venue: hex(venue.id), backing: hex(kept.backing), kind: String(publication.kind),
    subject: hex(publication.subject), record: hex(publication.record) }, null, 2)}\n`);
  return { out, record: sha256(publication.record) };
}
async function captured(send: (publisher: { publishRecord(kind: 1 | 2 | 3 | 4, subject: Uint8Array, record: Uint8Array): Promise<void> }) => Promise<void>) {
  let publication: { kind: number; subject: Uint8Array; record: Uint8Array } | undefined;
  await send({ publishRecord: async (kind, subject, record) => { publication = { kind, subject: new Uint8Array(subject), record: new Uint8Array(record) }; } });
  if (publication === undefined) throw new Error("the wallet published nothing");
  return publication;
}

/** `publish <alias> <backing> --out <file>`: a demand, withdrawal or release, written for a relay; only while the gap is open. */
async function publish(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { out: "value" }, 2);
  const out = required(args, "out");
  await withWallet(directory, args, { sync: true }, async opened => {
    await withEvidence(opened, args, kept, false, async source => {
      const view = await opened.wallet.sync(source.bytes, kept.signed);
      if (!view.gap) {
        throw new CommandError("GAP", "the read does not show this backing's gap open: outside it a publication has no force and discloses what it names; submit it instead");
      }
      const act = opened.wallet.act(alias);
      const publication = await captured(publisher => opened.wallet.publish(alias, publisher));
      if (compareBytes(publication.subject, kept.backing) !== 0) throw new CommandError("BACKING", "the act is of another backing than the one whose gap the read judged");
      print({ status: "written", ...publicationFile(directory, kept, out, publication), act: act === undefined ? null : actOut(act, directory.construction), judgingIndex: view.judgingIndex,
        notes: [RELAY_NOTE] });
    });
  });
}

/** `publish-acceptance <alias> <backing> --out <file>` (backer): the saved acceptance as a publication file for a relay. */
async function publishAcceptance(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { out: "value" }, 2);
  const out = required(args, "out");
  await withWallet(directory, args, {}, async opened => {
    const publication = await captured(publisher => opened.wallet.publishAcceptance(alias, publisher));
    print({ status: "written", ...publicationFile(directory, kept, out, publication), notes: [RELAY_NOTE] });
  });
}

/** `issue <alias> <backing> --request <file> --digest <hex> --value <n>` (backer): issue to the exact request, signed by K. */
async function issue(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { request: "value", digest: "value", value: "value" }, 2);
  const value = integer(required(args, "value"), "--value", 1n, (1n << 64n) - 1n), output = requestOf(directory, args);
  requireBacker(directory);
  await withWallet(directory, args, { prove: true, sync: true }, async opened => {
    await withEvidence(opened, args, kept, opened.wallet.act(alias) !== undefined, async source => {
      const act = await withSigner(directory, sign => opened.wallet.issue(alias, output, value, source.bytes, kept.signed, opened.prove, sign));
      print({ ...actOut(act, directory.construction), evidence: source.source, ...source.from });
    });
  });
}

/** `accept <alias> <backing> <demand> --deadline <n|+n> --out <file>` (backer): K's acceptance, written as its publication. */
async function accept(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, { deadline: "value", out: "value" }, 3);
  const id = hex32(args.positional[2]!, "the demand"), out = required(args, "out");
  requireBacker(directory);
  await withWallet(directory, args, { sync: true }, async opened => {
    const deadline = deadlineOf(args, opened.at!, opened.wallet.acceptanceDeadline(alias));
    await withEvidence(opened, args, kept, false, async source => {
      let acceptance: SignedAcceptance | KeyedAcceptance, bytes: Uint8Array;
      if (keyed(directory)) {
        // Lit-v1 §§4, 8: the owner is `acceptSecret`'s key, the publication lit's kind 2.
        const own = await withSigner(directory, sign => opened.wallet.keyedAccept(alias, id, deadline, source.bytes, kept.signed, sign));
        acceptance = own; bytes = directory.construction.wallet!.publication(own.domain, kept.backing, { kind: 2, acceptance: own });
      } else {
        const own = await withSigner(directory, sign => opened.wallet.accept(alias, id, deadline, source.bytes, kept.signed, sign));
        acceptance = own; bytes = encodePublication({ domain: own.domain, backing: kept.backing, kind: 2, acceptance: own });
      }
      writeSame(out, bytes);
      print({ status: "saved", demand: acceptance.demand, deadline: acceptance.deadline, owner: acceptance.owner, out, evidence: source.source, ...source.from,
        notes: ["Publish the acceptance at once (publish-acceptance and a relay): it answers for C3.8 only where the venue witnesses it more than the lag before its deadline."] });
    });
  });
}

/** `burn <alias> <backing> <quantity>` (backer). */
async function burn(argv: readonly string[]): Promise<void> {
  const { args, directory, alias, kept } = aliased(argv, {}, 3);
  const quantity = integer(args.positional[2]!, "the quantity", 1n, (1n << 64n) - 1n);
  requireBacker(directory);
  await withWallet(directory, args, { prove: true, sync: true }, async opened => {
    await withEvidence(opened, args, kept, opened.wallet.act(alias) !== undefined, async source => {
      print({ ...actOut(await opened.wallet.burn(alias, quantity, source.bytes, kept.signed, opened.prove), directory.construction),
        evidence: source.source, ...source.from });
    });
  });
}

export async function wallet(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": return init(rest);
    case "venue": return venueCommand(rest);
    case "terms": return rest[0] === "create" ? termsCreate(rest.slice(1)) : termsCommand(rest, "wallet");
    case "service": return serviceCommand(rest, "wallet");
    case "replica": return replicaCommand(rest, "wallet");
    case "seed": return seed(rest);
    case "restore-seed": return restoreSeed(rest);
    case "handoff": return handoff(rest);
    case "restore": return restore(rest);
    case "request": return request(rest);
    case "pay": return pay(rest);
    case "freshen": return freshen(rest);
    case "move-window": return moveWindow(rest);
    case "reprove": return reprove(rest);
    case "submit": return submit(rest);
    case "status": return status(rest);
    case "sync": return sync(rest);
    case "fulfill": return fulfill(rest);
    case "fulfillment": return fulfillment(rest);
    case "demand": return demand(rest);
    case "withdraw": return withdraw(rest);
    case "settle": return settle(rest);
    case "presentation": return presentation(rest);
    case "publish": return publish(rest);
    case "publish-acceptance": return publishAcceptance(rest);
    case "issue": return issue(rest);
    case "accept": return accept(rest);
    case "burn": return burn(rest);
    default: throw new UsageError("moe wallet init|venue|terms|service|replica|seed|restore-seed|handoff|restore|request|pay|freshen|move-window|reprove|submit|status|sync|fulfill|fulfillment|demand|withdraw|settle|presentation|publish|publish-acceptance|issue|accept|burn");
  }
}
