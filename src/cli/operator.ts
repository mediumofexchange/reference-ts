// `moe operator` (slice 10 M10b, items 3, 6 and 7): the operator's journal
// (`journal.db`) over its own Ergo view, its key (`operator.key`), its
// service credentials (`admin.token`, never handed out, and `wallet.token`,
// service-wide) and its funding key (`funding.key`), whose publisher keeps
// its pending transactions in the journal and spends within the directory's
// budget. `serve` owns the journal while it runs; `open`, `return` and
// `adopt` run while it is stopped, which the directory lock enforces, and
// publish what they sign before exiting. A journal reopened over signed state
// signs again only once the venue passes its reopening index plus the lag
// (C2.8.2), so `return` and `adopt` sync their view until the journal takes
// them. An operator directory is never restored from a copy: its recovery is
// succession. The journal serves the construction the directory declares at
// init (M14g4); a lit operator keeps no parameters and opens no verifier.
import { readdirSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes } from "../bytes.js";
import type { Commitment } from "../venue-records.js";
import { createV3Service } from "../pool/v3/service-http.js";
import { V3OperatorJournal, V3StoreError } from "../pool/v3/store.js";
import type { ProofVerifier } from "../pool/proof-verifier.js";
import { CommandError, event, flag, has, hex, hex32, integer, openDirectory, parseArguments, pause, pollMs, print, readRequired, readSecret, required, UsageError,
  writeExclusive, writeReplace, type Arguments, type Directory } from "./common.js";
import { directoryVerifier } from "./backend.js";
import { initRole } from "./reader.js";
import { authenticate, keepTerms, keptTerms } from "./terms.js";
import { createVenue, fresh, freshFunding, fundingTree, openPublisher, openView, requireVenue, venueText, type SpendBudget, type View } from "./venue.js";

const commitmentOf = (c: Commitment) => ({ operator: c.operator, sequence: c.sequence, root: c.root });
const readToken = (directory: Directory, name: string): string => {
  const text = new TextDecoder().decode(readRequired(directory.file(name), name)).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new CommandError("INVALID", `${name} is not 64 hex digits`);
  return text;
};

/** The operator's journal over its synced view, with its publisher attached under the journal's outbox. */
interface Operator {
  readonly directory: Directory;
  readonly view: View;
  readonly journal: V3OperatorJournal;
  readonly budget: SpendBudget;
  readonly operator: Uint8Array;
  close(): Promise<void>;
}
async function openOperator(directory: Directory, args: Arguments): Promise<Operator> {
  const view = openView(directory);
  let verifier: ProofVerifier | undefined, journal: V3OperatorJournal | undefined, budget: SpendBudget | undefined;
  try {
    // The journal reads the venue's clock as it opens: the view is brought up to date first.
    await view.syncWitnessed();
    verifier = await directoryVerifier(directory, args);
    const secret = readSecret(directory.file("operator.key"), "operator.key");
    try {
      journal = new V3OperatorJournal(directory.file("journal.db"), { secret, venue: view.venue, reference: view.file.reference, verifier,
        construction: directory.construction });
    } finally { secret.fill(0); }
    const opened = openPublisher(directory, journal.publisherPersistence());
    budget = opened.budget;
    view.venue.attachPublisher(opened.publisher);
    const own = journal, ownVerifier = verifier, ownBudget = budget;
    return { directory, view, journal: own, budget: ownBudget, operator: own.operatorKey,
      async close() { own.close(); ownBudget.close(); await ownVerifier?.close(); view.close(); } };
  } catch (error) {
    journal?.close(); budget?.close(); await verifier?.close(); view.close(); throw error;
  }
}

/** `act` on the operator's journal; where it failed after the spend budget refused a broadcast, the budget's
 * refusal (`BUDGET`) is what the command reports. */
async function budgeted<T>(op: Operator, act: () => Promise<T>): Promise<T> {
  op.budget.take();
  try { return await act(); } catch (error) {
    const refused = op.budget.take();
    throw refused !== undefined && error instanceof V3StoreError && error.code === "UNAVAILABLE" ? refused : error;
  }
}

const POLL = { dir: "value", verifiers: "value", "poll-ms": "value" } as const;

/** Sync and try `act` until the journal takes it, while it refuses with one of `waiting` codes; at most
 * `indices` witnessed indices past where it started. */
async function untilTaken<T>(op: Operator, args: Arguments, indices: bigint, waiting: readonly string[], act: () => Promise<T>): Promise<T> {
  const start = op.view.venue.witnessedIndex(), ms = pollMs(args);
  for (;;) {
    try { return await act(); } catch (error) {
      if (!(error instanceof V3StoreError) || !waiting.includes(error.code) || op.view.venue.witnessedIndex() > start + indices) throw error;
      event({ event: "waiting", code: error.code, message: error.message, witnessedIndex: op.view.venue.witnessedIndex() });
    }
    await pause(ms);
    await op.view.sync();
  }
}

async function init(argv: readonly string[]): Promise<void> {
  return initRole(argv, "operator", { venue: "optional", budget: true, construction: true, fill: async directory => {
    const secret = fresh(), funding = freshFunding();
    writeExclusive(directory.file("operator.key"), secret);
    writeExclusive(directory.file("funding.key"), funding);
    writeExclusive(directory.file("admin.token"), `${bytesToHex(fresh())}\n`);
    writeExclusive(directory.file("wallet.token"), `${bytesToHex(fresh())}\n`);
    const shown = { operator: ed25519.getPublicKey(secret), fundingTree: fundingTree(funding) };
    secret.fill(0); funding.fill(0);
    return shown;
  } });
}

async function venue(argv: readonly string[]): Promise<void> {
  const [verb, ...rest] = argv;
  if (verb !== "create") throw new UsageError("moe operator venue create");
  const args = parseArguments(rest, { dir: "value", synthetic: "switch", depth: "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "operator"), depth = flag(args, "depth");
  const { venue: file, created } = await createVenue(directory, { synthetic: has(args, "synthetic"),
    ...(depth === undefined ? {} : { depth: integer(depth, "--depth", 1n, 1000n) }) });
  print({ status: created ? "created" : "existing", venue: file.id, file: JSON.parse(venueText(file.profile, file.anchorHeight)) });
}

/** `open --id <id> <backing> --terms <file> --signature <file>`: sign the genesis segment under the terms and publish it. */
async function open(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { ...POLL, id: "value", terms: "value", signature: "value", synthetic: "switch" }, 1);
  const directory = openDirectory(required(args, "dir"), "operator"), file = requireVenue(directory), id = required(args, "id");
  const kept = authenticate(readRequired(required(args, "terms"), "terms file"), readRequired(required(args, "signature"), "signature file"),
    hex32(args.positional[0]!, "the backing"), file, has(args, "synthetic"), directory.construction);
  const secret = readSecret(directory.file("operator.key"), "operator.key"), own = ed25519.getPublicKey(secret);
  secret.fill(0);
  if (compareBytes(kept.terms.operator, own) !== 0) throw new CommandError("OPERATOR", "the terms name another operator than this directory's key");
  keepTerms(directory, kept);
  const op = await openOperator(directory, args);
  try {
    const signed = await op.journal.open(id, kept.signed), published = await budgeted(op, () => op.journal.publish());
    print({ status: "pending", backing: kept.backing, commitment: commitmentOf(signed), published: commitmentOf(published) });
  } finally { await op.close(); }
}

/** The kept terms of the backings this operator serves: their silence durations bound how long `serve` waits. */
function servedSilence(directory: Directory, operator: Uint8Array): bigint | undefined {
  const file = requireVenue(directory);
  let least: bigint | undefined;
  let names: string[] = [];
  try { names = readdirSync(directory.file("terms")); } catch { /* no terms yet */ }
  for (const name of names.filter(n => /^[0-9a-f]{64}$/.test(n))) {
    const kept = keptTerms(directory, hex32(name, "a kept backing"), file);
    if (compareBytes(kept.terms.operator, operator) !== 0) continue;
    const duration = kept.terms.silence?.noCommitmentDuration;
    if (duration !== undefined && (least === undefined || duration < least)) least = duration;
  }
  return least;
}

/** One at a time: the view's sync, the schedule's own journal calls and the service's. */
function serialized() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}

/** Whether serve commits to keep the held checkpoint alive: at half the window the journal commits in after the venue
 * witnessed it. The journal commits only while its horizon (now + lag) stays within the least silence duration of
 * the served terms from that checkpoint (`serviceClock`), so the window is the duration less the lag. */
export function keepAliveDue(now: bigint, heldIndex: bigint | undefined, silence: bigint | undefined, lag: bigint): boolean {
  return silence !== undefined && heldIndex !== undefined && now >= heldIndex + (silence - lag) / 2n;
}

/** Whether a failed poll leaves serve polling: a journal refusal other than its storage, fence or conflict, a
 * refused budget, or a transaction the node's index cannot replay yet (M10c1 item 6). */
export function servePollsOn(error: unknown): error is CommandError | V3StoreError {
  if (error instanceof CommandError) return error.code === "BUDGET" || error.code === "UNREPLAYED";
  return error instanceof V3StoreError && !["STORAGE", "FENCED", "CONFLICT"].includes(error.code);
}

/**
 * `serve --interval <n> [--port <p>]`: run the loopback service and, on each poll, sync the view and act on the
 * witnessed index (M10b item 7): publish the latest signed commitment while the venue does not hold it; with it
 * held and no return pending, commit (command id `serve:<index>`) and publish when statements were admitted since
 * it and `interval` indices have passed since it was signed, or, at the latest, half the window the journal commits
 * in after the venue witnessed it: the least silence duration of the served terms less the lag. At most one
 * commitment is in flight. Writes `service.json` (the URL and the service-wide wallet token, to hand to holders)
 * and prints one line once listening and one once stopped; a refused budget or a transaction the node's index cannot
 * replay yet is logged and tried again on the next poll. Stops on SIGTERM or SIGINT.
 */
async function serve(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { ...POLL, interval: "value", port: "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "operator");
  const interval = integer(required(args, "interval"), "--interval", 1n, 1n << 32n);
  const port = Number(integer(flag(args, "port") ?? "0", "--port", 0n, 65535n)), ms = pollMs(args);
  const op = await openOperator(directory, args), journal = op.journal;
  const silence = servedSilence(directory, op.operator), lag = op.view.venue.lag(), queue = serialized();
  // The service's journal commands take their turn with the schedule's, so neither meets the other's BUSY or a
  // view that moved under it. Serving evidence takes no journal turn and reads the view's settled snapshot, so a
  // holder's sync neither waits for the schedule nor holds it up.
  const queued = new Proxy(journal, { get(target, property) {
    const value: unknown = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    if (property === "serve") return (value as (...a: unknown[]) => unknown).bind(target);
    return (...parameters: unknown[]) => queue(async () => (value as (...a: unknown[]) => unknown).apply(target, parameters));
  } });
  const walletToken = readToken(directory, "wallet.token");
  const server: Server = createV3Service(queued, { walletToken, adminToken: readToken(directory, "admin.token") });
  try {
    await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", () => done()); });
  } catch (error) {
    await op.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new CommandError("UNAVAILABLE", `port ${port} is in use`);
    throw error;
  }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  writeReplace(directory.file("service.json"), `${JSON.stringify({ url, walletToken }, null, 2)}\n`);
  let stopping = false, pendingNoted = false, wake: (() => void) | undefined;
  const stop = () => { stopping = true; wake?.(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  print({ status: "serving", url, operator: op.operator, interval, silence: silence ?? null });
  const tick = async (): Promise<void> => {
    const synced = await op.view.sync(), stalled = synced.suppliers.filter(supplier => supplier.stopped !== undefined);
    if (synced.unresolvedIndex !== undefined || stalled.length > 0) {
      event({ event: "sync", witnessedIndex: synced.witnessedIndex, unresolvedIndex: synced.unresolvedIndex, reason: synced.unresolvedReason,
        stopped: stalled.map(supplier => ({ name: supplier.name, stopped: supplier.stopped })) });
    }
    const s = await journal.status(), signed = s.signed;
    if (signed === undefined) return;
    // The latest signed commitment, a pending return's opening included, is published until the venue holds it.
    if (!signed.held) {
      const published = await budgeted(op, () => journal.publish());
      if (!signed.published) event({ event: "published", at: s.now, commitment: commitmentOf(published) });
      return;
    }
    if (s.pendingReturn) {
      if (!pendingNoted) event({ event: "return held", message: "stop serve and run moe operator adopt" });
      pendingNoted = true;
      return;
    }
    const admitted = signed.admitted > 0n && s.now >= signed.at + interval;
    const keepAlive = keepAliveDue(s.now, s.heldIndex, silence, lag);
    if (!admitted && !keepAlive) return;
    const commitment = await journal.commit(`serve:${s.now}`);
    event({ event: "committed", at: s.now, admitted: signed.admitted, commitment: commitmentOf(commitment) });
    await budgeted(op, () => journal.publish());
    event({ event: "published", at: s.now, commitment: commitmentOf(commitment) });
  };
  try {
    while (!stopping) {
      try { await queue(tick); } catch (error) {
        if (!servePollsOn(error)) throw error;
        event({ event: "refused", code: error.code, message: error.message });
      }
      if (!stopping) await new Promise<void>(done => { wake = done; setTimeout(done, ms); });
    }
  } finally {
    await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
    await queue(async () => {});
    await op.close();
  }
  print({ status: "stopped" });
}

/** `return --id <id>`: after witnessed silence, sign the empty successor (C2b.4.1) once the journal takes it, and
 * publish it. */
async function returnCommand(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { ...POLL, id: "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "operator"), id = required(args, "id");
  const op = await openOperator(directory, args);
  try {
    const signed = await untilTaken(op, args, 4n * op.view.venue.lag(), ["SCHEDULE"], () => op.journal.return(id));
    const published = await budgeted(op, () => op.journal.publish());
    print({ status: "pending", commitment: commitmentOf(signed), published: commitmentOf(published) });
  } finally { await op.close(); }
}

/** `adopt`: once the return opening is witnessed, co-sign the gap's block (C2b.4.2); keyed by the opening's sequence. */
async function adopt(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, POLL, 0);
  const directory = openDirectory(required(args, "dir"), "operator");
  const op = await openOperator(directory, args);
  try {
    const receipts = await untilTaken(op, args, 4n * op.view.venue.lag(), ["SCHEDULE", "UNAVAILABLE"], () => op.journal.adopt());
    print({ status: "final", receipts: receipts.map(hex) });
  } finally { await op.close(); }
}

export async function operator(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": return init(rest);
    case "venue": return venue(rest);
    case "open": return open(rest);
    case "serve": return serve(rest);
    case "return": return returnCommand(rest);
    case "adopt": return adopt(rest);
    default: throw new UsageError("moe operator init|venue|open|serve|return|adopt");
  }
}
