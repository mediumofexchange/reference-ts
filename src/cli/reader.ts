// `moe reader` (slice 10 M10b, item 3): a supply reader holding no key. It
// keeps signed terms, a service file per operator, its own Ergo view and its
// retained evidence (`evidence.db`), and reads a backing's frontier at its
// own view's witnessed index: issued, burned, position, the canonical
// checkpoint and the publications with force (`supply`), or one demand's
// outcome under C3.8 (`presentation`). Evidence comes from the operator's
// service or from a package file. Reads keep their classes, walks, replay
// state and venue answers in `replay.db` (pool-v3 §14), so a later process
// verifies only what is new. A reader directory reads the construction it
// declares at init (M14g4); a lit reader keeps no parameters and opens no
// verifier.
import { mkdirSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { readPresentation, type Presentation } from "../pool/v3/dishonour.js";
import { EvidenceStore } from "../pool/v3/evidence-store.js";
import type { FaultResult } from "../pool/v3/fault-observer.js";
import { readFrontier } from "../pool/v3/package-reader.js";
import { FileInUse, ReplayStore } from "../pool/v3/replay-store.js";
import type { FrontierResult } from "../pool/v3/scope-reader.js";
import { V3ServiceClient } from "../pool/v3/service-client.js";
import { copyParameters, prepareParameters } from "../pool/parameter-files.js";
import { CommandError, flag, flags, has, hex, hex32, initDirectory, integer, UsageError, openDirectory, parseArguments, print, readJson, readRequired,
  required, writeReplace, type Arguments, type Directory, type FlagSpec, type Role } from "./common.js";
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

/** Whether a service call failed because the service did not answer (nothing listening, a dropped connection). */
export const unanswered = (error: unknown): boolean =>
  (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) ||
  (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/** The service's package over what `evidence` retains; a service that does not answer is unavailable evidence. */
async function served(client: V3ServiceClient, backing: Uint8Array, evidence: EvidenceStore): Promise<Uint8Array> {
  try { return (await client.sync(backing, evidence)).package; } catch (error) {
    if (unanswered(error)) throw new CommandError("UNAVAILABLE", "the operator's service did not answer");
    throw error;
  }
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

/** Sync the view, then read the backing's frontier at its witnessed index over the package `--package` names or
 * the operator's service supplies into `evidence.db`, resting on what earlier reads kept in `replay.db`. `use` takes
 * the read while the kept file is open: the canonical state is read from it. */
async function frontier(directory: Directory, args: Arguments, kept: KeptTerms, answers: boolean,
  use: (at: bigint, read: FrontierResult & FaultResult, sync: object) => void): Promise<void> {
  const view = openView(directory);
  try {
    const synced = await view.syncWitnessed(), at = synced.witnessedIndex;
    const verifier = await directoryVerifier(directory, args), construction = directory.construction;
    let evidence: EvidenceStore | undefined, store: ReplayStore | undefined;
    try {
      try { evidence = new EvidenceStore(directory.file("evidence.db"), { construction }); } catch (error) {
        if (error instanceof TypeError && /another construction's evidence/.test(error.message)) {
          throw new CommandError("CONSTRUCTION", `evidence.db holds another construction's evidence than this directory's ${nameOf(construction)}`);
        }
        throw inUse(error);
      }
      store = keptReplay(directory, at);
      const file = flag(args, "package");
      const source = file !== undefined ? readRequired(file, "package file") : await served(serviceClient(directory, kept, view), kept.backing, evidence);
      let read;
      try {
        read = await readFrontier(source, kept.signed, at, { construction, ...(verifier === undefined ? {} : { verifier }), venue: view.venue,
          reference: view.file.reference, evidence, store, answers });
      } catch (error) {
        throw inUse(error);
      }
      // A read is final at its judging index; where the view could not read further, the output says so.
      const stalled = synced.suppliers.filter(supplier => supplier.stopped !== undefined).map(supplier => ({ name: supplier.name, stopped: supplier.stopped }));
      use(at, read, { tipHeight: synced.tipHeight, unresolvedIndex: synced.unresolvedIndex ?? null, stopped: stalled });
    } finally { store?.close(); evidence?.close(); await verifier?.close(); }
  } finally { view.close(); }
}

const READ_FLAGS = { dir: "value", package: "value", verifiers: "value" } as const;

export async function supplyCommand(argv: readonly string[], role: Role): Promise<void> {
  const args = parseArguments(argv, READ_FLAGS, 1);
  const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
  const kept = keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue);
  await frontier(directory, args, kept, false, (at, read, sync) => {
    const canonical = read.canonical;
    print({ status: canonical === undefined ? "unavailable" : "final", backing: kept.backing, judgingIndex: at, sync,
      ...(canonical === undefined ? {} : { issued: canonical.state.issued, burned: canonical.state.burned,
        supply: canonical.state.issued - canonical.state.burned, position: canonical.state.position,
        checkpoint: { operator: canonical.commitment.operator, sequence: canonical.commitment.sequence, root: canonical.commitment.root, index: canonical.index } }),
      force: read.force.map(f => ({ index: f.index, kind: directory.construction.kind(f.record), sha256: sha256(f.bytes) })),
      faults: (read.faultEvidence ?? []).length });
  });
}

/** A demand's reading under C3.8 at its judging index: final once ended or overdue, pending while it stands. */
export function presentationOf(reading: Presentation, at: bigint) {
  return { status: reading.ended !== undefined || reading.overdue !== undefined ? "final" : "pending", judgingIndex: at, ...reading };
}

export async function presentationCommand(argv: readonly string[], role: Role): Promise<void> {
  const args = parseArguments(argv, READ_FLAGS, 2);
  const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
  const kept = keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue), demand = hex32(args.positional[1]!, "the demand");
  await frontier(directory, args, kept, true, (at, read, sync) => {
    const reading = readPresentation(read, directory.construction, kept.backing, kept.terms.obligor, demand);
    if (reading === undefined) throw new CommandError("ABSENT", "the demand is not in this backing's record");
    print({ ...presentationOf(reading, at), sync });
  });
}

export async function reader(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": return initRole(rest, "reader", { venue: "required", construction: true });
    case "terms": return termsCommand(rest, "reader");
    case "service": return serviceCommand(rest, "reader");
    case "supply": return supplyCommand(rest, "reader");
    case "presentation": return presentationCommand(rest, "reader");
    default: throw new UsageError("moe reader init|terms|service|supply|presentation");
  }
}
