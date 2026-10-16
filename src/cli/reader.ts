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
// evidence and serves it, with no credential, through the one wire. What the
// reading roles share is in read.ts.
import { compareBytes } from "../bytes.js";
import type { EvidenceStore } from "../pool/v3/evidence-store.js";
import { V3Replica } from "../pool/v3/replica.js";
import { V3ServiceClientError } from "../pool/v3/service-client.js";
import { createV3EvidenceService } from "../pool/v3/service-http.js";
import { CommandError, event, flag, has, hex, openDirectory, parseArguments, print, required, UsageError, writeReplace } from "./common.js";
import { directoryVerifier, openCoverProver, proverBackend, type ExhaustionProver } from "./backend.js";
import { openExhaustionProver } from "./exhaustion-prover.js";
import { nameOf } from "./construction.js";
import { initRole, keptBackings, keptReplay, openEvidence, originOf, passedOver, presentationCommand, readAt, replicaCommand, replicaUrls, served,
  serviceCommand, supplyCommand, supplyOf, termsCommand } from "./read.js";
import { closeListener, listenLoopback, SERVE_FLAGS, serveFlags, untilStopped } from "./serve.js";
import { keptTerms } from "./terms.js";
import { exhaustionOver, openView, requireVenue } from "./venue.js";

/** How long a replica proves new covers after each round (`serve --prove`) before it syncs again: about ten leaves on
 * four cores with the WebAssembly backend (slice 36), twenty natively (slice 42). */
const PROVE_ROUND_MS = 600_000;
/** After consecutive proving failures a replica waits before proving again, doubling from a minute to at most an hour, so
 * a failure that recurs (a backend that will not start, a span it will not prove) costs no round's work each time. */
const PROVE_RETRY_MS = 60_000, PROVE_RETRY_MAX_MS = 3_600_000;


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
 * With `--prove [--parameters <dir>] [--prover native|wasm]` (slices 38, 42) it also proves check proofs over its kept
 * pool-v3 trails after each round (`V3Replica.prove`), for at most PROVE_ROUND_MS of new covers, and serves them by set
 * and digest (`GET /covers`): any party may prove (succinct-read §2 rule 6), and the replica checks each statement proof
 * first. A line says what a round proved and on which backend. A succinct directory serves no replica (`SUCCINCT`):
 * a replica's evidence is judged by every reader that takes it, so it reads completely (succinct-read §1).
 */
async function serve(argv: readonly string[]): Promise<void> {
  const args = parseArguments(argv, { dir: "value", verifiers: "value", prove: "switch", parameters: "value", prover: "value",
    "prove-exhaustion": "switch", nargo: "value", ...SERVE_FLAGS }, 0);
  const exhausting = has(args, "prove-exhaustion");
  if (has(args, "parameters") && !has(args, "prove") && !exhausting) {
    throw new UsageError("--parameters names where --prove and --prove-exhaustion copy their parameters from");
  }
  if (has(args, "nargo") && !exhausting) throw new UsageError("--nargo names the compiler --prove-exhaustion compiles the exhaustion circuits with");
  if (has(args, "prover") && !has(args, "prove")) throw new UsageError("--prover names the backend --prove proves on");
  const native = has(args, "prove") && proverBackend(args);
  const directory = openDirectory(required(args, "dir"), "reader");
  if (directory.succinct) throw new CommandError("SUCCINCT", "a replica reads completely (succinct-read §1): serve from a reader directory made without --read succinct");
  if (has(args, "prove") && !directory.construction.reader.proofs) throw new UsageError(`a ${nameOf(directory.construction)} replica holds no proofs to cover`);
  const venue = requireVenue(directory);
  const { port, onion, ms } = serveFlags(args);
  const view = openView(directory);
  let evidence: EvidenceStore | undefined, verifier: Awaited<ReturnType<typeof directoryVerifier>> | undefined;
  let covers: Awaited<ReturnType<typeof openCoverProver>> | undefined, periods: ExhaustionProver | undefined;
  const log = (line: string) => process.stderr.write(`${line}\n`);
  try {
    verifier = await directoryVerifier(directory, args);
    evidence = openEvidence(directory, true);
    if (has(args, "prove")) covers = await openCoverProver(directory, verifier!, flag(args, "parameters"), native, log);
    if (exhausting) periods = await openExhaustionProver(directory, flag(args, "parameters"), flag(args, "nargo") ?? "nargo", log);
  } catch (error) { await periods?.close(); await covers?.close(); await verifier?.close(); evidence?.close(); view.close(); throw error; }
  const replica = new V3Replica(directory.file("evidence.db"), evidence, view.venue.id);
  // The venue's exhaustion under the directory's set, kept over the view's own rows (succinct-read §4.7, slice 43).
  let exhaustion: ReturnType<typeof exhaustionOver>;
  try { exhaustion = exhaustionOver(directory, view, periods); } catch (error) {
    await periods?.close(); await covers?.close(); await verifier?.close(); evidence.close(); view.close(); throw error;
  }
  const server = createV3EvidenceService(replica, exhaustion.source);
  // A stream its file could not finish (storage damage) ended short; the replica's owner is told.
  server.on("evidenceError", (error: unknown) => { event({ event: "evidence", code: "STORAGE", message: (error as Error).message }); });
  let listened: number;
  try { listened = await listenLoopback(server, port); } catch (error) {
    await exhaustion.close(); await covers?.close(); await verifier?.close(); evidence.close(); view.close(); throw error;
  }
  const local = `http://127.0.0.1:${listened}/`, url = onion === undefined ? local : `http://${onion}/`;
  writeReplace(directory.file("replica.json"), `${JSON.stringify({ url }, null, 2)}\n`);
  const { stopping, pause: rest } = untilStopped();
  print({ status: "serving", url, port: listened, prover: covers?.prover.backend ?? null, exhaustion: { set: hex(exhaustion.source.set), proving: exhausting }, backings: keptBackings(directory).map(hex),
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
  /** A round's proving: the walk of the kept trails goes on from where the last round's stood, proving new covers (held
   * ones are not proved again), until PROVE_ROUND_MS has passed or the replica stops. */
  let failures = 0, retryAt = 0;
  const prove = async (): Promise<void> => {
    // One proof at a time: covers wait while a period proves (each fills most of a 16-GB machine's memory).
    if (covers === undefined || stopping() || Date.now() < retryAt || exhaustion.busy) return;
    const { prover } = covers, until = Date.now() + PROVE_ROUND_MS;
    try {
      const walked = await replica.prove(prover, { stop: () => Date.now() >= until || stopping() });
      failures = 0;
      if (walked.made > 0) print({ status: "proved", set: prover.identity, testSet: prover.set.test, backend: prover.backend, ...walked });
    } catch (error) {
      // The prover retired the instance that failed and starts a fresh one for the next proof (slice 42), after a wait.
      failures++;
      const wait = Math.min(PROVE_RETRY_MS * 2 ** Math.min(failures - 1, 6), PROVE_RETRY_MAX_MS);
      retryAt = Date.now() + wait;
      event({ event: "prove", code: "PROVER", message: (error as Error).message, failures, retryMs: wait });
    }
  };
  /** The exhaustion's turn, after the covers' (so a period ending during a rest never keeps them waiting): its kept
   * fold taken, or a period started over the indices the view newly read, proving in the background while rounds go
   * on. A line names each fold served. */
  const exhaust = () => exhaustion.advance((fold, how) => print({ status: "exhaustion", set: hex(exhaustion.source.set),
    foldIndex: fold.inputs.endHeight - venue.anchorHeight - 1n, how }));
  try {
    while (!stopping()) {
      await round();
      await prove();
      if (!stopping()) await exhaust();
      await rest(ms);
    }
  } finally {
    await closeListener(server);
    await exhaustion.close(); await covers?.close(); await verifier?.close(); evidence.close(); view.close();
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
