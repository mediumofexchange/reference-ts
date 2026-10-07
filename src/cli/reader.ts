// `moe reader` (slice 10 M10b, item 3): a supply reader holding no key. It
// keeps signed terms, a service file per operator, its own Ergo view and its
// retained evidence (`evidence.db`), and reads a backing's frontier at its
// own view's witnessed index: issued, burned, position, the canonical
// checkpoint and the publications with force (`supply`), or one demand's
// outcome under C3.8 (`presentation`). Evidence comes from the operator's
// service, a replica's or a package file. Reads keep their classes, walks,
// replay state and venue answers in `replay.db` (pool-v3 §14), so a later
// process verifies only what is new. A reader directory reads the construction
// it declares at init (M14g4); a lit reader keeps no parameters and opens no
// verifier. `serve` makes it a replica (slice 12 M12b): it keeps each backing's
// evidence and serves it, with no credential, through the one wire.
import { mkdirSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { sha256 } from "@noble/hashes/sha2.js";
import { readPresentation, type Presentation } from "../pool/v3/dishonour.js";
import { EvidenceStore } from "../pool/v3/evidence-store.js";
import { PackageLimitError } from "../pool/v3/package.js";
import { EvidenceRefusal } from "../pool/v3/refusals.js";
import { selectionOf, V3Replica } from "../pool/v3/replica.js";
import { createV3EvidenceService } from "../pool/v3/service-http.js";
import type { ServedPackage } from "../pool/v3/store.js";
import { compareBytes, EncodingError } from "../bytes.js";
import type { FaultResult } from "../pool/v3/fault-observer.js";
import { readFrontier } from "../pool/v3/package-reader.js";
import { FileInUse, ReplayStore } from "../pool/v3/replay-store.js";
import type { FrontierResult } from "../pool/v3/scope-reader.js";
import { V3ServiceClient, V3ServiceClientError } from "../pool/v3/service-client.js";
import { copyParameters, prepareParameters } from "../pool/parameter-files.js";
import { CommandError, event, flag, flags, has, hex, hex32, initDirectory, integer, UsageError, openDirectory, parseArguments, pause, pollMs, print,
  readJson, readOptional, readRequired, required, writeReplace, type Arguments, type Directory, type FlagSpec, type Role } from "./common.js";
import { directoryVerifier } from "./backend.js";
import { CONSTRUCTION_NAMES, constructionNamed, DEFAULT_CONSTRUCTION, isConstructionName, nameOf, type ConstructionName } from "./construction.js";
import { authenticate, explain, keepTerms, keptTerms, type KeptTerms } from "./terms.js";
import { keepContext, openView, parseVenue, requireVenue, venueText, type View } from "./venue.js";

/** `init` shared by every role: parameters (copied from `--parameters` or fetched) where the directory verifies proofs,
 * then the venue when given. A role that serves one construction (`construction`) takes `--construction <name>`,
 * pool-v3's by default, and keeps it in config.json (M14g4); proving parameters are kept only for one with proofs. A
 * role that verifies nothing (`verifies: false`, the relay) keeps none and takes no `--parameters`. */
export async function initRole(argv: readonly string[], role: Role, options: { readonly venue: "required" | "optional" | ((args: Arguments) => "required" | "optional");
  readonly budget?: boolean; readonly construction?: boolean; readonly verifies?: false; readonly flags?: FlagSpec;
  readonly fill?: (directory: Directory, args: Arguments) => Promise<object> }): Promise<void> {
  const args = parseArguments(argv, { dir: "value", node: "values", ...(options.verifies === false ? {} : { parameters: "value" }), venue: "value",
    ...(options.budget ? { budget: "value" } : {}), ...(options.construction ? { construction: "value" } : {}), ...options.flags }, 0);
  // Refused before the directory exists, as a bad venue file is.
  const named = initConstruction(args);
  const venueRule = typeof options.venue === "function" ? options.venue(args) : options.venue;
  const nodes = flags(args, "node");
  if (nodes.length === 0) throw new UsageError("--node is required (one or more of this directory's own node endpoints)");
  for (const node of nodes) if (!/^https?:\/\/[^\s]+$/.test(node)) throw new CommandError("INVALID", `${node} is not a node URL`);
  const venueFile = flag(args, "venue"), parameters = flag(args, "parameters");
  if (venueFile === undefined && venueRule === "required") throw new UsageError("--venue is required");
  const construction = options.construction ? { construction: named } : {};
  const budget = options.budget ? integer(required(args, "budget"), "--budget", 0n, (1n << 63n) - 1n) : undefined;
  // The venue file is read before the directory exists, so a bad one leaves nothing behind.
  const venue = venueFile === undefined ? undefined : parseVenue(readJson(venueFile, "the venue file"));
  let shown: object = {};
  const directory = await initDirectory(required(args, "dir"), { role, nodes, ...(budget === undefined ? {} : { spendBudgetNanoErg: budget.toString() }),
    ...construction }, async opened => {
    try {
      if (options.verifies !== false && opened.construction.reader.proofs) {
        if (parameters !== undefined) await copyParameters(parameters, opened.path);
        else await prepareParameters(opened.path, { log: line => process.stderr.write(`${line}\n`) });
      }
    } catch (error) {
      if (error instanceof Error && /^No verified /.test(error.message)) throw new CommandError("PARAMETERS", error.message);
      throw error;
    }
    if (venue !== undefined) {
      const text = venueText(venue.profile, venue.anchorHeight);
      writeReplace(opened.file("venue.json"), text);
      await keepContext(opened, venue);
    }
    shown = await options.fill?.(opened, args) ?? {};
  });
  print({ status: "created", role, directory: directory.path, ...construction, ...(venue === undefined ? {} : { venue: venue.id }), ...shown });
}

/** The construction `--construction` names at init (pool-v3's by default), refusing an unknown name and `--parameters`
 * for a construction without proofs: checked before anything is created or read from stdin. */
export function initConstruction(args: Arguments): ConstructionName {
  const named = flag(args, "construction") ?? DEFAULT_CONSTRUCTION;
  if (!isConstructionName(named)) throw new UsageError(`--construction is one of ${CONSTRUCTION_NAMES.join(", ")}`);
  if (flag(args, "parameters") !== undefined && !constructionNamed(named).reader.proofs) {
    throw new UsageError(`a ${named} directory keeps no proving parameters: --parameters is not taken`);
  }
  return named;
}

/** `terms add` and `terms show`, shared by every role that keeps terms. */
export function termsCommand(argv: readonly string[], role: Role): void {
  const [verb, ...rest] = argv;
  if (verb === "add") {
    const args = parseArguments(rest, { dir: "value", terms: "value", signature: "value", synthetic: "switch" }, 1);
    const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
    const kept = authenticate(readRequired(required(args, "terms"), "terms file"), readRequired(required(args, "signature"), "signature file"),
      hex32(args.positional[0]!, "the backing"), venue, has(args, "synthetic"), directory.construction);
    keepTerms(directory, kept);
    print({ status: "kept", ...explain(kept, venue, directory.construction) });
  } else if (verb === "show") {
    const args = parseArguments(rest, { dir: "value" }, 1);
    const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
    print({ status: "kept", ...explain(keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue), venue, directory.construction) });
  } else throw new UsageError("terms add|show");
}

/** A service file: the operator's service URL and its service-wide wallet token, never per holder. */
interface ServiceFile { readonly url: string; readonly walletToken: string }
/** The operator's loopback service, or its holders' listener as a v3 onion service (M12a), which the client reaches only
 * through a loopback proxy. */
const SERVICE_URL = /^http:\/\/(127\.0\.0\.1:[0-9]{1,5}|[a-z2-7]{55}d\.onion(:[0-9]{1,5})?)\/$/;
function parseService(value: unknown): ServiceFile {
  const v = value as Partial<ServiceFile>;
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join() !== "url,walletToken" ||
      typeof v.url !== "string" || !SERVICE_URL.test(v.url) || typeof v.walletToken !== "string" || !/^[0-9a-f]{64}$/.test(v.walletToken)) {
    throw new CommandError("INVALID", "the service file is not { url, walletToken } with a loopback or v3 onion URL");
  }
  return { url: v.url, walletToken: v.walletToken };
}

/** `service add <backing> <file>`: keep the service file under the operator the terms name. */
export function serviceCommand(argv: readonly string[], role: Role): void {
  const [verb, ...rest] = argv;
  if (verb !== "add") throw new UsageError("service add");
  const args = parseArguments(rest, { dir: "value" }, 2);
  const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
  const kept = keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue), service = parseService(readJson(args.positional[1]!, "the service file"));
  mkdirSync(directory.file("services"), { recursive: true, mode: 0o700 });
  writeReplace(directory.file(`services/${hex(kept.terms.operator)}.json`), `${JSON.stringify(service, null, 2)}\n`);
  print({ status: "kept", operator: kept.terms.operator, url: service.url });
}

/** The client for the service of the operator the terms name; its expected identity comes from the terms, the venue
 * and the directory's construction, never from the service file. */
export function serviceClient(directory: Directory, kept: KeptTerms, view: View): V3ServiceClient {
  const service = parseService(readJson(directory.file(`services/${hex(kept.terms.operator)}.json`), "service file for the terms' operator (service add)"));
  return new V3ServiceClient(service.url, service.walletToken, { operator: kept.terms.operator, reference: view.file.reference,
    construction: directory.construction });
}

/** A replica's URL: the loopback or v3 onion forms a service file takes, with no credential (M12b). */
function parseReplicaUrl(value: string): string {
  if (!SERVICE_URL.test(value)) throw new CommandError("INVALID", "a replica URL is http://127.0.0.1:<port>/ or a v3 onion's http://<host>/");
  return value;
}
/** The replica URLs kept for an operator, in the order added. */
function replicaUrls(directory: Directory, operator: Uint8Array): string[] {
  const held = readOptional(directory.file(`replicas/${hex(operator)}.json`));
  if (held === undefined) return [];
  let value: { urls?: unknown };
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(held)) as { urls?: unknown }; } catch {
    throw new CommandError("INVALID", "the replicas file is not { urls }");
  }
  if (value === null || typeof value !== "object" || !Array.isArray(value.urls) || !value.urls.every(url => typeof url === "string")) throw new CommandError("INVALID", "the replicas file is not { urls }");
  return value.urls.map(url => parseReplicaUrl(url as string));
}

/** `replica add <backing> <url>`: keep a replica of the operator the terms name, after those added before. Replicas are
 * read where the operator's service refuses or does not answer. Adding a URL kept already changes nothing. */
export function replicaCommand(argv: readonly string[], role: Role): void {
  const [verb, ...rest] = argv;
  if (verb !== "add") throw new UsageError("replica add");
  const args = parseArguments(rest, { dir: "value" }, 2);
  const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
  const kept = keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue), url = parseReplicaUrl(args.positional[1]!);
  const urls = replicaUrls(directory, kept.terms.operator);
  if (!urls.includes(url)) {
    mkdirSync(directory.file("replicas"), { recursive: true, mode: 0o700 });
    writeReplace(directory.file(`replicas/${hex(kept.terms.operator)}.json`), `${JSON.stringify({ urls: [...urls, url] }, null, 2)}\n`);
  }
  print({ status: "kept", operator: kept.terms.operator, replicas: [...new Set([...urls, url])] });
}

/** Where a read's evidence came from: a replica, the operator's service, a package file, or (a wallet) the package its
 * last sync kept or a saved retry's none. */
export type EvidenceOrigin = "replica" | "served" | "file" | "kept" | "saved";
/** A replica passed over, and why. */
export interface Skipped { readonly url: string; readonly code: string }

/** Whether a replica's failure passes the read on to the next source: it did not answer, refused, or sent evidence that
 * does not frame, assemble or fit the budget. The holder's own proxy that is not there (the client's `PROXY`, status 0)
 * stops the read, as for the operator; a replica's reply naming `PROXY` is its refusal. */
export const passedOver = (error: unknown): string | undefined =>
  unanswered(error) ? "UNAVAILABLE" :
  error instanceof V3ServiceClientError ? (error.code === "PROXY" && error.status === 0 ? undefined : error.code) :
  error instanceof EncodingError ? "INVALID" : error instanceof EvidenceRefusal || error instanceof PackageLimitError ? "EVIDENCE" : undefined;

/** A sync from a source: where it came from, and the replicas passed over before it. */
export interface Synced {
  readonly served: ServedPackage; readonly origin: "replica" | "served"; readonly url: string; readonly skipped: readonly Skipped[];
}

/**
 * Sync `kept`'s backing into the party's evidence store from its sources, in order (M12b): the operator's service
 * (`service add`), then, where it fails as `passedOver` names (it does not answer, refuses or sends evidence that does
 * not frame or assemble) or none is kept, each replica of the terms' operator as added, each passed over likewise; every
 * source passed over is reported. Where none answered, the operator's refusal stands, and an operator that did not
 * answer leaves `{ skipped }` (a wallet then reads its kept package). `except` are URLs never asked (a replica's
 * own). Each source keeps its own mark in the store (`V3ServiceClient.sync`), so one source's answer never tells
 * another what to leave out.
 */
export async function syncSources(directory: Directory, kept: KeptTerms, view: View,
  sync: (client: V3ServiceClient) => Promise<ServedPackage>, except: readonly string[] = []): Promise<Synced | { readonly skipped: readonly Skipped[] }> {
  const skipped: Skipped[] = [], identity = { operator: kept.terms.operator, reference: view.file.reference, construction: directory.construction };
  let refusal: unknown;
  const added = replicaUrls(directory, kept.terms.operator), replicas = added.filter(url => !except.includes(url));
  // A reader with replicas need not keep the operator's service (all of them passed over included).
  if (added.length === 0 || readOptional(directory.file(`services/${hex(kept.terms.operator)}.json`)) !== undefined) {
    const client = serviceClient(directory, kept, view);
    if (!except.includes(client.baseUrl)) {
      try { return { served: await sync(client), origin: "served", url: client.baseUrl, skipped }; } catch (error) {
        // A refusal passes the read to the replicas (replication is the remedy for withheld evidence), and stands if none answers.
        const code = passedOver(error);
        if (code === undefined || replicas.length === 0 && !unanswered(error)) throw error;
        if (!unanswered(error)) refusal = error;
        skipped.push({ url: client.baseUrl, code });
      }
    }
  }
  for (const url of replicas) {
    try { return { served: await sync(new V3ServiceClient(url, undefined, identity)), origin: "replica", url, skipped }; } catch (error) {
      const code = passedOver(error);
      if (code === undefined) throw error;
      skipped.push({ url, code });
    }
  }
  if (refusal !== undefined) throw refusal;
  return { skipped };
}

/** Whether a service call failed because the service did not answer (nothing listening, a dropped connection). */
export const unanswered = (error: unknown): boolean =>
  (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) ||
  (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/** Whether a read failed for evidence its store does not hold. */
const unresolvedEvidence = (error: unknown): boolean => error instanceof EvidenceRefusal && error.status === "unresolved-evidence";

/** The sources whose answer from nothing a read found still unresolved, each at the selection sequence it served then,
 * for one backing: `readRepaired` asks such a source from nothing again only once its selection moves. */
export interface RepairRecord {
  unresolvedAt(url: string): bigint | undefined;
  record(url: string, sequence: bigint | undefined): void;
}

/** The directory's repair record for `backing`, kept in `unresolved.json` so that each command and each replica round
 * reads what the last one found. A record that does not parse is no record: it costs one more answer from nothing. */
export function repairRecord(directory: Directory, backing: Uint8Array): RepairRecord {
  const file = directory.file("unresolved.json"), name = hex(backing);
  const all = (): Record<string, Record<string, string>> => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(readOptional(file) ?? new TextEncoder().encode("{}")));
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  };
  return {
    unresolvedAt(url) {
      const text = all()[name]?.[url];
      return typeof text === "string" && /^(0|[1-9][0-9]{0,19})$/.test(text) ? BigInt(text) : undefined;
    },
    record(url, sequence) {
      const records = all(), own = { ...(typeof records[name] === "object" && records[name] !== null ? records[name] : {}) };
      if (sequence === undefined) { if (!(url in own)) return; delete own[url]; } else own[url] = String(sequence);
      if (Object.keys(own).length === 0) delete records[name]; else records[name] = own;
      writeReplace(file, `${JSON.stringify(records, null, 2)}\n`);
    },
  };
}

/**
 * Read over what the sources supply, and repair a source that withheld (audit 30 (au)). A source's mark moves once its
 * answer holds the selection (`V3ServiceClient.sync`), so a source that sent the selection whole but left out an earlier
 * dependency (an opening checkpoint's directory, what an opening took, a terms field) moved its mark past it, and later
 * syncs from it ask only after that mark. Where `use` ends `unresolved-evidence` over a source's answer, the read takes
 * the library's remedy (`V3Wallet.supply`): that source is synced once more from nothing (`full`, which also replaces
 * what storage damaged) and read again; where that read is still unresolved, the source is passed over as `UNRESOLVED`
 * and the next source is asked, until one resolves. Each source is asked from nothing at most once per selection it
 * serves: `record` keeps the selection at which its answer from nothing stayed unresolved, and while it serves that
 * selection it is asked only after its mark and, still unresolved, passed over at once. So a read that stays unresolved
 * (every source withholding, or the holder's own venue view or storage failing, which reads the same) costs one answer
 * from nothing per source and selection, not one per command or round. A read that no source can resolve refuses with
 * the sources passed over named. `supply` syncs from the sources not in `except`, from nothing where `full` says so;
 * `use` receives what it supplied, with every source passed over named in `skipped`.
 */
export async function readRepaired<T>(
  supply: (options: { readonly full: (url: string) => boolean; readonly except: readonly string[] }) => Promise<Synced | { readonly skipped: readonly Skipped[] }>,
  use: (synced: Synced | { readonly skipped: readonly Skipped[] }) => Promise<T>, record: RepairRecord): Promise<T> {
  const except: string[] = [], unresolved: Skipped[] = [], fromNothing = new Set<string>();
  let repairing = false, refusal: EvidenceRefusal | undefined;
  // Once a read is unresolved, a source not yet asked from nothing at a recorded selection is asked from nothing.
  const full = (url: string) => fromNothing.has(url) || repairing && record.unresolvedAt(url) === undefined;
  for (;;) {
    const supplied = await supply({ full, except }), synced = { ...supplied, skipped: [...unresolved, ...supplied.skipped] };
    if (refusal !== undefined && !("served" in synced)) {
      const final = new EvidenceRefusal(refusal.status);
      final.message = `${refusal.status}: no source resolved the read (${synced.skipped.map(s => `${s.url} ${s.code}`).join(", ")})`;
      throw final;
    }
    let wasFull = false;
    if ("served" in synced) wasFull = full(synced.url);
    try {
      const result = await use(synced);
      if ("served" in synced) record.record(synced.url, undefined);
      return result;
    } catch (error) {
      if (!("served" in synced) || !unresolvedEvidence(error)) throw error;
      refusal = error as EvidenceRefusal; repairing = true;
      const sequence = synced.served.selection.sequence, url = synced.url;
      if (!wasFull && record.unresolvedAt(url) !== sequence) { record.record(url, undefined); fromNothing.add(url); continue; }
      if (wasFull) record.record(url, sequence);
      except.push(url); unresolved.push({ url, code: "UNRESOLVED" });
    }
  }
}

/** Read over the package its sources supply into `evidence`, repaired as `readRepaired` says; none answering is
 * unavailable evidence. `except` are URLs never asked (a replica's own). */
async function served<T>(directory: Directory, kept: KeptTerms, view: View, evidence: EvidenceStore, use: (synced: Synced) => Promise<T>,
  except: readonly string[] = []): Promise<T> {
  return readRepaired(options => syncSources(directory, kept, view, client => client.sync(kept.backing, evidence, { full: options.full(client.baseUrl) }),
    [...except, ...options.except]), async synced => {
    if (!("served" in synced)) {
      throw new CommandError("UNAVAILABLE", `no source answered: ${synced.skipped.map(s => `${s.url} ${s.code}`).join(", ") || "none kept"}`);
    }
    return use(synced);
  }, repairRecord(directory, kept.backing));
}

/** The directory's kept replay file (pool-v3 §14), vouched for by `replay.db.sha256`: one that fails its digest is
 * discarded on opening. Kept answers stand only while the view's finality does: kept state read through a later
 * witnessed index than `at`, the view's own now (a view restored from an older copy), is not this view's, so it is
 * discarded and the read asks the venue for everything. */
export function keptReplay(directory: Directory, at: bigint): ReplayStore {
  let store: ReplayStore;
  try { store = new ReplayStore(directory.file("replay.db"), { digest: directory.file("replay.db.sha256") }); } catch (error) { throw inUse(error); }
  try { store.discardKeptAfter(at); } catch (error) { store.close(); throw error; }
  return store;
}

/** A file held by a process outside the directory's lock (another tool, a scanner): a refusal, not a failure. */
const inUse = (error: unknown): unknown => error instanceof FileInUse ?
  new CommandError("STORAGE", `another process holds this reader's ${error.file}`) : error;

/** Where a served read's evidence came from, as outputs name it. */
const originOf = (supplied: Synced): object => ({ evidence: supplied.origin, ...(supplied.origin === "replica" ? { replica: supplied.url } : {}),
  ...(supplied.skipped.length > 0 ? { skipped: supplied.skipped } : {}) });

/** Sync the view, then read the backing's frontier at its witnessed index over the package `--package` names or
 * the operator's service supplies into `evidence.db`, resting on what earlier reads kept in `replay.db`. `use` takes
 * the read while the kept file is open: the canonical state is read from it. */
async function frontier(directory: Directory, args: Arguments, kept: KeptTerms, answers: boolean,
  use: (at: bigint, read: FrontierResult & FaultResult, sync: object, origin: object) => void): Promise<void> {
  const view = openView(directory);
  try {
    const synced = await view.syncWitnessed(), at = synced.witnessedIndex;
    const verifier = await directoryVerifier(directory, args);
    let evidence: EvidenceStore | undefined, store: ReplayStore | undefined;
    try {
      evidence = openEvidence(directory);
      const opened = { evidence, store: store = keptReplay(directory, at) };
      // A read is final at its judging index; where the view could not read further, the output says so.
      const stalled = synced.suppliers.filter(supplier => supplier.stopped !== undefined).map(supplier => ({ name: supplier.name, stopped: supplier.stopped }));
      const readOver = async (source: Uint8Array, origin: object) => {
        let read;
        try {
          read = await readFrontier(source, kept.signed, at, { construction: directory.construction, ...(verifier === undefined ? {} : { verifier }), venue: view.venue,
            reference: view.file.reference, ...opened, answers });
        } catch (error) {
          throw inUse(error);
        }
        use(at, read, { tipHeight: synced.tipHeight, unresolvedIndex: synced.unresolvedIndex ?? null, stopped: stalled }, origin);
      };
      const file = flag(args, "package");
      if (file !== undefined) await readOver(readRequired(file, "package file"), { evidence: "file" });
      else await served(directory, kept, view, evidence, supplied => readOver(supplied.served.package, originOf(supplied)));
    } finally { store?.close(); evidence?.close(); await verifier?.close(); }
  } finally { view.close(); }
}

/** The directory's evidence file, under its construction; `shared` for a replica's (M12b). */
function openEvidence(directory: Directory, shared = false): EvidenceStore {
  try { return new EvidenceStore(directory.file("evidence.db"), { construction: directory.construction, shared }); } catch (error) {
    if (error instanceof TypeError && /another construction's evidence/.test(error.message)) {
      throw new CommandError("CONSTRUCTION", `evidence.db holds another construction's evidence than this directory's ${nameOf(directory.construction)}`);
    }
    throw inUse(error);
  }
}

const READ_FLAGS = { dir: "value", package: "value", verifiers: "value" } as const;

export async function supplyCommand(argv: readonly string[], role: Role): Promise<void> {
  const args = parseArguments(argv, READ_FLAGS, 1);
  const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
  const kept = keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue);
  await frontier(directory, args, kept, false, (at, read, sync, origin) => print(supplyOf(kept, at, read, sync, origin, directory)));
}

/** A supply read's output, as `supply` prints it and a replica's rounds report it. */
function supplyOf(kept: KeptTerms, at: bigint, read: FrontierResult & FaultResult, sync: object, origin: object, directory: Directory): object {
  const canonical = read.canonical;
  return { status: canonical === undefined ? "unavailable" : "final", backing: kept.backing, judgingIndex: at, sync, ...origin,
      ...(canonical === undefined ? {} : { issued: canonical.state.issued, burned: canonical.state.burned,
        supply: canonical.state.issued - canonical.state.burned, position: canonical.state.position,
        checkpoint: { operator: canonical.commitment.operator, sequence: canonical.commitment.sequence, root: canonical.commitment.root, index: canonical.index } }),
      force: read.force.map(f => ({ index: f.index, kind: directory.construction.kind(f.record), sha256: sha256(f.bytes) })),
      faults: (read.faultEvidence ?? []).length };
}

/** A demand's reading under C3.8 at its judging index: final once ended or overdue, pending while it stands. */
export function presentationOf(reading: Presentation, at: bigint) {
  return { status: reading.ended !== undefined || reading.overdue !== undefined ? "final" : "pending", judgingIndex: at, ...reading };
}

export async function presentationCommand(argv: readonly string[], role: Role): Promise<void> {
  const args = parseArguments(argv, READ_FLAGS, 2);
  const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
  const kept = keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue), demand = hex32(args.positional[1]!, "the demand");
  await frontier(directory, args, kept, true, (at, read, sync, origin) => {
    const reading = readPresentation(read, directory.construction, kept.backing, kept.terms.obligor, demand);
    if (reading === undefined) throw new CommandError("ABSENT", "the demand is not in this backing's record");
    print({ ...presentationOf(reading, at), sync, ...origin });
  });
}

/** The backings whose terms the directory keeps, in name order. */
function keptBackings(directory: Directory): Uint8Array[] {
  let names: string[];
  try { names = readdirSync(directory.file("terms")); } catch { return []; }
  return names.filter(name => /^[0-9a-f]{64}$/.test(name)).sort().map(name => hex32(name, "a kept backing"));
}

/** What a replica's round reports instead of stopping: a source that did not answer or refused, evidence that does not
 * frame, assemble or fit, a verifier or replay file another process holds. */
const roundRefusal = (error: unknown): string | undefined =>
  error instanceof CommandError ? error.code : error instanceof V3ServiceClientError && error.code === "PROXY" ? "PROXY" : passedOver(error);

/**
 * `serve [--port <p>] [--onion <host>] [--poll-ms <ms>]` (slice 12 M12b): make this reader a replica. Each round syncs
 * the view, then for each kept backing syncs its evidence from its sources (the operator's service, then its replicas;
 * never itself) into `evidence.db` and reads the frontier as `supply` does, proofs verified. A read that is final over a
 * selection its source's mark reached becomes that backing's served selection. It serves `GET /evidence` through the one
 * wire on a loopback listener with no credential (published evidence is retrievable by a stranger), from what
 * `evidence.db` holds, so it keeps serving while the operator is down, across restarts. Writes `replica.json` (the URL
 * to hand to holders; with `--onion`, the v3 onion name Tor serves for this port) and prints one line once listening,
 * one per backing whose served sequence moved, and one once stopped; a round's refusal is an event on stderr. Stops on
 * SIGTERM or SIGINT.
 */
async function serve(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", verifiers: "value", "poll-ms": "value", port: "value", onion: "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "reader"), venue = requireVenue(directory), construction = directory.construction;
  const port = Number(integer(flag(args, "port") ?? "0", "--port", 0n, 65535n)), ms = pollMs(args), onion = flag(args, "onion");
  if (onion !== undefined && !/^[a-z2-7]{55}d\.onion$/.test(onion)) throw new UsageError("--onion takes a v3 onion host: 56 base32 characters and .onion");
  const view = openView(directory);
  let evidence: EvidenceStore | undefined, verifier: Awaited<ReturnType<typeof directoryVerifier>> | undefined;
  try {
    verifier = await directoryVerifier(directory, args);
    evidence = openEvidence(directory, true);
  } catch (error) { await verifier?.close(); evidence?.close(); view.close(); throw error; }
  const replica = new V3Replica(directory.file("evidence.db"), evidence, view.venue.id);
  const server = createV3EvidenceService(replica);
  // A stream its file could not finish (storage damage) ended short; the replica's owner is told.
  server.on("evidenceError", (error: unknown) => { event({ event: "evidence", code: "STORAGE", message: (error as Error).message }); });
  try {
    await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", () => { server.off("error", failed); done(); }); });
  } catch (error) {
    await verifier?.close(); evidence.close(); view.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new CommandError("UNAVAILABLE", `port ${port} is in use`);
    throw error;
  }
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, url = onion === undefined ? local : `http://${onion}/`;
  writeReplace(directory.file("replica.json"), `${JSON.stringify({ url }, null, 2)}\n`);
  let stopping = false, wake: (() => void) | undefined;
  const stop = () => { stopping = true; wake?.(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  print({ status: "serving", url, port: (server.address() as AddressInfo).port, backings: keptBackings(directory).map(hex),
    served: keptBackings(directory).map(backing => ({ backing, sequence: replica.selection(backing)?.selection.sequence ?? null })) });
  const round = async (): Promise<void> => {
    const synced = await view.syncWitnessed(), at = synced.witnessedIndex;
    for (const backing of keptBackings(directory)) {
      if (stopping) return;
      try {
        const kept = keptTerms(directory, backing, venue), before = replica.selection(backing)?.selection.sequence;
        await served(directory, kept, view, evidence!, async supplied => {
          const store = keptReplay(directory, at);
          let read;
          try {
            read = await readFrontier(supplied.served.package, kept.signed, at, { construction, ...(verifier === undefined ? {} : { verifier }), venue: view.venue,
              reference: view.file.reference, evidence: evidence!, store, answers: false });
          } finally { store.close(); }
          // Served only where its own read found the selection canonical: it holds what a read of it needs.
          const canonical = read.canonical?.commitment, selected = supplied.served.selection;
          const final = canonical !== undefined && canonical.sequence === selected.sequence && compareBytes(canonical.operator, selected.operator) === 0 &&
            compareBytes(canonical.root, selected.root) === 0 && replica.keep(supplied.served);
          const now = replica.selection(backing)?.selection.sequence;
          if (now !== before || !final) {
            print({ ...supplyOf(kept, at, read, { tipHeight: synced.tipHeight, unresolvedIndex: synced.unresolvedIndex ?? null }, originOf(supplied), directory),
              served: now ?? null });
          }
        }, [local, url]);
      } catch (error) {
        const code = roundRefusal(error);
        if (code === undefined) throw error;
        event({ event: "refused", backing, code, message: (error as Error).message });
      }
    }
  };
  try {
    while (!stopping) {
      await round();
      if (!stopping) await new Promise<void>(done => { wake = done; setTimeout(done, ms); });
    }
  } finally {
    await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
    await verifier?.close(); evidence.close(); view.close();
  }
  print({ status: "stopped" });
}

export async function reader(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": return initRole(rest, "reader", { venue: "required", construction: true });
    case "terms": return termsCommand(rest, "reader");
    case "service": return serviceCommand(rest, "reader");
    case "supply": return supplyCommand(rest, "reader");
    case "presentation": return presentationCommand(rest, "reader");
    case "replica": return replicaCommand(rest, "reader");
    case "serve": return serve(rest);
    default: throw new UsageError("moe reader init|terms|service|replica|supply|presentation|serve");
  }
}
