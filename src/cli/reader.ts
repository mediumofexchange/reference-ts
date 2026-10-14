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
import { sha256 } from "@noble/hashes/sha2.js";
import { readPresentation, type Presentation } from "../pool/v3/dishonour.js";
import { EvidenceStore } from "../pool/v3/evidence-store.js";
import { PackageLimitError } from "../pool/v3/package.js";
import { EvidenceRefusal, ReplayRefusal } from "../pool/v3/refusals.js";
import { V3Replica } from "../pool/v3/replica.js";
import { createV3EvidenceService } from "../pool/v3/service-http.js";
import type { ServedPackage } from "../pool/v3/store.js";
import { compareBytes, EncodingError } from "../bytes.js";
import type { FaultResult } from "../pool/v3/fault-observer.js";
import { readFrontier } from "../pool/v3/package-reader.js";
import { FileInUse, ReplayStore } from "../pool/v3/replay-store.js";
import type { FrontierResult } from "../pool/v3/scope-reader.js";
import { serviceSupply, unanswered, V3ServiceClient, V3ServiceClientError, type CheckSource } from "../pool/v3/service-client.js";
import type { TrailCheckSet } from "../pool/v3/check-set.js";
import type { Construction } from "../pool/v3/construction.js";
import { succinctPoolV3, type CheckSet, type CheckSupply, type SpanProver } from "../pool/v3/succinct.js";
import { copyParameters, prepareParameters } from "../pool/parameter-files.js";
import type { ProofVerifier } from "../pool/proof-verifier.js";
import { CommandError, event, flag, flags, has, hex, hex32, initDirectory, initialized, integer, requireNew, UsageError, openDirectory, PACKAGE_FILE_LIMIT, parseArguments, print, READ_FLAGS,
  readJson, readOptional, readRequired, required, writeReplace, type Arguments, type Directory, type FlagSpec, type Role } from "./common.js";
import { directoryVerifier, openCheckSet, openCoverProver } from "./backend.js";
import { CONSTRUCTION_NAMES, constructionNamed, DEFAULT_CONSTRUCTION, isConstructionName, nameOf, type ConstructionName } from "./construction.js";
import { authenticate, explain, keepTerms, keptTerms, type KeptTerms } from "./terms.js";
import { closeListener, isListenerUrl, listenerFile, listenLoopback, SERVE_FLAGS, serveFlags, untilStopped } from "./serve.js";
import { keepContext, openView, ownVenue, parseVenue, requireVenue, venueText, type View } from "./venue.js";

/** `init` shared by every role: parameters (copied from `--parameters` or fetched) where the directory verifies proofs,
 * then the venue when given. A role that serves one construction (`construction`) takes `--construction <name>`,
 * pool-v3's by default, and keeps it in config.json (M14g4); proving parameters are kept only for one with proofs. A
 * role that verifies nothing (`verifies: false`, the relay) keeps none and takes no `--parameters`.
 *
 * A rerun over a directory whose init finished is the exact retry after a lost reply (Next 4 (br)): where the directory
 * is this role's and holds the configuration and venue this init would write, it prints what the init printed, with
 * `replay: true`, from what the directory keeps (`replay`, which refuses `EXISTS` where the role's own arguments
 * differ; a role that shows nothing has none); another configuration there is `EXISTS`, another role's `ROLE`. A venue made after an init without
 * `--venue` (`venue create`) is the directory's own, so that init still replays. `ready` reads input (`restore-seed`'s
 * stdin) only once the directory is judged: new, or a finished init these arguments replay. */
export async function initRole(argv: readonly string[], role: Role, options: { readonly venue: "required" | "optional" | ((args: Arguments) => "required" | "optional");
  readonly budget?: boolean; readonly construction?: boolean; readonly read?: boolean; readonly verifies?: false; readonly flags?: FlagSpec;
  readonly ready?: () => Promise<void> } & ({ readonly fill?: undefined } | {
  readonly fill: (directory: Directory, args: Arguments) => Promise<object>;
  readonly replay: (directory: Directory, args: Arguments) => Promise<object> | object })): Promise<void> {
  const args = parseArguments(argv, { dir: "value", node: "values", ...(options.verifies === false ? {} : { parameters: "value" }), venue: "value",
    ...(options.budget ? { budget: "value" } : {}), ...(options.construction ? { construction: "value" } : {}), ...(options.read ? { read: "value" } : {}),
    ...options.flags }, 0);
  // Refused before the directory exists, as a bad venue file is.
  const named = initConstruction(args), succinct = options.read === true && initRead(args, named);
  const venueRule = typeof options.venue === "function" ? options.venue(args) : options.venue;
  const nodes = flags(args, "node");
  if (nodes.length === 0) throw new UsageError("--node is required (one or more of this directory's own node endpoints)");
  for (const node of nodes) if (!/^https?:\/\/[^\s]+$/.test(node)) throw new CommandError("INVALID", `${node} is not a node URL`);
  const venueFile = flag(args, "venue"), parameters = flag(args, "parameters");
  if (venueFile === undefined && venueRule === "required") throw new UsageError("--venue is required");
  const construction = { ...(options.construction ? { construction: named } : {}), ...(succinct ? { read: "succinct" as const } : {}) };
  const budget = options.budget ? integer(required(args, "budget"), "--budget", 0n, (1n << 63n) - 1n) : undefined;
  // The venue file is read before the directory exists, so a bad one leaves nothing behind.
  const venue = venueFile === undefined ? undefined : parseVenue(readJson(venueFile, "the venue file"));
  const out = (path: string, shown: object) =>
    ({ status: "created", role, directory: path, ...construction, ...(venue === undefined ? {} : { venue: venue.id }), ...shown });
  if (initialized(required(args, "dir"))) {
    const directory = openDirectory(required(args, "dir"), role), own = ownVenue(directory), config = directory.config;
    const differs = [
      ...(config.nodes.length === nodes.length && config.nodes.every((node, i) => node === nodes[i]) ? [] : ["--node"]),
      ...(config.spendBudgetNanoErg === budget?.toString() ? [] : ["--budget"]),
      ...(!options.construction || nameOf(directory.construction) === named ? [] : ["--construction"]),
      ...(directory.succinct === succinct ? [] : ["--read"]),
      ...(venue === undefined || (own !== undefined && venueText(own.profile, own.anchorHeight) === venueText(venue.profile, venue.anchorHeight)) ? [] : ["--venue"]),
    ];
    if (differs.length > 0) throw new CommandError("EXISTS", `${directory.path} was made by another init (${differs.join(", ")}); init creates a new directory`);
    await options.ready?.();
    print({ ...out(directory.path, options.fill === undefined ? {} : await options.replay(directory, args)), replay: true });
    return;
  }
  requireNew(required(args, "dir"));
  await options.ready?.();
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
  print(out(directory.path, shown));
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

/** Whether `--read` names succinct reads (succinct-read.md, slice 38): `complete` (the default) or `succinct`, which
 * only a pool-v3 directory takes, its trail statement proofs taken from covers under the shipped check set. Checked
 * before anything is created or read from stdin. */
export function initRead(args: Arguments, named: ConstructionName): boolean {
  const read = flag(args, "read") ?? "complete";
  if (read !== "complete" && read !== "succinct") throw new UsageError("--read is complete or succinct");
  if (read === "succinct" && named !== "moe/pool/v3") throw new UsageError(`a ${named} directory reads completely: its records carry no proofs to cover`);
  return read === "succinct";
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

/** A service file: the operator's loopback service, or its holders' listener as a v3 onion service (M12a), and the
 * service-wide wallet token. */
const parseService = (value: unknown) => listenerFile(value, "walletToken", "service");

/** `service add <backing> <file>`: keep the service file under the operator the terms name. */
export function serviceCommand(argv: readonly string[], role: Role): void {
  const [verb, ...rest] = argv;
  if (verb !== "add") throw new UsageError("service add");
  const args = parseArguments(rest, { dir: "value" }, 2);
  const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
  const kept = keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue), service = parseService(readJson(args.positional[1]!, "the service file"));
  mkdirSync(directory.file("services"), { recursive: true, mode: 0o700 });
  writeReplace(directory.file(`services/${hex(kept.terms.operator)}.json`), `${JSON.stringify({ url: service.url, walletToken: service.token }, null, 2)}\n`);
  print({ status: "kept", operator: kept.terms.operator, url: service.url });
}

/** The client for the service of the operator the terms name; its expected identity comes from the terms, the venue
 * and the directory's construction (or the construction a read takes evidence under), never from the service file. */
export function serviceClient(directory: Directory, kept: KeptTerms, view: View, construction = directory.construction): V3ServiceClient {
  const service = parseService(readJson(directory.file(`services/${hex(kept.terms.operator)}.json`), "service file for the terms' operator (service add)"));
  return new V3ServiceClient(service.url, service.token, { operator: kept.terms.operator, reference: view.file.reference, construction });
}

/** A succinct directory's reading of one backing (succinct-read.md, slice 38): pool-v3 over proof-free trails under the
 * shipped check set, the covers and the proofs no cover reaches asked of the backing's replicas, then of the operator's
 * service (any party may serve either: §2 rule 6), with what it asked, for the read's output. */
export interface Reading {
  readonly construction: Construction;
  /** The judgment a read under it gives, as outputs name it: succinct, the set it rests on and the asks it made. */
  out(): object;
}
export function readingOf(directory: Directory, kept: KeptTerms, view: View, set: CheckSet): Reading {
  const { supply, out } = succinctSupply(directory, kept, view, set);
  return { construction: succinctPoolV3({ set, supply }) as Construction, out };
}
/** A succinct read's supply for `kept`'s backing, and the output naming what the read rests on and asked. */
export function succinctSupply(directory: Directory, kept: KeptTerms, view: View, set: CheckSet): { readonly supply: CheckSupply; out(): object } {
  const identity = { operator: kept.terms.operator, reference: view.file.reference };
  // A replica's client is made when first asked: an onion one needs the holder's proxy, which stops only a read reaching it.
  const lazy = (make: () => V3ServiceClient): CheckSource => {
    let client: V3ServiceClient | undefined;
    return { cover: (s, digest) => (client ??= make()).cover(s, digest), proof: (hash, at) => (client ??= make()).proof(hash, at) };
  };
  const sources = [...new Set(replicaUrls(directory, kept.terms.operator).map(url => new URL(url).href))]
    .map(url => lazy(() => new V3ServiceClient(url, undefined, identity)));
  if (readOptional(directory.file(`services/${hex(kept.terms.operator)}.json`)) !== undefined) sources.push(lazy(() => serviceClient(directory, kept, view)));
  const wire = serviceSupply(set.identity, sources), asked = { covers: 0, covered: 0, proofs: 0 };
  const supply: CheckSupply = {
    cover: async (digest, accept) => { asked.covers++; const answer = await wire.cover(digest, accept); if (answer !== undefined) asked.covered++; return answer; },
    proof: async (hash, at) => { const answer = await wire.proof(hash, at); if (answer !== undefined) asked.proofs++; return answer; },
  };
  return { supply,
    out: () => ({ read: { judgment: "succinct", set: set.identity, testSet: set.test, coversAsked: asked.covers, coversTaken: asked.covered, proofsFetched: asked.proofs } }) };
}

/** How long a replica proves new covers after each round (`serve --prove`) before it syncs again: about ten leaves on
 * four cores with the WebAssembly backend (slice 36). */
const PROVE_ROUND_MS = 600_000;

/** A replica's URL: the loopback or v3 onion forms a service file takes, with no credential (M12b). */
function parseReplicaUrl(value: string): string {
  if (!isListenerUrl(value)) throw new CommandError("INVALID", "a replica URL is http://127.0.0.1:<port>/ or a v3 onion's http://<host>/");
  return value;
}
/** The replica URLs kept for an operator, in the order added. */
function replicaUrls(directory: Directory, operator: Uint8Array): string[] {
  const file = directory.file(`replicas/${hex(operator)}.json`), held = readOptional(file);
  if (held === undefined) return [];
  let value: { urls?: unknown };
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(held)) as { urls?: unknown }; } catch {
    throw new CommandError("INVALID", "the replicas file is not { urls }");
  }
  // Each is judged as `replica add` judges it; one that is not (kept by an earlier release) is named with its file.
  if (value === null || typeof value !== "object" || !Array.isArray(value.urls) ||
      !value.urls.every(url => typeof url === "string" && isListenerUrl(url))) throw new CommandError("INVALID", `${file} is not { urls } of replica URLs: correct or remove it`);
  return value.urls as string[];
}

/** `replica add <backing> <url>`: keep a replica of the operator the terms name, after those added before. Replicas are
 * read where the operator's service refuses or does not answer. `replica remove <backing> <url>`: read that replica no
 * more (Next 4 (bs)). URLs are one where their clients' are (`new URL(url).href`), and adding a URL kept already, or
 * removing one not kept, changes nothing, so each is its own exact retry. */
export function replicaCommand(argv: readonly string[], role: Role): void {
  const [verb, ...rest] = argv;
  if (verb !== "add" && verb !== "remove") throw new UsageError("replica add|remove");
  const args = parseArguments(rest, { dir: "value" }, 2);
  const directory = openDirectory(required(args, "dir"), role), venue = requireVenue(directory);
  const kept = keptTerms(directory, hex32(args.positional[0]!, "the backing"), venue), url = parseReplicaUrl(args.positional[1]!);
  const urls = replicaUrls(directory, kept.terms.operator), file = directory.file(`replicas/${hex(kept.terms.operator)}.json`);
  const others = urls.filter(held => new URL(held).href !== new URL(url).href);
  const replicas = verb === "add" && others.length === urls.length ? [...urls, url] : verb === "add" ? urls : others;
  if (replicas.length !== urls.length) {
    mkdirSync(directory.file("replicas"), { recursive: true, mode: 0o700 });
    writeReplace(file, `${JSON.stringify({ urls: replicas }, null, 2)}\n`);
  }
  print({ status: verb === "add" ? "kept" : "removed", operator: kept.terms.operator, replicas });
}

/** A replica passed over, and why. */
export interface Skipped { readonly url: string; readonly code: string }

/** Whether a replica's failure passes the read on to the next source: it did not answer, refused, or sent evidence that
 * does not frame, assemble or fit the budget. The holder's own proxy that is not there (the client's `PROXY`, status 0)
 * stops the read, as for the operator; a replica's reply naming `PROXY` is its refusal. */
export const passedOver = (error: unknown): string | undefined =>
  unanswered(error) ? "UNAVAILABLE" :
  error instanceof V3ServiceClientError ? (error.code === "PROXY" && error.status === 0 ? undefined : error.code) :
  error instanceof EncodingError ? "INVALID" : error instanceof EvidenceRefusal || error instanceof PackageLimitError ? "EVIDENCE" : undefined;

/** A sync from a source: where it came from, and the sources passed over before it. */
export interface Synced {
  readonly served: ServedPackage; readonly origin: "replica" | "served"; readonly url: string; readonly skipped: readonly Skipped[];
}

/** A source of a backing's evidence: its URL as its client keeps it (`new URL(url).href`, which outputs, `except` and
 * the repair record name), and a sync into the party's evidence store, `full` from nothing. */
export interface Source {
  readonly url: string; readonly origin: "replica" | "served"; sync(full: boolean): Promise<ServedPackage>;
}

/**
 * `kept`'s sources, in the order asked (M12b): the operator's service (`service add`), then each replica of the terms'
 * operator as added, none in `except` (a replica's own). A reader with replicas need not keep the operator's service.
 * Each source keeps its own mark in the store (`V3ServiceClient.sync`), so one source's answer never tells another what
 * to leave out.
 */
export function sourcesOf(directory: Directory, kept: KeptTerms, view: View,
  sync: (client: V3ServiceClient, full: boolean) => Promise<ServedPackage>, except: readonly string[] = [], construction = directory.construction): Source[] {
  const identity = { operator: kept.terms.operator, reference: view.file.reference, construction };
  const added = replicaUrls(directory, kept.terms.operator).map(url => new URL(url).href), sources: Source[] = [];
  if (added.length === 0 || readOptional(directory.file(`services/${hex(kept.terms.operator)}.json`)) !== undefined) {
    const client = serviceClient(directory, kept, view, construction);
    if (!except.includes(client.baseUrl)) sources.push({ url: client.baseUrl, origin: "served", sync: full => sync(client, full) });
  }
  // A URL listed twice (the operator's own, or one href spelled twice) is one source. A replica's client is made when
  // it is asked: an onion replica's needs the holder's proxy, which stops only a read that reaches it.
  for (const url of new Set(added)) {
    if (except.includes(url) || sources.some(source => source.url === url)) continue;
    let client: V3ServiceClient | undefined;
    sources.push({ url, origin: "replica", sync: full => sync(client ??= new V3ServiceClient(url, undefined, identity), full) });
  }
  return sources;
}

export { unanswered };

/** Whether a read failed for evidence its store does not hold. */
const unresolvedEvidence = (error: unknown): boolean => error instanceof EvidenceRefusal && error.status === "unresolved-evidence";

/** The sources whose answer from nothing a read found still unresolved, each at the selection sequence it served then,
 * for one backing: `readSources` asks such a source from nothing again only once its selection moves. */
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
      // Best effort: a record not written costs one more answer from nothing, never the read's own result or refusal.
      try { writeReplace(file, `${JSON.stringify(records, null, 2)}\n`); } catch (error) {
        event({ event: "unresolved-record", code: "STORAGE", message: (error as Error).message });
      }
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
 * serves: `record` keeps the highest selection at which its answer from nothing stayed unresolved, and while it serves
 * that selection or a lower one it is asked only after its mark and, still unresolved, passed over at once. So a read that stays unresolved
 * (every source withholding, or the holder's own venue view or storage failing, which reads the same) costs one answer
 * from nothing per source and rising selection, not one per command or round. A read that no source can resolve refuses
 * with the sources passed over named, and with the remedy where a recorded selection never moves (a quiet or closed
 * backing) or the holder's own file was damaged since: removing the record. Any other refusal of the read over a
 * source's answer (a `ReplayRefusal`, or an `EvidenceRefusal` such as a lapsed selection) passes that source over at
 * once, as `REFUSED` or `UNRESOLVED`: a resolved read is verified, so a source can withhold but never forge, and its
 * refusal stands only where no other source resolves (audit 32).
 *
 * Each source is asked once, in order, and again from nothing only for that repair. A source that does not answer,
 * refuses or sends evidence that does not frame, assemble or fit the budget is passed over as `passedOver` names; the
 * holder's own proxy that is not there stops the read. Where no read resolves, the last read's refusal stands, with
 * every source passed over named; else the operator's own refusal stands; else (no source answered) `use` receives
 * `{ skipped }` (a wallet then reads its kept package). `use` otherwise receives the synced source, with every source
 * passed over before it named in `skipped`.
 */
export async function readSources<T>(sources: readonly Source[],
  use: (synced: Synced | { readonly skipped: readonly Skipped[] }) => Promise<T>, record: RepairRecord): Promise<T> {
  const skipped: Skipped[] = [];
  let repairing = false, refused: unknown, unresolved: EvidenceRefusal | ReplayRefusal | undefined;
  for (const { url, origin, sync } of sources) {
    // Once a read is unresolved, a source with no recorded selection is asked from nothing at once.
    let full = repairing && record.unresolvedAt(url) === undefined, served: ServedPackage;
    for (;;) {
      try { served = await sync(full); } catch (error) {
        const code = passedOver(error);
        if (code === undefined) throw error;
        // The operator's refusal stands where no other source answers; a replica's, or a source not answering, never does.
        if (origin === "served" && !unanswered(error)) refused = error;
        skipped.push({ url, code });
        break;
      }
      try {
        const result = await use({ served, origin, url, skipped: [...skipped] });
        record.record(url, undefined);
        return result;
      } catch (error) {
        if (!(error instanceof EvidenceRefusal || error instanceof ReplayRefusal)) throw error;
        unresolved = error;
        if (unresolvedEvidence(error)) {
          repairing = true;
          const at = record.unresolvedAt(url), moved = at === undefined || served.selection.sequence > at;
          if (!full && moved) { record.record(url, undefined); full = true; continue; }
          if (full && moved) record.record(url, served.selection.sequence);
        }
        skipped.push({ url, code: error instanceof ReplayRefusal ? "REFUSED" : "UNRESOLVED" });
        break;
      }
    }
  }
  if (unresolved !== undefined) {
    const final = unresolved instanceof ReplayRefusal ? new ReplayRefusal(unresolved.check)
      : Object.assign(new EvidenceRefusal(unresolved.status), unresolved.clock === undefined ? {} : { clock: unresolved.clock });
    final.message = `${unresolved instanceof ReplayRefusal ? unresolved.check : unresolved.status}: no source resolved the read (` +
      `${skipped.map(s => `${s.url} ${s.code}`).join(", ")})` +
      (unresolvedEvidence(unresolved) ? "; removing the directory's unresolved.json asks every source from nothing again" : "");
    throw final;
  }
  if (refused !== undefined) throw refused;
  return use({ skipped });
}

/** Read over the package `kept`'s sources supply into `evidence`, as `readSources` says; none answering is unavailable
 * evidence. `except` are URLs never asked (a replica's own). */
async function served<T>(directory: Directory, kept: KeptTerms, view: View, evidence: EvidenceStore, use: (synced: Synced) => Promise<T>,
  except: readonly string[] = []): Promise<T> {
  const sources = sourcesOf(directory, kept, view, (client, full) => client.sync(kept.backing, evidence, { full }), except, evidence.construction);
  return readSources(sources, async synced => {
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

/** The backing's frontier at `at` over `source`, read through the construction its evidence is kept under (the
 * directory's, or a succinct reading's) and the view's venue. */
async function readAt(kept: KeptTerms, view: View, at: bigint, source: Uint8Array, opened: {
  verifier: ProofVerifier | undefined; evidence: EvidenceStore; store: ReplayStore; answers: boolean }): Promise<FrontierResult & FaultResult> {
  const { verifier, ...rest } = opened;
  try {
    return await readFrontier(source, kept.signed, at, { construction: opened.evidence.construction, ...(verifier === undefined ? {} : { verifier }), venue: view.venue,
      reference: view.file.reference, ...rest });
  } catch (error) { throw inUse(error); }
}

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
    let evidence: EvidenceStore | undefined, store: ReplayStore | undefined, set: TrailCheckSet | undefined;
    try {
      // A succinct directory reads under the shipped check set, from the backing's sources (slice 38).
      set = directory.succinct ? await openCheckSet(directory) : undefined;
      const reading = set === undefined ? undefined : readingOf(directory, kept, view, set);
      evidence = openEvidence(directory, false, reading?.construction);
      const opened = { evidence, store: store = keptReplay(directory, at) };
      // A read is final at its judging index; where the view could not read further, the output says so.
      const stalled = synced.suppliers.filter(supplier => supplier.stopped !== undefined).map(supplier => ({ name: supplier.name, stopped: supplier.stopped }));
      const readOver = async (source: Uint8Array, origin: object) => {
        const read = await readAt(kept, view, at, source, { verifier, ...opened, answers });
        use(at, read, { tipHeight: synced.tipHeight, unresolvedIndex: synced.unresolvedIndex ?? null, stopped: stalled }, { ...origin, ...reading?.out() });
      };
      const file = flag(args, "package");
      if (file !== undefined) await readOver(readRequired(file, "package file", PACKAGE_FILE_LIMIT), { evidence: "file" });
      else await served(directory, kept, view, evidence, supplied => readOver(supplied.served.package, originOf(supplied)));
    } finally { store?.close(); evidence?.close(); await verifier?.close(); await set?.close(); }
  } finally { view.close(); }
}

/** The directory's evidence file, under its construction; `shared` for a replica's (M12b). A succinct reading's
 * proof-free evidence (`construction`) is kept in a file of its own, so neither form's file is read by the other. */
export function openEvidence(directory: Pick<Directory, "file" | "construction">, shared = false, construction?: Construction): EvidenceStore {
  const file = construction === undefined ? "evidence.db" : "succinct-evidence.db";
  try { return new EvidenceStore(directory.file(file), { construction: construction ?? directory.construction, shared }); } catch (error) {
    if (error instanceof TypeError && /another construction's evidence/.test(error.message)) {
      throw new CommandError("CONSTRUCTION", `${file} holds another construction's evidence than this directory's ${nameOf(directory.construction)}`);
    }
    // A file of another layout is refused, never read or replaced (Next 4 (m)).
    if (error instanceof TypeError && /another layout/.test(error.message)) throw new CommandError("STORAGE", `${file} has another layout than this release reads`);
    throw inUse(error);
  }
}

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
export function keptBackings(directory: Directory): Uint8Array[] {
  let names: string[];
  try { names = readdirSync(directory.file("terms")); } catch { return []; }
  return names.filter(name => /^[0-9a-f]{64}$/.test(name)).sort().map(name => hex32(name, "a kept backing"));
}

/** The sources a replica never asks (`sourcesOf`' `except`): its loopback listener by the URL a client keeps (`new
 * URL(url).href`, which drops a default port), and with `onion`, its onion name at any port a replica list names. */
export function ownSources(local: string, onion: string | undefined, listed: readonly string[]): string[] {
  const own = onion === undefined ? [local] : [local, `http://${onion}/`, ...listed.filter(url => new URL(url).hostname === onion)];
  return [...new Set(own.map(url => new URL(url).href))];
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
 *
 * With `--prove [--parameters <dir>]` (slice 38) it also proves check proofs over its kept pool-v3 trails after each
 * round (`V3Replica.prove`), for at most PROVE_ROUND_MS of new covers, and serves them by set and digest (`GET /covers`):
 * any party may prove (succinct-read §2 rule 6), and the replica checks each statement proof first. A line says what a
 * round proved. A succinct directory serves no replica (`SUCCINCT`): a replica's evidence is judged by every reader
 * that takes it, so it reads completely (succinct-read §1).
 */
async function serve(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", verifiers: "value", prove: "switch", parameters: "value", ...SERVE_FLAGS }, 0);
  const directory = openDirectory(required(args, "dir"), "reader"), venue = requireVenue(directory);
  if (directory.succinct) throw new CommandError("SUCCINCT", "a replica reads completely (succinct-read §1): serve from a reader directory made without --read succinct");
  if (has(args, "parameters") && !has(args, "prove")) throw new UsageError("--parameters names the check set's parameters for --prove");
  if (has(args, "prove") && !directory.construction.reader.proofs) throw new UsageError(`a ${nameOf(directory.construction)} replica holds no proofs to cover`);
  const { port, onion, ms } = serveFlags(args);
  const view = openView(directory);
  let evidence: EvidenceStore | undefined, verifier: Awaited<ReturnType<typeof directoryVerifier>> | undefined;
  let covers: Awaited<ReturnType<typeof openCoverProver>> | undefined;
  try {
    verifier = await directoryVerifier(directory, args);
    evidence = openEvidence(directory, true);
    if (has(args, "prove")) covers = await openCoverProver(directory, verifier!, flag(args, "parameters"), line => process.stderr.write(`${line}\n`));
  } catch (error) { await covers?.close(); await verifier?.close(); evidence?.close(); view.close(); throw error; }
  const replica = new V3Replica(directory.file("evidence.db"), evidence, view.venue.id);
  const server = createV3EvidenceService(replica);
  // A stream its file could not finish (storage damage) ended short; the replica's owner is told.
  server.on("evidenceError", (error: unknown) => { event({ event: "evidence", code: "STORAGE", message: (error as Error).message }); });
  let listened: number;
  try { listened = await listenLoopback(server, port); } catch (error) { await covers?.close(); await verifier?.close(); evidence.close(); view.close(); throw error; }
  const local = `http://127.0.0.1:${listened}/`, url = onion === undefined ? local : `http://${onion}/`;
  writeReplace(directory.file("replica.json"), `${JSON.stringify({ url }, null, 2)}\n`);
  const { stopping, pause: rest } = untilStopped();
  print({ status: "serving", url, port: listened, backings: keptBackings(directory).map(hex),
    served: keptBackings(directory).map(backing => ({ backing, sequence: replica.selection(backing)?.selection.sequence ?? null })) });
  const round = async (): Promise<void> => {
    const synced = await view.syncWitnessed(), at = synced.witnessedIndex;
    for (const backing of keptBackings(directory)) {
      if (stopping()) return;
      try {
        const kept = keptTerms(directory, backing, venue), before = replica.selection(backing)?.selection.sequence;
        await served(directory, kept, view, evidence!, async supplied => {
          const store = keptReplay(directory, at);
          let read;
          try { read = await readAt(kept, view, at, supplied.served.package, { verifier, evidence: evidence!, store, answers: false }); }
          finally { store.close(); }
          // Served only where its own read found the selection canonical: it holds what a read of it needs.
          const canonical = read.canonical?.commitment, selected = supplied.served.selection;
          const final = canonical !== undefined && canonical.sequence === selected.sequence && compareBytes(canonical.operator, selected.operator) === 0 &&
            compareBytes(canonical.root, selected.root) === 0 && replica.keep(supplied.served);
          const now = replica.selection(backing)?.selection.sequence;
          if (now !== before || !final) {
            print({ ...supplyOf(kept, at, read, { tipHeight: synced.tipHeight, unresolvedIndex: synced.unresolvedIndex ?? null }, originOf(supplied), directory),
              served: now ?? null });
          }
        }, ownSources(local, onion, replicaUrls(directory, kept.terms.operator)));
      } catch (error) {
        const code = roundRefusal(error);
        if (code === undefined) throw error;
        event({ event: "refused", backing, code, message: (error as Error).message });
      }
    }
  };
  /** A round's proving: new covers over the kept trails (held ones are not proved again) until PROVE_ROUND_MS has
   * passed or the replica stops; the nodes over two covered spans follow their leaves. */
  const prove = async (): Promise<void> => {
    if (covers === undefined || stopping()) return;
    const { prover } = covers, until = Date.now() + PROVE_ROUND_MS;
    const bounded: SpanProver = { identity: prover.identity, node: (left, right) => prover.node(left, right),
      leaf: async record => Date.now() < until && !stopping() ? prover.leaf(record) : undefined };
    try {
      const walked = await replica.prove(bounded);
      if (walked.made > 0) print({ status: "proved", set: prover.identity, testSet: prover.set.test, ...walked });
    } catch (error) {
      // A refusal inside the backend leaves its instance unusable (slice 36): this process proves no more.
      event({ event: "prove", code: "PROVER", message: (error as Error).message });
      const failed = covers; covers = undefined; await failed.close();
    }
  };
  try {
    while (!stopping()) {
      await round();
      await prove();
      await rest(ms);
    }
  } finally {
    await closeListener(server);
    await covers?.close(); await verifier?.close(); evidence.close(); view.close();
  }
  print({ status: "stopped" });
}

export async function reader(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": return initRole(rest, "reader", { venue: "required", construction: true, read: true });
    case "terms": return termsCommand(rest, "reader");
    case "service": return serviceCommand(rest, "reader");
    case "supply": return supplyCommand(rest, "reader");
    case "presentation": return presentationCommand(rest, "reader");
    case "replica": return replicaCommand(rest, "reader");
    case "serve": return serve(rest);
    default: throw new UsageError("moe reader init|terms|service|replica|supply|presentation|serve");
  }
}
