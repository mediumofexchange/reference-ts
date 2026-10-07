// `moe relay` (slice 10 M10b, item 8): publishes a holder's or backer's
// publication file at the venue from a funding key kept apart from any wallet.
// It verifies nothing, so it keeps no proving parameters.
// `relay publish <file>` refuses a venue other than its own `venue.json`'s,
// decodes the publication and requires its backing to be the subject, refuses
// a demand whose instant its view has not reached, then publishes with its
// funding key (`funding.key`) within the directory's spend budget, keeping its
// publisher's pending transactions in `relay.db`. It prints the transaction its
// publisher built last for the record (where an earlier one of the record's
// lands instead, that one carries it). A rerun is keyed by the record: once
// the view witnesses it, the rerun prints that index. A relay serves either
// construction (M14g4): it reads the publication under the one whose frame it
// decodes in and requires the configuration it names to be that one's.
//
// `relay serve` (slice 12 M12c) runs the same judgement for files handed to it
// on a loopback listener, behind a Tor onion service, under the relay's one
// credential (`relay.token`, never per holder); `relay send <file> --to
// <relay.json>` hands a file to it through the holder's own proxy, so a holder's
// gap act is funded by a third party's key, never the holder's coins. A relay of
// the holder's own links its gap acts to each other and to its funding; a third
// party's relay sees each act a little before the public and may delay or withhold
// it (docs/POOL_V3_VISIBILITY.md).
import type { AddressInfo } from "node:net";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../bytes.js";
import { createRelayService, type RelayRefusal } from "../pool/v3/service-http.js";
import { sendToRelay, V3ServiceClientError } from "../pool/v3/service-client.js";
import type { ErgoPublisher } from "../ergo-publisher.js";
import { VenueError } from "../venue-error.js";
import { CommandError, event, flag, integer, openDirectory, parseArguments, pause, pollMs, print, readJson, readOptional, required, UsageError,
  writeExclusive, writeReplace, type Directory } from "./common.js";
import { constructions } from "./construction.js";
import { initRole, unanswered } from "./reader.js";
import { fresh, freshFunding, fundingTree, openPublisher, openView, publisherStore, requireVenue, type SpendBudget, type View } from "./venue.js";

async function init(argv: readonly string[]): Promise<void> {
  return initRole(argv, "relay", { venue: "required", budget: true, verifies: false, fill: async directory => {
    const funding = freshFunding();
    writeExclusive(directory.file("funding.key"), funding);
    const shown = { fundingTree: fundingTree(funding) };
    funding.fill(0);
    return shown;
  } });
}

/** A publication file as a wallet's `publish` or `publish-acceptance` writes it. */
interface PublicationFile { readonly venue: Uint8Array; readonly backing: Uint8Array; readonly kind: 4; readonly subject: Uint8Array; readonly record: Uint8Array }
export function parsePublicationFile(value: unknown): PublicationFile {
  const invalid = (): never => { throw new CommandError("INVALID", "the file is not a moe publication file"); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as { [key: string]: unknown };
  if (Object.keys(v).sort().join() !== "backing,kind,record,schema,subject,venue" || v.schema !== "moe-publication-1") invalid();
  const bytes = (x: unknown, length?: number): Uint8Array => typeof x === "string" && /^(?:[0-9a-f]{2})+$/.test(x) &&
    (length === undefined || x.length === 2 * length) ? hexToBytes(x) : invalid();
  // A wallet publishes only at kind 4, the backing's publications (pool-v3 §13).
  if (v.kind !== "4") throw new CommandError("INVALID", "a relay publishes only a backing's publications (kind 4)");
  return { venue: bytes(v.venue, 32), backing: bytes(v.backing, 32), kind: 4, subject: bytes(v.subject, 32), record: bytes(v.record) };
}

/** The record as a publication of the construction whose frame it decodes in, with a demand's instant. */
export function readPublication(record: Uint8Array): { readonly backing: Uint8Array; readonly instant: bigint | undefined } {
  for (const construction of constructions()) {
    let view;
    try { view = construction.reader.publication(record); } catch (error) {
      if (error instanceof EncodingError) continue;
      throw error;
    }
    if (compareBytes(view.domain, construction.reader.domain()) !== 0) throw new CommandError("CONFIGURATION", "the publication names another configuration");
    // A demand's instant is the index its holder read at (kind 1 carries a demand record).
    const instant = view.kind === 1 ? construction.view(construction.decode(view.record!), () => undefined).demand?.value.instant : undefined;
    return { backing: view.backing, instant };
  }
  throw new CommandError("INVALID", "the record is not a publication of either construction");
}

/** A file's record as this relay judges it before any view or key opens: its venue, its frame and its backing as subject. */
function judged(value: unknown, venue: Uint8Array): { readonly file: PublicationFile; readonly instant: bigint | undefined } {
  const file = parsePublicationFile(value);
  if (compareBytes(file.venue, venue) !== 0) throw new CommandError("VENUE", "the publication names another venue than this relay's venue.json");
  const publication = readPublication(file.record);
  if (compareBytes(publication.backing, file.backing) !== 0 || compareBytes(file.subject, file.backing) !== 0) {
    throw new CommandError("SUBJECT", "the publication's backing is not the subject it is filed under");
  }
  return { file, instant: publication.instant };
}

/** What a relay answers for a file: final where its view witnesses the record, else pending on the transaction its
 * publisher built last for the record. */
type Relayed = { readonly status: "final"; readonly record: string; readonly index: string } |
  { readonly status: "pending"; readonly record: string; readonly transaction: string | null; readonly witnessedIndex: string };

/** Publish a judged file over a synced view: final where the view witnesses it, refused `EARLY` for a demand whose
 * instant the view has not reached (it would be published early), else published within the spend budget. */
async function relayed(judgement: ReturnType<typeof judged>, view: View, budget: SpendBudget): Promise<Relayed> {
  const { file, instant } = judgement, record = bytesToHex(sha256(file.record));
  const held = view.venue.witnessedAt(4, file.subject, file.record);
  if (held !== undefined) return { status: "final", record, index: String(held) };
  // A demand's instant is the index its holder read at; one the view has not reached would be published early.
  if (instant !== undefined && view.venue.witnessedIndex() < instant) {
    throw new CommandError("EARLY", "the demand's instant is past this relay's witnessed index; sync its nodes and publish again");
  }
  let sent;
  budget.take();
  try { sent = await view.venue.publish(4, file.subject, file.record); } catch (error) { throw budget.take() ?? error; }
  return { status: "pending", record, transaction: sent === undefined ? null : bytesToHex(sent.id), witnessedIndex: String(view.venue.witnessedIndex()) };
}

/** The relay's view with its publisher attached under `relay.db`, and the spend budget, for `work`. */
async function withPublisher<T>(directory: Directory, work: (view: View, budget: SpendBudget, publisher: ErgoPublisher) => Promise<T>): Promise<T> {
  const view = openView(directory), store = publisherStore(directory.file("relay.db"));
  try {
    const { publisher, budget } = openPublisher(directory, store.persistence);
    try {
      // Attached before any sync, so a sync settles what the publisher kept pending.
      view.venue.attachPublisher(publisher);
      return await work(view, budget, publisher);
    } finally { budget.close(); }
  } finally { view.close(); store.close(); }
}

/** `publish <file> [--wait <indices>]`: publish the file's record; with `--wait`, sync until the view witnesses it,
 * at most that many witnessed indices past the publication. */
async function publish(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", wait: "value", "poll-ms": "value" }, 1);
  const directory = openDirectory(required(args, "dir"), "relay"), venue = requireVenue(directory);
  const judgement = judged(readJson(args.positional[0]!, "the publication file"), venue.id), file = judgement.file;
  const wait = flag(args, "wait") === undefined ? undefined : integer(flag(args, "wait")!, "--wait", 1n, 1000n);
  await withPublisher(directory, async (view, budget) => {
    await view.syncWitnessed();
    const answer = await relayed(judgement, view, budget);
    if (wait === undefined || answer.status === "final") { print(answer); return; }
    const start = view.venue.witnessedIndex(), ms = pollMs(args);
    // Bounded by indices and by polls, so stalled nodes do not hold the directory without end.
    for (let polls = 0; ; polls++) {
      const index = view.venue.witnessedAt(4, file.subject, file.record);
      if (index !== undefined) { print({ status: "final", record: answer.record, index: String(index), transaction: answer.transaction }); return; }
      if (view.venue.witnessedIndex() > start + wait || polls >= 120 * Number(wait)) {
        throw new CommandError("UNWITNESSED", `the view has not witnessed the record within ${wait} indices; rerun to publish again`);
      }
      event({ event: "waiting", witnessedIndex: view.venue.witnessedIndex() });
      await pause(ms);
      await view.sync();
    }
  });
}

/** A refusal's status and code on the relay's listener: the file's own (400), one a later send may pass (409), and the
 * relay's view or nodes not ready (503). */
function relayRefusal(error: unknown): RelayRefusal | undefined {
  if (error instanceof CommandError) {
    return { status: ["INVALID", "VENUE", "SUBJECT", "CONFIGURATION"].includes(error.code) ? 400 : ["EARLY", "BUDGET", "UNREPLAYED", "BUSY"].includes(error.code) ? 409 : 503,
      code: error.code };
  }
  // The best chain shorter than the clock's depth: the publisher builds nothing yet.
  if (error instanceof VenueError) return { status: 503, code: "UNAVAILABLE" };
  return undefined;
}

/** The relay's one credential, made at its first `serve` and kept across runs. */
function relayToken(directory: Directory): string {
  const path = directory.file("relay.token");
  if (readOptional(path) === undefined) writeExclusive(path, `${bytesToHex(fresh())}\n`);
  const text = new TextDecoder().decode(readOptional(path)!).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new CommandError("INVALID", "relay.token is not 64 hex digits");
  return text;
}

/**
 * `serve [--port <p>] [--onion <host>] [--poll-ms <ms>]` (slice 12 M12c): serve this relay to holders. A loop syncs the
 * view each poll, settling what the publisher kept pending; it listens once a first sync has passed. `POST /publications`
 * takes a publication file and answers as `publish` prints, judged over the view as last synced (a demand whose instant
 * that view has not reached is `EARLY` until a later poll). The loop and the requests take one turn at a time; one
 * request waits at most, others are refused `BUSY`, and a request whose connection is gone by its turn is dropped
 * unjudged. A resend of a file answers the same transaction until its record is witnessed, then `final`. A publisher
 * whose persistence failed ends `serve` with `STORAGE`. Writes `relay.json` (the URL, the
 * v3 onion name Tor serves for this port with `--onion`, and the relay's one credential, to hand to holders) and prints
 * one line once listening and one once stopped; a sync's or a request's unexpected failure is an event on stderr.
 * Stops on SIGTERM or SIGINT.
 */
async function serve(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", port: "value", onion: "value", "poll-ms": "value" }, 0);
  const directory = openDirectory(required(args, "dir"), "relay"), venue = requireVenue(directory);
  const port = Number(integer(flag(args, "port") ?? "0", "--port", 0n, 65535n)), ms = pollMs(args), onion = flag(args, "onion");
  if (onion !== undefined && !/^[a-z2-7]{55}d\.onion$/.test(onion)) throw new UsageError("--onion takes a v3 onion host: 56 base32 characters and .onion");
  const token = relayToken(directory);
  let stopping = false, wake: (() => void) | undefined;
  const stop = () => { stopping = true; wake?.(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const pause = () => stopping ? Promise.resolve() : new Promise<void>(done => { wake = done; setTimeout(done, ms); });
  await withPublisher(directory, async (view, budget, publisher) => {
    let tail: Promise<unknown> = Promise.resolve(), waiting = 0;
    const turn = <T>(work: () => Promise<T>): Promise<T> => { const run = tail.then(work, work); tail = run.catch(() => {}); return run; };
    const synced = async (): Promise<boolean> => {
      try { await turn(() => view.syncWitnessed()); return true; } catch (error) {
        if (!(error instanceof VenueError) && !unanswered(error)) throw error;
        event({ event: "sync", code: "UNAVAILABLE", message: (error as Error).message });
        return false;
      }
    };
    // Requests are judged over a synced view only.
    while (!stopping && !await synced()) await pause();
    if (stopping) return;
    const take = async (value: unknown, gone: () => boolean): Promise<Relayed> => {
      // One request runs and one waits: a sync that takes minutes holds no queue of files to spend on later.
      if (waiting >= 2) throw new CommandError("BUSY", "the relay is busy; send the file again");
      waiting++;
      try {
        return await turn(async () => {
          if (gone()) throw new CommandError("GONE", "the request's connection closed before its turn");
          return relayed(judged(value, venue.id), view, budget);
        });
      } finally {
        waiting--;
        if (publisher.failed) stop();
      }
    };
    const server = createRelayService(token, take, relayRefusal);
    server.on("relayError", (error: unknown) => { event({ event: "relay", code: "UNAVAILABLE", message: (error as Error).message }); });
    try {
      await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", () => { server.off("error", failed); done(); }); });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new CommandError("UNAVAILABLE", `port ${port} is in use`);
      throw error;
    }
    const at = (server.address() as AddressInfo).port, url = onion === undefined ? `http://127.0.0.1:${at}/` : `http://${onion}/`;
    writeReplace(directory.file("relay.json"), `${JSON.stringify({ url, token }, null, 2)}\n`);
    print({ status: "serving", url, port: at, fundingTree: budget.tree, spent: budget.spent() });
    try {
      while (!stopping) {
        await synced();
        if (publisher.failed) break;
        await pause();
      }
    } finally {
      await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
      await tail;
    }
    if (publisher.failed) throw new CommandError("STORAGE", "the relay's publisher state failed to persist; restart serve from its durable state");
  });
  print({ status: "stopped" });
}

/** A relay file: the relay's URL (loopback, or its v3 onion name) and its one credential. */
function parseRelayFile(value: unknown): { readonly url: string; readonly token: string } {
  const v = value as { url?: unknown; token?: unknown };
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "token,url" || typeof v.url !== "string" ||
      !/^http:\/\/(127\.0\.0\.1:[0-9]{1,5}|[a-z2-7]{55}d\.onion(:[0-9]{1,5})?)\/$/.test(v.url) || typeof v.token !== "string" || !/^[0-9a-f]{64}$/.test(v.token)) {
    throw new CommandError("INVALID", "the relay file is not { url, token } with a loopback or v3 onion URL");
  }
  return { url: v.url, token: v.token };
}

/** The relay's answer, checked to name the file's record. */
function relayAnswer(value: unknown, record: string): Relayed {
  const v = value as Record<string, unknown>, decimal = (x: unknown) => typeof x === "string" && /^(0|[1-9][0-9]{0,19})$/.test(x);
  const keys = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join() : "";
  if (v?.record === record && ((keys === "index,record,status" && v.status === "final" && decimal(v.index)) ||
      (keys === "record,status,transaction,witnessedIndex" && v.status === "pending" && decimal(v.witnessedIndex) &&
        (v.transaction === null || (typeof v.transaction === "string" && /^[0-9a-f]{64}$/.test(v.transaction)))))) return value as Relayed;
  throw new CommandError("INVALID", "the relay's answer is not a relay reply for this file's record");
}

/**
 * `send <file> --to <relay.json>` (slice 12 M12c): hand a publication file to a relay's `serve`, through the holder's
 * own loopback proxy where its URL is an onion's (refused `PROXY` before any connection otherwise), and print its answer.
 * It opens no directory. A relay that does not answer is `UNAVAILABLE`; an exact resend is safe and answers the same.
 * The answer is the relay's word: the holder reads the act at the venue by its own read.
 */
async function send(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { to: "value" }, 1);
  const relay = parseRelayFile(readJson(required(args, "to"), "the relay file"));
  const value = readJson(args.positional[0]!, "the publication file"), file = parsePublicationFile(value);
  readPublication(file.record);
  let answer;
  try { answer = await sendToRelay(relay.url, relay.token, value); } catch (error) {
    if (unanswered(error)) throw new CommandError("UNAVAILABLE", "the relay did not answer; send the file again");
    if (error instanceof V3ServiceClientError && error.status !== 0) throw new CommandError(error.code, `the relay refused the publication (${error.status})`, String(error.status));
    throw error;
  }
  print({ ...relayAnswer(answer, bytesToHex(sha256(file.record))), relay: relay.url });
}

export async function relay(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": return init(rest);
    case "publish": return publish(rest);
    case "serve": return serve(rest);
    case "send": return send(rest);
    default: throw new UsageError("moe relay init|publish|serve|send");
  }
}
